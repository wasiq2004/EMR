import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type {
  AdjustStock,
  OpeningBalance,
  PharmacyAlerts,
  StockBatch,
  StockMovementRow,
  StockMovementType,
} from '@emr/contracts';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';

/**
 * Stock, and the ledger underneath it.
 *
 * EVERY QUANTITY CHANGE IN THE PHARMACY GOES THROUGH `move()`. Receiving,
 * dispensing, selling, returning, correcting and writing off all call the same
 * method, which appends to `stock_movement` and updates the cached balance on
 * `stock_batch` in one statement. Nothing else in this codebase may write
 * `quantity_on_hand`, and the reason is that the two have to move together or
 * the shelf and the ledger disagree — which is the failure that makes an
 * inventory system worthless rather than merely wrong.
 *
 * WHY THE BALANCE IS UPDATED WITH AN EXPRESSION AND NOT A READ-THEN-WRITE.
 * `quantity_on_hand = quantity_on_hand + $delta` is evaluated by Postgres under
 * the row lock the UPDATE takes. Reading the balance in JavaScript and writing
 * back a computed number loses one of two concurrent dispenses — two people at
 * the counter, both fill the last three strips, both succeed, stock goes to
 * minus three. The CHECK constraint would then reject it, which is the backstop;
 * doing the arithmetic in SQL is the fix.
 */
@Injectable()
export class StockService {
  constructor(private readonly tenantDb: TenantDb) {}

  /* ---- The ledger primitive ---------------------------------------------- */

  /**
   * Moves stock and records why.
   *
   * Takes the caller's transaction rather than opening its own, so a dispense
   * that touches four batches either moves all four or none. A method that
   * committed each movement separately would leave a half-dispensed prescription
   * with stock already gone from two of them.
   */
  async move(
    tx: TenantTx,
    input: {
      stockBatchId: string;
      movementType: StockMovementType;
      quantityDelta: number;
      reason?: string | null;
      referenceType?: string | null;
      referenceId?: string | null;
    },
  ): Promise<{ balanceAfter: number }> {
    const ctx = TenantContext.require();

    if (input.quantityDelta === 0) {
      throw new ConflictException('A stock movement of zero would record nothing.');
    }

    /*
     * Update first, read the result second.
     *
     * The RETURNING clause gives the post-update balance computed by the
     * database, which is the number that goes in the ledger. Deriving it in
     * application code would reintroduce exactly the race the expression avoids.
     *
     * The CHECK constraint `stock_batch_not_negative` turns an over-issue into a
     * failed statement rather than negative stock, and the message below is what
     * the pharmacist sees when that happens.
     */
    const updated = await tx
      .update(schema.stockBatch)
      .set({
        quantityOnHand: sql`${schema.stockBatch.quantityOnHand} + ${input.quantityDelta}`,
        updatedBy: ctx.userId,
      })
      .where(eq(schema.stockBatch.id, input.stockBatchId))
      .returning({
        balance: schema.stockBatch.quantityOnHand,
        productId: schema.stockBatch.productId,
      })
      .catch((error: Error) => {
        if (/stock_batch_not_negative/.test(error.message)) {
          throw new ConflictException(
            'There is not enough of that batch left. Check the quantity on hand and pick another batch.',
          );
        }
        throw error;
      });

    const row = updated[0];
    if (!row) throw new NotFoundException('That stock batch could not be found.');

    await tx.insert(schema.stockMovement).values({
      clinicId: ctx.clinicId,
      productId: row.productId,
      stockBatchId: input.stockBatchId,
      movementType: input.movementType,
      quantityDelta: input.quantityDelta,
      balanceAfter: row.balance,
      reason: input.reason ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      actorUserId: ctx.userId,
      // Denormalised for the same reason audit_event does it: the name has to
      // survive the staff record being deleted under an erasure request.
      actorName: ctx.userName,
    });

    return { balanceAfter: row.balance };
  }

