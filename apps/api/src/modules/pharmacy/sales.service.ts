import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { computeSaleTotals, type RecordSale, type ReturnSale, type SaleRow } from '@emr/contracts';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { StockService } from './stock.service';

/**
 * The medicine counter's till.
 *
 * SEPARATE FROM `invoice`, which bills consultations and services. Two unrelated
 * reasons keep them apart: the tax treatment differs — goods with an HSN code and
 * a GST slab, against a service — and the clinical record must not depend on
 * whether the patient paid. A dispense is a fact about medicine handed over; a
 * sale is a fact about money. Fusing them would mean an unpaid prescription looks
 * undispensed.
 *
 * A RETURN IS ITS OWN SALE with negative lines, referencing the original. Never a
 * mutation, never a deletion. Same reasoning as a refund in `payment`: the
 * original transaction happened, and a system that can make it disappear cannot
 * be reconciled against a cash drawer.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly stock: StockService,
  ) {}

  async sales(options: { patientId?: string; dispenseRecordId?: string } = {}): Promise<SaleRow[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          sale: schema.pharmacySale,
          patientName: schema.patient.fullName,
          soldByName: schema.appUser.fullName,
          lineCount: sql<number>`(
            SELECT count(*)::int FROM ${schema.pharmacySaleLine}
            WHERE ${schema.pharmacySaleLine.pharmacySaleId} = ${schema.pharmacySale.id}
          )`,
        })
        .from(schema.pharmacySale)
        .leftJoin(schema.patient, eq(schema.patient.id, schema.pharmacySale.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.pharmacySale.soldBy))
        .where(
          and(
            options.patientId ? eq(schema.pharmacySale.patientId, options.patientId) : undefined,
            options.dispenseRecordId
              ? eq(schema.pharmacySale.dispenseRecordId, options.dispenseRecordId)
              : undefined,
          ),
        )
        .orderBy(desc(schema.pharmacySale.createdAt))
        .limit(200),
    );

    return rows.map((row) => ({
      id: row.sale.id,
      saleNumber: row.sale.saleNumber,
      status: row.sale.status,
      patientId: row.sale.patientId,
      patientName: row.patientName,
      buyerName: row.sale.buyerName,
      dispenseRecordId: row.sale.dispenseRecordId,
      subtotalPaise: row.sale.subtotalPaise,
      discountPaise: row.sale.discountPaise,
      taxPaise: row.sale.taxPaise,
      totalPaise: row.sale.totalPaise,
      paidPaise: row.sale.paidPaise,
      paymentMethod: row.sale.paymentMethod,
      soldAt: row.sale.soldAt?.toISOString() ?? null,
      soldByName: row.soldByName,
      isReturn: row.sale.isReturn,
      returnOfSaleId: row.sale.returnOfSaleId,
      returnReason: row.sale.returnReason,
      lineCount: row.lineCount,
    }));
  }

  /**
   * Rings up a sale and takes the stock off the shelf.
   *
   * One transaction: a sale recorded without the stock movement is money taken
   * for medicine the system still thinks is in the cupboard.
   */
  async record(input: RecordSale) {
    const ctx = TenantContext.require();

    const totals = computeSaleTotals(input.lines, input.discountPaise);

    if (input.paidPaise > totals.totalPaise) {
      throw new UnprocessableEntityException({
        title: 'That is more than the total',
        message: `The sale comes to ₹${(totals.totalPaise / 100).toFixed(2)}. Record the amount actually taken.`,
      });
    }

    return this.tenantDb.run(async (tx) => {
      await this.assertSellable(tx, input.lines.map((l) => l.productId), Boolean(input.dispenseRecordId));

      /*
       * Already sold is not an error, and must not be sold again.
       *
       * A SALE TAKES MONEY AND REMOVES STOCK. A duplicate charges the customer
       * twice and understates the shelf, and reconciling it afterwards means
       * deciding which of two identical rows never happened — which nobody can.
       * The totals are recomputed rather than stored on the row, so the original
       * is returned in the same shape a fresh sale would be.
       */
      const [already] = await tx
        .select({
          id: schema.pharmacySale.id,
          saleNumber: schema.pharmacySale.saleNumber,
        })
        .from(schema.pharmacySale)
        .where(eq(schema.pharmacySale.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (already) {
        return { id: already.id, saleNumber: already.saleNumber, ...totals };
      }

      const saleNumber = await nextSaleNumber(tx);

      const [sale] = await tx
        .insert(schema.pharmacySale)
        .values({
          clinicId: ctx.clinicId,
          saleNumber,
          status: 'COMPLETED',
          patientId: input.patientId ?? null,
          dispenseRecordId: input.dispenseRecordId ?? null,
          buyerName: input.buyerName ?? null,
          subtotalPaise: totals.subtotalPaise,
          discountPaise: input.discountPaise,
          discountReason: input.discountReason ?? null,
          taxPaise: totals.taxPaise,
          totalPaise: totals.totalPaise,
          paidPaise: input.paidPaise,
          paymentMethod: input.paymentMethod,
          idempotencyKey: input.idempotencyKey,
          soldBy: ctx.userId,
          soldAt: new Date(),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning({ id: schema.pharmacySale.id });

      for (const line of input.lines) {
        const gross = line.quantity * line.unitPricePaise;
        const net = gross - (line.discountPaise ?? 0);

        await tx.insert(schema.pharmacySaleLine).values({
          clinicId: ctx.clinicId,
          pharmacySaleId: sale!.id,
          productId: line.productId,
          stockBatchId: line.stockBatchId,
          quantity: line.quantity,
          unitPricePaise: line.unitPricePaise,
          gstRateBps: line.gstRateBps,
          discountPaise: line.discountPaise ?? 0,
          lineTotalPaise: net + Math.round((net * line.gstRateBps) / 10_000),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        });

        /*
         * A sale against a dispense does NOT move stock again.
         *
         * The dispense already took it off the shelf. Charging for it is a
         * separate fact about money, and moving the stock twice would halve the
         * inventory every time someone paid.
         */
        if (!input.dispenseRecordId) {
          await this.stock.move(tx, {
            stockBatchId: line.stockBatchId,
            movementType: 'SALE',
            quantityDelta: -line.quantity,
            referenceType: 'SALE',
            referenceId: sale!.id,
          });
        }
      }

      return { id: sale!.id, saleNumber, ...totals };
    });
  }

  /**
   * One sale, with its lines and what is still returnable on each.
   *
   * WHY THIS EXISTS. `POST /pharmacy/sales/:id/return` has been implemented and
   * audited since the module shipped, and nothing could call it, because a return
   * needs `stockBatchId` per line and no read endpoint returned one. The list
   * gives totals and a line COUNT; the lines themselves were not reachable.
   *
   * The batch is not a detail that a screen could reasonably guess. `recordReturn`
   * puts the stock back on the batch the line names, and the service says why:
   * returning it to an arbitrary batch corrupts the expiry tracking the whole
   * module exists for. A packet sold from a batch expiring next month must go
   * back on THAT batch, or the clinic will later dispense expired medicine
   * believing it has eleven months left.
   *
   * `returnableQuantity` is computed here rather than in the browser because it
   * is the same arithmetic `recordReturn` enforces — sold, net of returns already
   * recorded. Two places computing it from different data is how a screen starts
   * offering a quantity the server then refuses.
   */
  async saleDetail(id: string) {
    return this.tenantDb.runReadOnly(async (tx) => {
      const [row] = await tx
        .select({
          sale: schema.pharmacySale,
          patientName: schema.patient.fullName,
          soldByName: schema.appUser.fullName,
        })
        .from(schema.pharmacySale)
        .leftJoin(schema.patient, eq(schema.patient.id, schema.pharmacySale.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.pharmacySale.soldBy))
        .where(eq(schema.pharmacySale.id, id))
        .limit(1);

      if (!row) throw new NotFoundException('That sale could not be found.');

      const lines = await tx
        .select({
          line: schema.pharmacySaleLine,
          productName: schema.pharmacyProduct.name,
          packUnit: schema.pharmacyProduct.packUnit,
          batchNumber: schema.stockBatch.batchNumber,
          expiryDate: schema.stockBatch.expiryDate,
        })
        .from(schema.pharmacySaleLine)
        .leftJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.pharmacySaleLine.productId),
        )
        .leftJoin(
          schema.stockBatch,
          eq(schema.stockBatch.id, schema.pharmacySaleLine.stockBatchId),
        )
        .where(eq(schema.pharmacySaleLine.pharmacySaleId, id));

      /*
       * Already returned, per BATCH rather than per product.
       *
       * `recordReturn` checks the cap per product, which is the right check for
       * "you cannot return more than was sold". But the quantity a screen offers
       * has to be per batch, because the batch is what the return line must
       * name. A sale of ten from two batches needs both rows offered separately.
       */
      const returnedRows = await tx
        .select({
          stockBatchId: schema.pharmacySaleLine.stockBatchId,
          quantity: sql<number>`coalesce(sum(${schema.pharmacySaleLine.quantity}), 0)::int`,
        })
        .from(schema.pharmacySaleLine)
        .innerJoin(
          schema.pharmacySale,
          eq(schema.pharmacySale.id, schema.pharmacySaleLine.pharmacySaleId),
        )
        .where(eq(schema.pharmacySale.returnOfSaleId, id))
        .groupBy(schema.pharmacySaleLine.stockBatchId);

      // Return lines are stored negative, so the sums come back negative.
      const returnedBy = new Map(
        returnedRows.map((r) => [r.stockBatchId, Math.abs(r.quantity)]),
      );

      return {
        id: row.sale.id,
        saleNumber: row.sale.saleNumber,
        status: row.sale.status,
        patientId: row.sale.patientId,
        patientName: row.patientName,
        buyerName: row.sale.buyerName,
        totalPaise: row.sale.totalPaise,
        paidPaise: row.sale.paidPaise,
        paymentMethod: row.sale.paymentMethod,
        soldAt: row.sale.soldAt?.toISOString() ?? null,
        soldByName: row.soldByName,
        isReturn: row.sale.isReturn,
        returnOfSaleId: row.sale.returnOfSaleId,
        returnReason: row.sale.returnReason,
        lines: lines.map(({ line, productName, packUnit, batchNumber, expiryDate }) => {
          const sold = line.quantity;
          const alreadyReturned = returnedBy.get(line.stockBatchId) ?? 0;
          return {
            id: line.id,
            productId: line.productId,
            productName,
            packUnit,
            stockBatchId: line.stockBatchId,
            batchNumber,
            expiryDate,
            quantity: sold,
            unitPricePaise: line.unitPricePaise,
            gstRateBps: line.gstRateBps,
            lineTotalPaise: line.lineTotalPaise,
            alreadyReturned,
            /*
             * Zero on a return document's own lines: `sold` is negative there,
             * and the clamp keeps it from reading as a returnable quantity.
             * `recordReturn` refuses to return against a return anyway, but a
             * screen should not offer it in the first place.
             */
            returnableQuantity: Math.max(0, sold - alreadyReturned),
          };
        }),
      };
    });
  }

  /**
   * Takes goods back.
   *
   * Stock returns to the batch it came from, which is why the return lines carry
   * a batch id: putting it back on an arbitrary batch would corrupt the expiry
   * tracking that the whole module exists for.
   */
  async recordReturn(originalSaleId: string, input: ReturnSale) {
    const ctx = TenantContext.require();

    const totals = computeSaleTotals(
      input.lines.map((l) => ({
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        gstRateBps: l.gstRateBps,
      })),
    );

    return this.tenantDb.run(async (tx) => {
      const [original] = await tx
        .select()
        .from(schema.pharmacySale)
        .where(eq(schema.pharmacySale.id, originalSaleId))
        .limit(1);

      if (!original) throw new NotFoundException('That sale could not be found.');
      if (original.isReturn) {
        throw new ConflictException('That is already a return. Return against the original sale.');
      }

      /*
       * You cannot return more than was sold.
       *
       * Checked per product against the original lines net of returns already
       * recorded, so two partial returns cannot together exceed the sale.
       */
      const sold = await tx
        .select({
          productId: schema.pharmacySaleLine.productId,
          quantity: sql<number>`sum(${schema.pharmacySaleLine.quantity})::int`,
        })
        .from(schema.pharmacySaleLine)
        .where(eq(schema.pharmacySaleLine.pharmacySaleId, originalSaleId))
        .groupBy(schema.pharmacySaleLine.productId);

      const returned = await tx
        .select({
          productId: schema.pharmacySaleLine.productId,
          quantity: sql<number>`coalesce(sum(${schema.pharmacySaleLine.quantity}), 0)::int`,
        })
        .from(schema.pharmacySaleLine)
        .innerJoin(
          schema.pharmacySale,
          eq(schema.pharmacySale.id, schema.pharmacySaleLine.pharmacySaleId),
        )
        .where(eq(schema.pharmacySale.returnOfSaleId, originalSaleId))
        .groupBy(schema.pharmacySaleLine.productId);

      const soldBy = new Map(sold.map((r) => [r.productId, r.quantity]));
      // Return lines are stored negative, so already-returned totals are negative.
      const returnedBy = new Map(returned.map((r) => [r.productId, Math.abs(r.quantity)]));

      for (const line of input.lines) {
        const available = (soldBy.get(line.productId) ?? 0) - (returnedBy.get(line.productId) ?? 0);
        if (line.quantity > available) {
          throw new UnprocessableEntityException({
            title: 'More than was sold',
            message: `Only ${available} of that item can still be returned against this sale.`,
          });
        }
      }

      const saleNumber = await nextSaleNumber(tx);

      const [refund] = await tx
        .insert(schema.pharmacySale)
        .values({
          clinicId: ctx.clinicId,
          saleNumber,
          status: 'COMPLETED',
          patientId: original.patientId,
          buyerName: original.buyerName,
          // Negative totals: the document reads as money going out.
          subtotalPaise: -totals.subtotalPaise,
          taxPaise: -totals.taxPaise,
          totalPaise: -totals.totalPaise,
          paidPaise: -totals.totalPaise,
          paymentMethod: original.paymentMethod,
          isReturn: true,
          returnOfSaleId: originalSaleId,
          returnReason: input.returnReason,
          soldBy: ctx.userId,
          soldAt: new Date(),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning({ id: schema.pharmacySale.id });

      for (const line of input.lines) {
        const gross = line.quantity * line.unitPricePaise;

        await tx.insert(schema.pharmacySaleLine).values({
          clinicId: ctx.clinicId,
          pharmacySaleId: refund!.id,
          productId: line.productId,
          stockBatchId: line.stockBatchId,
          quantity: -line.quantity,
          unitPricePaise: line.unitPricePaise,
          gstRateBps: line.gstRateBps,
          lineTotalPaise: -(gross + Math.round((gross * line.gstRateBps) / 10_000)),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        });

        await this.stock.move(tx, {
          stockBatchId: line.stockBatchId,
          movementType: 'SALE_RETURN',
          quantityDelta: line.quantity,
          reason: input.returnReason,
          referenceType: 'SALE_RETURN',
          referenceId: refund!.id,
        });
      }

      return { id: refund!.id, saleNumber, refundedPaise: totals.totalPaise };
    });
  }

  /**
   * Prices a completed dispense, so the counter can charge for it in one step.
   *
   * Reads what was actually dispensed rather than what was prescribed — a partial
   * fill is charged as a partial fill.
   */
  async quoteForDispense(dispenseRecordId: string) {
    return this.tenantDb.runReadOnly(async (tx) => {
      const lines = await tx
        .select({
          productId: schema.dispenseLine.productId,
          stockBatchId: schema.dispenseLine.stockBatchId,
          productName: schema.pharmacyProduct.name,
          batchNumber: schema.stockBatch.batchNumber,
          quantity: schema.dispenseLine.quantityDispensed,
          unitPricePaise: schema.dispenseLine.unitPricePaise,
          gstRateBps: schema.dispenseLine.gstRateBps,
        })
        .from(schema.dispenseLine)
        .innerJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.dispenseLine.productId),
        )
        .innerJoin(schema.stockBatch, eq(schema.stockBatch.id, schema.dispenseLine.stockBatchId))
        .where(
          and(
            eq(schema.dispenseLine.dispenseRecordId, dispenseRecordId),
            sql`${schema.dispenseLine.quantityDispensed} > 0`,
          ),
        );

      const totals = computeSaleTotals(
        lines.map((l) => ({
          quantity: l.quantity,
          unitPricePaise: l.unitPricePaise,
          gstRateBps: l.gstRateBps,
        })),
      );

      return {
        lines: lines.map((l) => ({
          productId: l.productId!,
          productName: l.productName,
          stockBatchId: l.stockBatchId!,
          batchNumber: l.batchNumber,
          quantity: l.quantity,
          unitPricePaise: l.unitPricePaise,
          gstRateBps: l.gstRateBps,
          discountPaise: 0,
        })),
        ...totals,
      };
    });
  }

  /**
   * Refuses to sell a prescription-only medicine over the counter.
   *
   * The Drugs and Cosmetics Rules are not advisory and the software should not
   * make breaking them the path of least resistance. A sale linked to a dispense
   * record HAS a prescription behind it, which is the exception.
   */
  private async assertSellable(tx: TenantTx, productIds: string[], hasPrescription: boolean) {
    if (hasPrescription) return;

    const restricted = await tx
      .select({ name: schema.pharmacyProduct.name, schedule: schema.pharmacyProduct.drugSchedule })
      .from(schema.pharmacyProduct)
      .where(
        and(
          inArray(schema.pharmacyProduct.id, productIds),
          eq(schema.pharmacyProduct.requiresPrescription, true),
        ),
      );

    if (restricted.length > 0) {
      const names = restricted
        .map((r) => (r.schedule ? `${r.name} (Schedule ${r.schedule})` : r.name))
        .join(', ');
      throw new UnprocessableEntityException({
        title: 'That needs a prescription',
        message: `${names} cannot be sold over the counter. Dispense it against a prescription instead.`,
      });
    }
  }
}

/** Sequential per clinic per year, e.g. PS-2026-0184. */
async function nextSaleNumber(tx: TenantTx): Promise<string> {
  const year = new Date().getFullYear();
  const result = await tx.execute<{ next: string }>(
    sql`SELECT count(*) + 1 AS next FROM pharmacy_sale WHERE sale_number LIKE ${`PS-${year}-%`}`,
  );
  const next = Number(result.rows[0]?.next ?? 1);
  return `PS-${year}-${String(next).padStart(4, '0')}`;
}
