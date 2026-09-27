import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { PharmacyReport } from '@emr/contracts';

import { TenantDb } from '../../common/tenancy/tenant-db.service';

/**
 * Pharmacy reporting.
 *
 * The blueprint's §10.2 chart list, with one addition it insists on and most
 * products omit: PRESCRIPTION-TO-DISPENSE TURNAROUND. That is the number a
 * patient experiences — how long they stood at the counter — and it is the only
 * figure here that measures the clinic's service rather than its stock.
 *
 * Reported as a MEDIAN, not a mean. One prescription that waited four hours
 * because the patient went home and came back would drag an average past
 * usefulness; the median says what a typical patient waited, which is the
 * question being asked.
 *
 * Everything is computed from `stock_movement` and the dispense tables, never
 * from a stored aggregate. A cached pharmacy figure is stale the moment someone
 * sells something, and a stale stock valuation is worse than none because someone
 * will order against it.
 */
@Injectable()
export class PharmacyReportsService {
  constructor(private readonly tenantDb: TenantDb) {}

  async report(days = 30): Promise<PharmacyReport> {
    const window = Math.min(Math.max(days, 1), 365);

    return this.tenantDb.runReadOnly(async (tx) => {
      const since = sql`now() - make_interval(days => ${window})`;

      /* ---- Dispensing ---------------------------------------------------- */

      const [dispensing] = await tx
        .select({
          prescriptions: sql<number>`count(*)::int`,
          median: sql<number | null>`
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch from (${schema.dispenseRecord.completedAt} - ${schema.dispenseRecord.queuedAt})) / 60
            )::int
          `,
        })
        .from(schema.dispenseRecord)
        .where(
          and(
            inArray(schema.dispenseRecord.status, ['DISPENSED', 'PARTIAL']),
            sql`${schema.dispenseRecord.completedAt} >= ${since}`,
          ),
        );

      const [items] = await tx
        .select({
          n: sql<number>`count(*)::int`,
          substitutions: sql<number>`count(*) FILTER (WHERE ${schema.dispenseLine.isSubstitution})::int`,
        })
        .from(schema.dispenseLine)
        .innerJoin(
          schema.dispenseRecord,
          eq(schema.dispenseRecord.id, schema.dispenseLine.dispenseRecordId),
        )
        .where(
          and(
            sql`${schema.dispenseLine.quantityDispensed} > 0`,
            sql`${schema.dispenseRecord.completedAt} >= ${since}`,
          ),
        );

      const [clarifications] = await tx
        .select({
          raised: sql<number>`count(*)::int`,
          answered: sql<number>`count(*) FILTER (WHERE ${schema.rxClarification.status} = 'ANSWERED')::int`,
        })
        .from(schema.rxClarification)
        .where(sql`${schema.rxClarification.raisedAt} >= ${since}`);

      /* ---- Money --------------------------------------------------------- */

      const [sales] = await tx
        .select({
          /*
           * Returns are negative rows in the same table, so they are excluded
           * from the sales total and reported separately. Summing everything
           * would quietly net them off and hide a return rate worth knowing.
           */
          total: sql<number>`coalesce(sum(${schema.pharmacySale.totalPaise}) FILTER (WHERE NOT ${schema.pharmacySale.isReturn}), 0)::int`,
          count: sql<number>`count(*) FILTER (WHERE NOT ${schema.pharmacySale.isReturn})::int`,
          returns: sql<number>`coalesce(-sum(${schema.pharmacySale.totalPaise}) FILTER (WHERE ${schema.pharmacySale.isReturn}), 0)::int`,
        })
        .from(schema.pharmacySale)
        .where(
          and(
            eq(schema.pharmacySale.status, 'COMPLETED'),
            sql`${schema.pharmacySale.soldAt} >= ${since}`,
          ),
        );

      const [purchases] = await tx
        .select({
          total: sql<number>`coalesce(sum(${schema.goodsReceipt.totalPaise}), 0)::int`,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.goodsReceipt)
        .where(sql`${schema.goodsReceipt.receivedAt} >= ${since}`);

      /*
       * Loss, valued at cost.
       *
       * At cost and not at MRP, deliberately: writing off expired stock loses
       * what it was paid for, not what it might have sold for. Valuing loss at
       * retail inflates it and makes the figure useless for deciding how much to
       * order next time.
       */
      const [loss] = await tx
        .select({
          expiry: sql<number>`coalesce(-sum(
            ${schema.stockMovement.quantityDelta} * ${schema.stockBatch.unitCostPaise}
          ) FILTER (WHERE ${schema.stockMovement.movementType} = 'EXPIRY_WRITE_OFF'), 0)::int`,
          damage: sql<number>`coalesce(-sum(
            ${schema.stockMovement.quantityDelta} * ${schema.stockBatch.unitCostPaise}
          ) FILTER (WHERE ${schema.stockMovement.movementType} = 'DAMAGE_WRITE_OFF'), 0)::int`,
        })
        .from(schema.stockMovement)
        .innerJoin(schema.stockBatch, eq(schema.stockBatch.id, schema.stockMovement.stockBatchId))
        .where(sql`${schema.stockMovement.occurredAt} >= ${since}`);

      /* ---- Movement ------------------------------------------------------ */

      const topProducts = await tx
        .select({
          productId: schema.stockMovement.productId,
          productName: schema.pharmacyProduct.name,
          quantity: sql<number>`(-sum(${schema.stockMovement.quantityDelta}))::int`,
          valuePaise: sql<number>`(-sum(
            ${schema.stockMovement.quantityDelta} * ${schema.stockBatch.unitCostPaise}
          ))::int`,
        })
        .from(schema.stockMovement)
        .innerJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.stockMovement.productId),
        )
        .innerJoin(schema.stockBatch, eq(schema.stockBatch.id, schema.stockMovement.stockBatchId))
        .where(
          and(
            inArray(schema.stockMovement.movementType, ['DISPENSE', 'SALE']),
            sql`${schema.stockMovement.occurredAt} >= ${since}`,
            // Corrections at the counter are positive DISPENSE rows; excluding
            // them keeps "top consumed" from cancelling itself out.
            sql`${schema.stockMovement.quantityDelta} < 0`,
          ),
        )
        .groupBy(schema.stockMovement.productId, schema.pharmacyProduct.name)
        .orderBy(sql`(-sum(${schema.stockMovement.quantityDelta})) DESC`)
        .limit(15);

      /*
       * Non-moving stock: money sitting on a shelf.
       *
       * Products holding stock with no outward movement in the window. This is
       * the figure that tells a clinic it over-ordered, and it is the one nobody
       * looks at until the expiry write-off arrives.
       */
      const nonMoving = await tx
        .select({
          productId: schema.pharmacyProduct.id,
          productName: schema.pharmacyProduct.name,
          quantityOnHand: sql<number>`coalesce(sum(${schema.stockBatch.quantityOnHand}), 0)::int`,
          valueAtCostPaise: sql<number>`coalesce(sum(
            ${schema.stockBatch.quantityOnHand} * ${schema.stockBatch.unitCostPaise}
          ), 0)::int`,
          lastMovedAt: sql<string | null>`(
            SELECT max(m.occurred_at)::text FROM stock_movement m
            WHERE m.product_id = ${schema.pharmacyProduct.id}
              AND m.quantity_delta < 0
          )`,
        })
        .from(schema.pharmacyProduct)
        .innerJoin(schema.stockBatch, eq(schema.stockBatch.productId, schema.pharmacyProduct.id))
        .where(
          and(
            sql`${schema.stockBatch.quantityOnHand} > 0`,
            sql`NOT EXISTS (
              SELECT 1 FROM stock_movement m
              WHERE m.product_id = ${schema.pharmacyProduct.id}
                AND m.quantity_delta < 0
                AND m.movement_type IN ('DISPENSE', 'SALE')
                AND m.occurred_at >= ${since}
            )`,
          ),
        )
        .groupBy(schema.pharmacyProduct.id, schema.pharmacyProduct.name)
        .orderBy(
          sql`coalesce(sum(${schema.stockBatch.quantityOnHand} * ${schema.stockBatch.unitCostPaise}), 0) DESC`,
        )
        .limit(15);

      /* Daily dispensing, for the sparkline. */
      const daily = await tx
        .select({
          date: sql<string>`(${schema.dispenseRecord.completedAt} AT TIME ZONE 'Asia/Kolkata')::date::text`,
          prescriptions: sql<number>`count(DISTINCT ${schema.dispenseRecord.id})::int`,
          items: sql<number>`count(${schema.dispenseLine.id})::int`,
        })
        .from(schema.dispenseRecord)
        .leftJoin(
          schema.dispenseLine,
          and(
            eq(schema.dispenseLine.dispenseRecordId, schema.dispenseRecord.id),
            sql`${schema.dispenseLine.quantityDispensed} > 0`,
          ),
        )
        .where(
          and(
            inArray(schema.dispenseRecord.status, ['DISPENSED', 'PARTIAL']),
            sql`${schema.dispenseRecord.completedAt} >= ${since}`,
          ),
        )
        .groupBy(sql`(${schema.dispenseRecord.completedAt} AT TIME ZONE 'Asia/Kolkata')::date`)
        .orderBy(sql`(${schema.dispenseRecord.completedAt} AT TIME ZONE 'Asia/Kolkata')::date`);

      const now = new Date();
      return {
        rangeFrom: new Date(now.getTime() - window * 86_400_000).toISOString(),
        rangeTo: now.toISOString(),

        prescriptionsDispensed: dispensing?.prescriptions ?? 0,
        itemsDispensed: items?.n ?? 0,
        medianTurnaroundMinutes: dispensing?.median ?? null,
        clarificationsRaised: clarifications?.raised ?? 0,
        clarificationsAnswered: clarifications?.answered ?? 0,
        substitutionCount: items?.substitutions ?? 0,

        salesTotalPaise: sales?.total ?? 0,
        salesCount: sales?.count ?? 0,
        returnsTotalPaise: sales?.returns ?? 0,

        purchasesTotalPaise: purchases?.total ?? 0,
        receiptCount: purchases?.count ?? 0,

        expiryLossPaise: loss?.expiry ?? 0,
        damageLossPaise: loss?.damage ?? 0,

        topProducts,
        nonMoving: nonMoving.map((row) => ({
          ...row,
          lastMovedAt: row.lastMovedAt ? new Date(row.lastMovedAt).toISOString() : null,
        })),
        dailyDispensing: daily,
      };
    });
  }
}