  /**
   * Finds or creates the batch a receipt is landing in.
   *
   * Upsert on (product, batch number, expiry) because a second delivery of the
   * same batch is one row with more stock, not a duplicate. Expiry is part of the
   * key: suppliers reuse batch numbers across runs, and merging two expiries
   * would silently extend the earlier one.
   */
  async ensureBatch(
    tx: TenantTx,
    input: {
      productId: string;
      batchNumber: string;
      expiryDate: string;
      unitCostPaise: number;
      mrpPaise?: number | null;
      supplierId?: string | null;
    },
  ): Promise<string> {
    const ctx = TenantContext.require();
    const batchNumber = input.batchNumber.trim();

    const [existing] = await tx
      .select({ id: schema.stockBatch.id })
      .from(schema.stockBatch)
      .where(
        and(
          eq(schema.stockBatch.productId, input.productId),
          eq(schema.stockBatch.batchNumber, batchNumber),
          eq(schema.stockBatch.expiryDate, input.expiryDate),
        ),
      )
      .limit(1);

    if (existing) {
      /*
       * Cost and MRP are refreshed from the newest receipt rather than averaged.
       *
       * Weighted average cost is more correct for valuation and worse for the
       * thing a pharmacist actually does with this number, which is price a sale
       * against the MRP printed on the pack that just arrived. Valuation
       * accuracy is a reporting concern; selling below the printed price is a
       * legal one.
       */
      await tx
        .update(schema.stockBatch)
        .set({
          unitCostPaise: input.unitCostPaise,
          mrpPaise: input.mrpPaise ?? undefined,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.stockBatch.id, existing.id));
      return existing.id;
    }

    const [created] = await tx
      .insert(schema.stockBatch)
      .values({
        clinicId: ctx.clinicId,
        productId: input.productId,
        batchNumber,
        expiryDate: input.expiryDate,
        quantityOnHand: 0,
        unitCostPaise: input.unitCostPaise,
        mrpPaise: input.mrpPaise ?? null,
        supplierId: input.supplierId ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .returning({ id: schema.stockBatch.id });

    return created!.id;
  }

  /* ---- Reads -------------------------------------------------------------- */

  /**
   * Batches with stock, nearest expiry first.
   *
   * Nearest expiry rather than alphabetical because that is the order they should
   * be dispensed in — first-expiry-first-out is how a pharmacy avoids writing
   * off stock it had time to sell.
   */
  async batches(options: {
    productId?: string;
    includeEmpty?: boolean;
    search?: string;
  }): Promise<StockBatch[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          batch: schema.stockBatch,
          productName: schema.pharmacyProduct.name,
          supplierName: schema.supplier.name,
        })
        .from(schema.stockBatch)
        .innerJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.stockBatch.productId),
        )
        .leftJoin(schema.supplier, eq(schema.supplier.id, schema.stockBatch.supplierId))
        .where(
          and(
            options.productId ? eq(schema.stockBatch.productId, options.productId) : undefined,
            options.includeEmpty ? undefined : gt(schema.stockBatch.quantityOnHand, 0),
            options.search
              ? sql`${schema.pharmacyProduct.searchNormalized} LIKE ${'%' + normalise(options.search) + '%'}`
              : undefined,
          ),
        )
        .orderBy(asc(schema.stockBatch.expiryDate), asc(schema.pharmacyProduct.name))
        .limit(500),
    );

    return rows.map(({ batch, productName, supplierName }) => ({
      id: batch.id,
      productId: batch.productId,
      productName,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      quantityOnHand: batch.quantityOnHand,
      unitCostPaise: batch.unitCostPaise,
      mrpPaise: batch.mrpPaise,
      supplierName,
      receivedAt: batch.receivedAt.toISOString(),
      ...expiryFacts(batch.expiryDate),
    }));
  }

  /** The movement history for one batch, or one product across its batches. */
  async movements(options: {
    stockBatchId?: string;
    productId?: string;
  }): Promise<StockMovementRow[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          movement: schema.stockMovement,
          productName: schema.pharmacyProduct.name,
          batchNumber: schema.stockBatch.batchNumber,
        })
        .from(schema.stockMovement)
        .innerJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.stockMovement.productId),
        )
        .innerJoin(schema.stockBatch, eq(schema.stockBatch.id, schema.stockMovement.stockBatchId))
        .where(
          and(
            options.stockBatchId
              ? eq(schema.stockMovement.stockBatchId, options.stockBatchId)
              : undefined,
            options.productId ? eq(schema.stockMovement.productId, options.productId) : undefined,
          ),
        )
        .orderBy(desc(schema.stockMovement.occurredAt))
        .limit(300),
    );

    return rows.map(({ movement, productName, batchNumber }) => ({
      id: movement.id,
      productId: movement.productId,
      productName,
      stockBatchId: movement.stockBatchId,
      batchNumber,
      movementType: movement.movementType,
      quantityDelta: movement.quantityDelta,
      balanceAfter: movement.balanceAfter,
      reason: movement.reason,
      referenceType: movement.referenceType,
      referenceId: movement.referenceId,
      occurredAt: movement.occurredAt.toISOString(),
      actorName: movement.actorName,
    }));
  }

  /* ---- Writes ------------------------------------------------------------- */

  /** A correction after a physical count, or a write-off. */
  async adjust(input: AdjustStock) {
    return this.tenantDb.run(async (tx) => {
      const result = await this.move(tx, {
        stockBatchId: input.stockBatchId,
        movementType: input.movementType,
        quantityDelta: input.quantityDelta,
        reason: input.reason,
        referenceType: 'ADJUSTMENT',
      });
      return { balanceAfter: result.balanceAfter };
    });
  }

  /**
   * Records stock already on the shelf when the module is switched on.
   *
   * Its own movement type rather than an ADJUSTMENT, because the two answer
   * different questions: an opening balance is "this is what we started with"
   * and an adjustment is "we were wrong". Conflating them makes the first month's
   * adjustment report unreadable.
   */
  async openingBalance(input: OpeningBalance) {
    return this.tenantDb.run(async (tx) => {
      const batchId = await this.ensureBatch(tx, {
        productId: input.productId,
        batchNumber: input.batchNumber,
        expiryDate: input.expiryDate,
        unitCostPaise: input.unitCostPaise,
        mrpPaise: input.mrpPaise ?? null,
      });

      const result = await this.move(tx, {
        stockBatchId: batchId,
        movementType: 'OPENING_BALANCE',
        quantityDelta: input.quantity,
        reason: 'Stock on hand when the pharmacy module was enabled',
        referenceType: 'OPENING_BALANCE',
      });

      return { stockBatchId: batchId, balanceAfter: result.balanceAfter };
    });
  }

  /* ---- The alert board ---------------------------------------------------- */

  /**
   * What a pharmacist must act on today.
   *
   * One query set rather than six screens, because the blueprint's §10.1 is a
   * work list and the point of a work list is that it is in one place. Every
   * figure is a count of something with an action attached.
   */
  async alerts(): Promise<PharmacyAlerts> {
    return this.tenantDb.runReadOnly(async (tx) => {
      /* Products with a reorder level set, and where they stand against it. */
      const levels = await tx
        .select({
          productId: schema.pharmacyProduct.id,
          productName: schema.pharmacyProduct.name,
          reorderLevel: schema.pharmacyProduct.reorderLevel,
          reorderQuantity: schema.pharmacyProduct.reorderQuantity,
          onHand: sql<number>`coalesce(sum(${schema.stockBatch.quantityOnHand}), 0)::int`,
        })
        .from(schema.pharmacyProduct)
        .leftJoin(
          schema.stockBatch,
          and(
            eq(schema.stockBatch.productId, schema.pharmacyProduct.id),
            gt(schema.stockBatch.quantityOnHand, 0),
            /*
             * Expired stock is not stock.
             *
             * Counting it would let a product sit "in stock" on the reorder
             * report while every pack of it is unsellable — which is the exact
             * situation a reorder report exists to prevent.
             */
            sql`${schema.stockBatch.expiryDate} >= current_date`,
          ),
        )
        .where(eq(schema.pharmacyProduct.isActive, true))
        .groupBy(
          schema.pharmacyProduct.id,
          schema.pharmacyProduct.name,
          schema.pharmacyProduct.reorderLevel,
          schema.pharmacyProduct.reorderQuantity,
        );

      /* How busy each product has been, so "out of stock" can be ranked. */
      const recent = await tx
        .select({
          productId: schema.stockMovement.productId,
          moved: sql<number>`sum(abs(${schema.stockMovement.quantityDelta}))::int`,
        })
        .from(schema.stockMovement)
        .where(
          and(
            inArray(schema.stockMovement.movementType, ['DISPENSE', 'SALE']),
            sql`${schema.stockMovement.occurredAt} >= now() - interval '30 days'`,
          ),
        )
        .groupBy(schema.stockMovement.productId);

      const movedBy = new Map(recent.map((r) => [r.productId, r.moved]));

      const outOfStock = levels
        .filter((row) => row.onHand === 0 && (row.reorderLevel ?? 0) > 0)
        .map((row) => ({
          productId: row.productId,
          productName: row.productName,
          reorderLevel: row.reorderLevel,
          reorderQuantity: row.reorderQuantity,
          recentMovement: movedBy.get(row.productId) ?? 0,
        }))
        // Busiest first: a fast mover at zero is an emergency, a slow one is a note.
        .sort((a, b) => b.recentMovement - a.recentMovement);

      const lowStock = levels
        .filter(
          (row) =>
            row.reorderLevel !== null && row.onHand > 0 && row.onHand <= row.reorderLevel,
        )
        .map((row) => ({
          productId: row.productId,
          productName: row.productName,
          quantityOnHand: row.onHand,
          reorderLevel: row.reorderLevel!,
          reorderQuantity: row.reorderQuantity,
        }))
        .sort((a, b) => a.quantityOnHand / a.reorderLevel - b.quantityOnHand / b.reorderLevel);

      /*
       * Expiry, split at today.
       *
       * Ninety days is the window a supplier will usually still take stock back
       * in, which is what makes it the actionable horizon rather than an
       * arbitrary one.
       */
      const expiring = await tx
        .select({
          id: schema.stockBatch.id,
          productId: schema.stockBatch.productId,
          productName: schema.pharmacyProduct.name,
          batchNumber: schema.stockBatch.batchNumber,
          expiryDate: schema.stockBatch.expiryDate,
          quantityOnHand: schema.stockBatch.quantityOnHand,
          unitCostPaise: schema.stockBatch.unitCostPaise,
        })
        .from(schema.stockBatch)
        .innerJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.stockBatch.productId),
        )
        .where(
          and(
            gt(schema.stockBatch.quantityOnHand, 0),
            sql`${schema.stockBatch.expiryDate} < current_date + interval '90 days'`,
          ),
        )
        .orderBy(asc(schema.stockBatch.expiryDate))
        .limit(200);

      const [clarifications] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.rxClarification)
        .where(eq(schema.rxClarification.status, 'OPEN'));

      const [queue] = await tx
        .select({
          n: sql<number>`count(*)::int`,
          oldest: sql<number | null>`
            max(extract(epoch from (now() - ${schema.dispenseRecord.queuedAt})) / 60)::int
          `,
        })
        .from(schema.dispenseRecord)
        .where(
          sql`${schema.dispenseRecord.status} NOT IN ('DISPENSED', 'CANCELLED')`,
        );

      return {
        outOfStock,
        lowStock,
        expiringSoon: expiring
          .filter((b) => expiryFacts(b.expiryDate).daysToExpiry >= 0)
          .map((b) => ({
            stockBatchId: b.id,
            productId: b.productId,
            productName: b.productName,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate,
            daysToExpiry: expiryFacts(b.expiryDate).daysToExpiry,
            quantityOnHand: b.quantityOnHand,
            valueAtCostPaise: b.quantityOnHand * b.unitCostPaise,
          })),
        expired: expiring
          .filter((b) => expiryFacts(b.expiryDate).isExpired)
          .map((b) => ({
            stockBatchId: b.id,
            productId: b.productId,
            productName: b.productName,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate,
            quantityOnHand: b.quantityOnHand,
            valueAtCostPaise: b.quantityOnHand * b.unitCostPaise,
          })),
        openClarifications: clarifications?.n ?? 0,
        waitingPrescriptions: queue?.n ?? 0,
        oldestWaitingMinutes: queue?.oldest ?? null,
      };
    });
  }

  /**
   * Batches that could fill a given molecule, nearest expiry first.
   *
   * Used by the dispensing screen. Matches on the catalogue link when the order
   * has one and falls back to the molecule name, which is how a prescription for
   * "Amoxicillin 500mg" offers whichever brands are on the shelf.
   *
   * EXPIRED BATCHES ARE NOT RETURNED. Not shown greyed out — absent. A batch that
   * cannot legally be dispensed has no business being one click away from being
   * dispensed.
   */
  async batchesFor(options: {
    catalogueItemId?: string | null;
    moleculeName?: string | null;
  }): Promise<
    {
      stockBatchId: string;
      productId: string;
      productName: string;
      batchNumber: string;
      expiryDate: string;
      quantityOnHand: number;
      mrpPaise: number | null;
      isSubstitution: boolean;
    }[]
  > {
    if (!options.catalogueItemId && !options.moleculeName) return [];

    const molecule = options.moleculeName ? normalise(options.moleculeName) : null;

    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          batchId: schema.stockBatch.id,
          productId: schema.pharmacyProduct.id,
          productName: schema.pharmacyProduct.name,
          batchNumber: schema.stockBatch.batchNumber,
          expiryDate: schema.stockBatch.expiryDate,
          quantityOnHand: schema.stockBatch.quantityOnHand,
          mrpPaise: schema.stockBatch.mrpPaise,
          catalogueItemId: schema.pharmacyProduct.catalogueItemId,
          productMolecule: schema.pharmacyProduct.moleculeName,
        })
        .from(schema.stockBatch)
        .innerJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.stockBatch.productId),
        )
        .where(
          and(
            gt(schema.stockBatch.quantityOnHand, 0),
            sql`${schema.stockBatch.expiryDate} >= current_date`,
            eq(schema.pharmacyProduct.isActive, true),
            or(
              options.catalogueItemId
                ? eq(schema.pharmacyProduct.catalogueItemId, options.catalogueItemId)
                : undefined,
              molecule
                ? sql`lower(coalesce(${schema.pharmacyProduct.moleculeName}, '')) = ${molecule}`
                : undefined,
            ),
          ),
        )
        .orderBy(asc(schema.stockBatch.expiryDate))
        .limit(50),
    );

    return rows.map((row) => ({
      stockBatchId: row.batchId,
      productId: row.productId,
      productName: row.productName,
      batchNumber: row.batchNumber,
      expiryDate: row.expiryDate,
      quantityOnHand: row.quantityOnHand,
      mrpPaise: row.mrpPaise,
      /*
       * A substitution is a DIFFERENT MOLECULE, not a different brand.
       *
       * Matching the catalogue item means it is the same product the doctor
       * chose. Matching only on molecule means a different brand of the same
       * drug, which is not a substitution in any sense a prescriber would
       * recognise. Anything reached by neither route is flagged, and the
       * dispensing service will then require a reason.
       */
      isSubstitution: options.catalogueItemId
        ? row.catalogueItemId !== options.catalogueItemId &&
          normalise(row.productMolecule ?? '') !== molecule
        : false,
    }));
  }
}

/** Mirrors the normalisation the drug catalogue uses, so searches agree. */
export function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Expiry, computed against the server's date rather than the browser's.
 *
 * A counter machine with a wrong clock must not be able to dispense an expired
 * batch by disagreeing about what day it is.
 */
function expiryFacts(expiryDate: string): { isExpired: boolean; daysToExpiry: number } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${expiryDate}T00:00:00`);
  const days = Math.round((expiry.getTime() - today.getTime()) / 86_400_000);
  return { isExpired: days < 0, daysToExpiry: days };
}
