import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import {
  computeSaleTotals,
  type GoodsReceiptRow,
  type PurchaseOrder,
  type ReceiveGoods,
  type SavePurchaseOrder,
} from '@emr/contracts';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { StockService } from './stock.service';

/**
 * Purchasing: order, approve, receive.
 *
 * RAISING AN ORDER AND AUTHORISING THE SPEND ARE SEPARATE. `purchaseOrder:create`
 * and `purchaseOrder:approve` are different permissions, and the pharmacist role
 * holds the first and not the second by default. A clinic that wants one person
 * to do both grants the second permission; the software should not decide that
 * for them, and it should not make the split impossible either.
 *
 * RECEIVING IS THE ONLY THING THAT CREATES STOCK. A goods receipt is a separate
 * document from the order because the two genuinely differ: a receipt can arrive
 * against no order (a local purchase), can cover part of one, and carries the
 * batch number and expiry date that the order never had — which are the whole
 * reason pharmacy stock is tracked per batch.
 */
@Injectable()
export class PurchasingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly stock: StockService,
  ) {}

  /* ---- Orders ------------------------------------------------------------- */

  async orders(options: { status?: string; supplierId?: string } = {}) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          order: schema.purchaseOrder,
          supplierName: schema.supplier.name,
          placedByName: sql<string | null>`placer.full_name`,
          approvedByName: sql<string | null>`approver.full_name`,
          lineCount: sql<number>`(
            SELECT count(*)::int FROM ${schema.purchaseOrderLine}
            WHERE ${schema.purchaseOrderLine.purchaseOrderId} = ${schema.purchaseOrder.id}
          )`,
        })
        .from(schema.purchaseOrder)
        .innerJoin(schema.supplier, eq(schema.supplier.id, schema.purchaseOrder.supplierId))
        .leftJoin(
          sql`${schema.appUser} AS placer`,
          sql`placer.id = ${schema.purchaseOrder.placedBy}`,
        )
        .leftJoin(
          sql`${schema.appUser} AS approver`,
          sql`approver.id = ${schema.purchaseOrder.approvedBy}`,
        )
        .where(
          and(
            options.status
              ? eq(schema.purchaseOrder.status, options.status as 'DRAFT')
              : undefined,
            options.supplierId
              ? eq(schema.purchaseOrder.supplierId, options.supplierId)
              : undefined,
          ),
        )
        .orderBy(desc(schema.purchaseOrder.createdAt))
        .limit(200),
    );

    return rows.map((row) => ({
      id: row.order.id,
      supplierId: row.order.supplierId,
      supplierName: row.supplierName,
      orderNumber: row.order.orderNumber,
      status: row.order.status,
      expectedAt: row.order.expectedAt,
      placedAt: row.order.placedAt?.toISOString() ?? null,
      placedByName: row.placedByName,
      approvedAt: row.order.approvedAt?.toISOString() ?? null,
      approvedByName: row.approvedByName,
      subtotalPaise: row.order.subtotalPaise,
      taxPaise: row.order.taxPaise,
      totalPaise: row.order.totalPaise,
      notes: row.order.notes,
      cancelledReason: row.order.cancelledReason,
      lines: [],
      lineCount: row.lineCount,
      createdAt: row.order.createdAt.toISOString(),
    }));
  }

  async order(id: string): Promise<PurchaseOrder> {
    const found = await this.tenantDb.runReadOnly(async (tx) => {
      const [head] = await tx
        .select({
          order: schema.purchaseOrder,
          supplierName: schema.supplier.name,
          placedByName: sql<string | null>`placer.full_name`,
          approvedByName: sql<string | null>`approver.full_name`,
        })
        .from(schema.purchaseOrder)
        .innerJoin(schema.supplier, eq(schema.supplier.id, schema.purchaseOrder.supplierId))
        .leftJoin(
          sql`${schema.appUser} AS placer`,
          sql`placer.id = ${schema.purchaseOrder.placedBy}`,
        )
        .leftJoin(
          sql`${schema.appUser} AS approver`,
          sql`approver.id = ${schema.purchaseOrder.approvedBy}`,
        )
        .where(eq(schema.purchaseOrder.id, id))
        .limit(1);

      if (!head) return null;

      const lines = await tx
        .select({ line: schema.purchaseOrderLine, productName: schema.pharmacyProduct.name })
        .from(schema.purchaseOrderLine)
        .innerJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.purchaseOrderLine.productId),
        )
        .where(eq(schema.purchaseOrderLine.purchaseOrderId, id));

      return { head, lines };
    });

    if (!found) throw new NotFoundException('That purchase order could not be found.');

    return {
      id: found.head.order.id,
      supplierId: found.head.order.supplierId,
      supplierName: found.head.supplierName,
      orderNumber: found.head.order.orderNumber,
      status: found.head.order.status,
      expectedAt: found.head.order.expectedAt,
      placedAt: found.head.order.placedAt?.toISOString() ?? null,
      placedByName: found.head.placedByName,
      approvedAt: found.head.order.approvedAt?.toISOString() ?? null,
      approvedByName: found.head.approvedByName,
      subtotalPaise: found.head.order.subtotalPaise,
      taxPaise: found.head.order.taxPaise,
      totalPaise: found.head.order.totalPaise,
      notes: found.head.order.notes,
      cancelledReason: found.head.order.cancelledReason,
      createdAt: found.head.order.createdAt.toISOString(),
      lines: found.lines.map(({ line, productName }) => ({
        id: line.id,
        productId: line.productId,
        productName,
        quantityOrdered: line.quantityOrdered,
        quantityReceived: line.quantityReceived,
        unitCostPaise: line.unitCostPaise,
        gstRateBps: line.gstRateBps,
        lineTotalPaise: line.lineTotalPaise,
      })),
    };
  }

  async createOrder(input: SavePurchaseOrder): Promise<PurchaseOrder> {
    const ctx = TenantContext.require();

    /*
     * Totals are computed server-side from the lines, never taken from the
     * client. The same function the sale screen uses, so a purchase order and an
     * invoice cannot disagree about how tax on a mixed basket works.
     */
    const totals = computeSaleTotals(
      input.lines.map((l) => ({
        quantity: l.quantityOrdered,
        unitPricePaise: l.unitCostPaise,
        gstRateBps: l.gstRateBps,
      })),
    );

    const id = await this.tenantDb.run(async (tx) => {
      const [supplier] = await tx
        .select({ id: schema.supplier.id, isActive: schema.supplier.isActive })
        .from(schema.supplier)
        .where(eq(schema.supplier.id, input.supplierId))
        .limit(1);

      if (!supplier) throw new NotFoundException('That supplier could not be found.');
      if (!supplier.isActive) {
        throw new ConflictException(
          'That supplier is no longer active. Reactivate it before ordering.',
        );
      }

      const orderNumber = await nextNumber(tx, 'PO', schema.purchaseOrder.orderNumber, 'purchase_order');

      const [order] = await tx
        .insert(schema.purchaseOrder)
        .values({
          clinicId: ctx.clinicId,
          supplierId: input.supplierId,
          orderNumber,
          status: 'DRAFT',
          expectedAt: input.expectedAt ?? null,
          notes: input.notes ?? null,
          subtotalPaise: totals.subtotalPaise,
          taxPaise: totals.taxPaise,
          totalPaise: totals.totalPaise,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning({ id: schema.purchaseOrder.id });

      await tx.insert(schema.purchaseOrderLine).values(
        input.lines.map((line) => ({
          clinicId: ctx.clinicId,
          purchaseOrderId: order!.id,
          productId: line.productId,
          quantityOrdered: line.quantityOrdered,
          quantityReceived: 0,
          unitCostPaise: line.unitCostPaise,
          gstRateBps: line.gstRateBps,
          lineTotalPaise:
            line.quantityOrdered * line.unitCostPaise +
            Math.round((line.quantityOrdered * line.unitCostPaise * line.gstRateBps) / 10_000),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })),
      );

      return order!.id;
    });

    return this.order(id);
  }

  /**
   * Approves an order and places it.
   *
   * One action rather than two, because approval with no placement leaves an
   * order that is authorised and not ordered — a state that means nothing to
   * anyone and that someone has to remember to advance.
   */
  async approveOrder(id: string) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [order] = await tx
        .select()
        .from(schema.purchaseOrder)
        .where(eq(schema.purchaseOrder.id, id))
        .limit(1);

      if (!order) throw new NotFoundException('That purchase order could not be found.');
      if (order.status === 'CANCELLED') {
        throw new ConflictException('That order was cancelled.');
      }
      if (order.status !== 'DRAFT' && order.status !== 'AWAITING_APPROVAL') {
        throw new ConflictException('That order has already been placed.');
      }

      await tx
        .update(schema.purchaseOrder)
        .set({
          status: 'PLACED',
          approvedAt: new Date(),
          approvedBy: ctx.userId,
          placedAt: new Date(),
          placedBy: order.placedBy ?? ctx.userId,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.purchaseOrder.id, id));

      return { placed: true };
    });
  }

  /** Marks a draft as needing someone else's approval. */
  async submitOrder(id: string) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [order] = await tx
        .select({ status: schema.purchaseOrder.status })
        .from(schema.purchaseOrder)
        .where(eq(schema.purchaseOrder.id, id))
        .limit(1);

      if (!order) throw new NotFoundException('That purchase order could not be found.');
      if (order.status !== 'DRAFT') {
        throw new ConflictException('Only a draft can be submitted for approval.');
      }

      await tx
        .update(schema.purchaseOrder)
        .set({
          status: 'AWAITING_APPROVAL',
          placedBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.purchaseOrder.id, id));

      return { submitted: true };
    });
  }

  async cancelOrder(id: string, reason: string) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [order] = await tx
        .select({ status: schema.purchaseOrder.status })
        .from(schema.purchaseOrder)
        .where(eq(schema.purchaseOrder.id, id))
        .limit(1);

      if (!order) throw new NotFoundException('That purchase order could not be found.');
      if (order.status === 'RECEIVED') {
        throw new ConflictException(
          'That order has been received in full. Record a purchase return instead.',
        );
      }

      await tx
        .update(schema.purchaseOrder)
        .set({ status: 'CANCELLED', cancelledReason: reason, updatedBy: ctx.userId })
        .where(eq(schema.purchaseOrder.id, id));

      return { cancelled: true };
    });
  }

  /* ---- Receiving ---------------------------------------------------------- */

  /**
   * Receives goods. THE ONLY PATH THAT CREATES STOCK.
   *
   * One transaction covering the receipt, its lines, every batch it lands in,
   * every ledger movement and the order's outstanding quantities. A partial
   * failure here would leave stock on the shelf that the ledger does not know
   * about, which is the one outcome an inventory system must never produce.
   */
  async receive(input: ReceiveGoods) {
    const ctx = TenantContext.require();

    const totals = computeSaleTotals(
      input.lines.map((l) => ({
        quantity: l.quantity,
        unitPricePaise: l.unitCostPaise,
        gstRateBps: l.gstRateBps,
      })),
    );

    return this.tenantDb.run(async (tx) => {
      const [supplier] = await tx
        .select({ id: schema.supplier.id })
        .from(schema.supplier)
        .where(eq(schema.supplier.id, input.supplierId))
        .limit(1);
      if (!supplier) throw new NotFoundException('That supplier could not be found.');

      /*
       * An expiry already past is refused at entry, not discovered at dispense.
       *
       * Checked in one statement against the database's own `current_date`, so a
       * counter machine with a wrong clock cannot take expired stock into
       * inventory by disagreeing about what day it is.
       */
      const [past] = await tx
        .execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM (VALUES ${sql.join(
            input.lines.map((l) => sql`(${l.expiryDate}::date)`),
            sql`, `,
          )}) AS v(d) WHERE v.d < current_date`,
        )
        .then((r) => r.rows);

      if ((past?.n ?? 0) > 0) {
        throw new ConflictException(
          'One of those batches has already expired. Do not take expired stock into inventory — return it to the supplier.',
        );
      }

      const receiptNumber = await nextNumber(
        tx,
        'GRN',
        schema.goodsReceipt.receiptNumber,
        'goods_receipt',
      );

      const [receipt] = await tx
        .insert(schema.goodsReceipt)
        .values({
          clinicId: ctx.clinicId,
          purchaseOrderId: input.purchaseOrderId ?? null,
          supplierId: input.supplierId,
          receiptNumber,
          supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
          supplierInvoiceDate: input.supplierInvoiceDate ?? null,
          receivedAt: new Date(),
          receivedBy: ctx.userId,
          subtotalPaise: totals.subtotalPaise,
          taxPaise: totals.taxPaise,
          totalPaise: totals.totalPaise,
          notes: input.notes ?? null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning({ id: schema.goodsReceipt.id });

      for (const line of input.lines) {
        const batchId = await this.stock.ensureBatch(tx, {
          productId: line.productId,
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          unitCostPaise: line.unitCostPaise,
          mrpPaise: line.mrpPaise ?? null,
          supplierId: input.supplierId,
        });

        await tx.insert(schema.goodsReceiptLine).values({
          clinicId: ctx.clinicId,
          goodsReceiptId: receipt!.id,
          productId: line.productId,
          batchNumber: line.batchNumber.trim(),
          expiryDate: line.expiryDate,
          quantity: line.quantity,
          unitCostPaise: line.unitCostPaise,
          mrpPaise: line.mrpPaise ?? null,
          gstRateBps: line.gstRateBps,
          lineTotalPaise:
            line.quantity * line.unitCostPaise +
            Math.round((line.quantity * line.unitCostPaise * line.gstRateBps) / 10_000),
          stockBatchId: batchId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        });

        await this.stock.move(tx, {
          stockBatchId: batchId,
          movementType: 'RECEIPT',
          quantityDelta: line.quantity,
          referenceType: 'GOODS_RECEIPT',
          referenceId: receipt!.id,
        });

        /* Advance the order's outstanding quantity, if there is an order. */
        if (input.purchaseOrderId) {
          await tx
            .update(schema.purchaseOrderLine)
            .set({
              quantityReceived: sql`${schema.purchaseOrderLine.quantityReceived} + ${line.quantity}`,
              updatedBy: ctx.userId,
            })
            .where(
              and(
                eq(schema.purchaseOrderLine.purchaseOrderId, input.purchaseOrderId),
                eq(schema.purchaseOrderLine.productId, line.productId),
              ),
            );
        }
      }

      if (input.purchaseOrderId) {
        await this.settleOrderStatus(tx, input.purchaseOrderId);
      }

      return { id: receipt!.id, receiptNumber };
    });
  }

  async receipts(options: { purchaseOrderId?: string } = {}): Promise<GoodsReceiptRow[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          receipt: schema.goodsReceipt,
          supplierName: schema.supplier.name,
          orderNumber: schema.purchaseOrder.orderNumber,
          receivedByName: schema.appUser.fullName,
          lineCount: sql<number>`(
            SELECT count(*)::int FROM ${schema.goodsReceiptLine}
            WHERE ${schema.goodsReceiptLine.goodsReceiptId} = ${schema.goodsReceipt.id}
          )`,
        })
        .from(schema.goodsReceipt)
        .innerJoin(schema.supplier, eq(schema.supplier.id, schema.goodsReceipt.supplierId))
        .leftJoin(
          schema.purchaseOrder,
          eq(schema.purchaseOrder.id, schema.goodsReceipt.purchaseOrderId),
        )
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.goodsReceipt.receivedBy))
        .where(
          options.purchaseOrderId
            ? eq(schema.goodsReceipt.purchaseOrderId, options.purchaseOrderId)
            : undefined,
        )
        .orderBy(desc(schema.goodsReceipt.receivedAt))
        .limit(200),
    );

    return rows.map((row) => ({
      id: row.receipt.id,
      receiptNumber: row.receipt.receiptNumber,
      purchaseOrderId: row.receipt.purchaseOrderId,
      purchaseOrderNumber: row.orderNumber,
      supplierName: row.supplierName,
      supplierInvoiceNumber: row.receipt.supplierInvoiceNumber,
      receivedAt: row.receipt.receivedAt.toISOString(),
      receivedByName: row.receivedByName,
      totalPaise: row.receipt.totalPaise,
      lineCount: row.lineCount,
    }));
  }

  /**
   * Returns stock to a supplier.
   *
   * A ledger movement, not a document of its own. The reason the stock left is
   * the interesting fact and it belongs in the one place every other stock change
   * is recorded; a `purchase_return` table would be a second ledger to keep in
   * step with the first.
   */
  async returnToSupplier(input: {
    stockBatchId: string;
    quantity: number;
    reason: string;
  }) {
    return this.tenantDb.run(async (tx) => {
      const result = await this.stock.move(tx, {
        stockBatchId: input.stockBatchId,
        movementType: 'PURCHASE_RETURN',
        quantityDelta: -input.quantity,
        reason: input.reason,
        referenceType: 'PURCHASE_RETURN',
      });
      return { balanceAfter: result.balanceAfter };
    });
  }

  /* ---- Internals ---------------------------------------------------------- */

  /** PARTIALLY_RECEIVED or RECEIVED, decided from the lines rather than guessed. */
  private async settleOrderStatus(tx: TenantTx, purchaseOrderId: string) {
    const lines = await tx
      .select({
        ordered: schema.purchaseOrderLine.quantityOrdered,
        received: schema.purchaseOrderLine.quantityReceived,
      })
      .from(schema.purchaseOrderLine)
      .where(eq(schema.purchaseOrderLine.purchaseOrderId, purchaseOrderId));

    const complete = lines.every((l) => l.received >= l.ordered);
    const any = lines.some((l) => l.received > 0);

    await tx
      .update(schema.purchaseOrder)
      .set({ status: complete ? 'RECEIVED' : any ? 'PARTIALLY_RECEIVED' : 'PLACED' })
      .where(
        and(
          eq(schema.purchaseOrder.id, purchaseOrderId),
          inArray(schema.purchaseOrder.status, ['PLACED', 'PARTIALLY_RECEIVED']),
        ),
      );
  }
}

/**
 * The next document number for this clinic this year, e.g. PO-2026-0031.
 *
 * Counted inside the caller's transaction, and RLS scopes the count to this
 * clinic — so two clinics never collide and neither can see the other's
 * numbering. Same construction as the invoice numbering in the billing module.
 */
async function nextNumber(
  tx: TenantTx,
  prefix: string,
  column: { name: string },
  tableName: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const result = await tx.execute<{ next: string }>(
    sql`SELECT count(*) + 1 AS next FROM ${sql.identifier(tableName)}
        WHERE ${sql.identifier(column.name)} LIKE ${`${prefix}-${year}-%`}`,
  );
  const next = Number(result.rows[0]?.next ?? 1);
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}
