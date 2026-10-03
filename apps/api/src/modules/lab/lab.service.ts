import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type {
  LabInterpretation,
  LabOrder,
  LabReviewSummary,
  LabTestCatalogueItem,
} from '@emr/contracts';

import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { EventHub } from '../../common/events/event-hub.service';

/**
 * Lab orders and results.
 *
 * THE POINT OF THE MODULE IS THE UNREAD RESULT. A clinic that orders a test and
 * never looks at what came back is the failure this exists to make visible, so
 * "a result arrived" and "a clinician read it" are two separate facts —
 * `RESULTED` and `REVIEWED` — and nothing collapses them. An order moves to
 * `REVIEWED` only when somebody says so, never as a side effect of the result
 * being entered.
 *
 * THE CLINIC DOES NOT RUN THE LAB. Patients go to a lab down the road and the
 * report comes back on paper or as a PDF on WhatsApp, so there is no "specimen
 * collected" or "in transit" state: nobody at the lab would ever update it, and
 * modelling states the clinic cannot observe would leave every order stuck in
 * one. What the clinic can observe is: asked for, came back, read.
 *
 * INTERPRETATION IS DERIVED HERE, never accepted from the caller — the same rule
 * as the vitals. "Is this result dangerous" is a clinical assertion, and a field
 * that says only what the caller chose to claim is useless as a filter and worse
 * than absent on a record somebody later relies on.
 */
@Injectable()
export class LabService {
  /**
   * How long an order may sit with no result before it is chased.
   *
   * Fourteen days. An order the patient never went for looks exactly like one
   * the lab is slow with, and both need a phone call — so the overdue count
   * does not try to tell them apart.
   */
  private static readonly OVERDUE_DAYS = 14;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly events: EventHub,
  ) {}

  /* ---- The catalogue ----------------------------------------------------- */

  async searchTests(term: string, limit = 12): Promise<LabTestCatalogueItem[]> {
    const q = term.trim().toLowerCase();
    const ctx = TenantContext.require();

    /*
     * Regex-safe, for the same reason the diagnosis search is: a test named
     * "T3/T4/TSH" contains characters a POSIX regex reads as operators, and an
     * unescaped one is either a wrong match or a 500.
     */
    const rx = q.replace(/[.^$*+?()[\]{}|\\-]/g, '\\$&');

    return this.tenantDb.runReadOnly(async (tx) => {
      const rows =
        q.length < 2
          ? await tx
              .select()
              .from(schema.labTestCatalogueItem)
              .where(eq(schema.labTestCatalogueItem.isActive, true))
              .orderBy(asc(schema.labTestCatalogueItem.name))
              .limit(limit)
          : await tx
              .select()
              .from(schema.labTestCatalogueItem)
              .where(
                and(
                  eq(schema.labTestCatalogueItem.isActive, true),
                  or(
                    sql`${schema.labTestCatalogueItem.searchNormalized} ILIKE ${'%' + q + '%'}`,
                    sql`${schema.labTestCatalogueItem.searchNormalized} % ${q}`,
                  ),
                ),
              )
              .orderBy(
                // Word boundaries, not string prefixes. "CBC" must find the
                // complete blood count whether that word leads the row or not —
                // the same mistake the diagnosis search made with "urti".
                sql`CASE
                      WHEN ${schema.labTestCatalogueItem.searchNormalized} ~ ${'(^| )' + rx + '( |$)'} THEN 0
                      WHEN ${schema.labTestCatalogueItem.searchNormalized} ~ ${'(^| )' + rx} THEN 1
                      ELSE 2
                    END`,
                sql`similarity(${schema.labTestCatalogueItem.searchNormalized}, ${q}) DESC`,
                asc(schema.labTestCatalogueItem.name),
              )
              .limit(limit);

      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        codeSystem: row.codeSystem,
        name: row.name,
        category: row.category,
        unit: row.unit,
        referenceLow: numberOrNull(row.referenceLow),
        referenceHigh: numberOrNull(row.referenceHigh),
        pricePaise: row.pricePaise === null ? null : Number(row.pricePaise),
        isOwn: row.clinicId === ctx.clinicId,
      }));
    });
  }

  /* ---- Ordering ---------------------------------------------------------- */

  /**
   * Orders one test.
   *
   * ONE ROW PER TEST, not per requisition slip. A doctor ordering a CBC and a
   * fasting glucose has asked two questions that come back at different times
   * and are acted on separately; one order with a list inside would be "pending"
   * until the slowest result arrived, which is exactly when the fast one matters.
   */
  async order(input: {
    patientId: string;
    encounterId?: string | null;
    catalogueItemId?: string | null;
    testName: string;
    clinicalNote?: string | null;
    isUrgent: boolean;
  }): Promise<LabOrder> {
    const ctx = TenantContext.require();

    const id = await this.tenantDb.run(async (tx) => {
      /*
       * The unit comes from the catalogue at order time and is copied onto the
       * order.
       *
       * Same reason `medication_request` keeps its own `molecule_name`: the
       * order is a record of what was asked for and has to still say that after
       * the catalogue entry is renamed or deactivated.
       */
      let unit: string | null = null;
      if (input.catalogueItemId) {
        const [item] = await tx
          .select({ unit: schema.labTestCatalogueItem.unit })
          .from(schema.labTestCatalogueItem)
          .where(eq(schema.labTestCatalogueItem.id, input.catalogueItemId))
          .limit(1);
        if (!item) throw new NotFoundException('That test could not be found.');
        unit = item.unit;
      }

      const [created] = await tx
        .insert(schema.labOrder)
        .values({
          clinicId: ctx.clinicId,
          patientId: input.patientId,
          encounterId: input.encounterId ?? null,
          catalogueItemId: input.catalogueItemId ?? null,
          testName: input.testName,
          unit,
          status: 'ORDERED',
          clinicalNote: input.clinicalNote ?? null,
          isUrgent: input.isUrgent,
          orderedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning({ id: schema.labOrder.id });

      return created!.id;
    });

    this.announce(ctx.clinicId, id);
    return this.byId(id);
  }

  /** Cancels an order that has no result. */
  async cancel(id: string, reason: string): Promise<LabOrder> {
    const ctx = TenantContext.require();

    await this.tenantDb.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.labOrder)
        .where(eq(schema.labOrder.id, id))
        .limit(1);
      if (!current) throw new NotFoundException('That order could not be found.');

      /*
       * A resulted order is not cancellable.
       *
       * The result exists and may have been acted on; "cancelling" the order it
       * came from would leave a result attached to something the record says was
       * never asked for. A wrong result is corrected, not cancelled.
       */
      if (current.status === 'RESULTED' || current.status === 'REVIEWED') {
        throw new ConflictException(
          'A result has already come back for this test. Correct the result rather than cancelling the order.',
        );
      }
      if (current.status === 'CANCELLED') return;

      await tx
        .update(schema.labOrder)
        .set({ status: 'CANCELLED', cancelledReason: reason, updatedBy: ctx.userId })
        .where(eq(schema.labOrder.id, id));
    });

    this.announce(ctx.clinicId, id);
    return this.byId(id);
  }

  /* ---- Results ----------------------------------------------------------- */

  /**
   * Records what came back.
   *
   * A CORRECTION IS A NEW ROW. A lab that phones to correct a potassium does not
   * change what was ordered, and overwriting the value in place would destroy
   * the record of what the doctor acted on — so the previous result is marked
   * superseded and kept. The unique index enforces one live result per order, so
   * two people entering a result on the same morning cannot leave the record
   * ambiguous.
   *
   * ENTERING A RESULT DOES NOT MARK IT REVIEWED. The order goes to `RESULTED`,
   * and a clinician has to say they have read it. Collapsing the two would make
   * the arrival of a result count as somebody having seen it, which is the exact
   * failure this module exists to prevent.
   */
  async enterResult(
    orderId: string,
    input: {
      valueNumeric?: number | null;
      valueText?: string | null;
      unit?: string | null;
      referenceLow?: number | null;
      referenceHigh?: number | null;
      specimenAt?: string | null;
      performedBy?: string | null;
      labNote?: string | null;
      documentId?: string | null;
      supersedesReason?: string | null;
    },
  ): Promise<LabOrder> {
    const ctx = TenantContext.require();

    await this.tenantDb.run(async (tx) => {
      const [order] = await tx
        .select()
        .from(schema.labOrder)
        .where(eq(schema.labOrder.id, orderId))
        .limit(1);
      if (!order) throw new NotFoundException('That order could not be found.');
      if (order.status === 'CANCELLED') {
        throw new ConflictException(
          'That test was cancelled. Order it again rather than attaching a result to a cancelled order.',
        );
      }

      const [existing] = await tx
        .select({ id: schema.labResult.id })
        .from(schema.labResult)
        .where(
          and(eq(schema.labResult.labOrderId, orderId), isNull(schema.labResult.supersededAt)),
        )
        .limit(1);

      if (existing) {
        /*
         * A reason is required to correct a result, and refused otherwise.
         *
         * Not an optional nicety: the previous value may be why a patient was
         * started on a drug, and "superseded, no reason recorded" is not
         * something anybody can act on six months later.
         */
        if (!input.supersedesReason) {
          throw new ConflictException(
            'A result is already recorded for this test. To correct it, say why.',
          );
        }
        await tx
          .update(schema.labResult)
          .set({
            supersededAt: new Date(),
            supersededReason: input.supersedesReason,
            updatedBy: ctx.userId,
          })
          .where(eq(schema.labResult.id, existing.id));
      }

      /*
       * The range: the lab's if it quoted one, otherwise the catalogue's.
       *
       * Labs disagree about reference ranges and the one on the report is what
       * the result should be judged against. Either way it is COPIED onto the
       * result, so a later correction to the catalogue cannot reclassify a result
       * that was already acted on.
       */
      let low = input.referenceLow ?? null;
      let high = input.referenceHigh ?? null;
      let unit = input.unit ?? order.unit ?? null;

      if ((low === null || high === null) && order.catalogueItemId) {
        const [item] = await tx
          .select({
            low: schema.labTestCatalogueItem.referenceLow,
            high: schema.labTestCatalogueItem.referenceHigh,
            unit: schema.labTestCatalogueItem.unit,
          })
          .from(schema.labTestCatalogueItem)
          .where(eq(schema.labTestCatalogueItem.id, order.catalogueItemId))
          .limit(1);
        low ??= numberOrNull(item?.low ?? null);
        high ??= numberOrNull(item?.high ?? null);
        unit ??= item?.unit ?? null;
      }

      const numeric = input.valueNumeric ?? null;

      await tx.insert(schema.labResult).values({
        clinicId: ctx.clinicId,
        labOrderId: orderId,
        valueNumeric: numeric === null ? null : String(numeric),
        valueText: input.valueText ?? null,
        unit,
        referenceLow: low === null ? null : String(low),
        referenceHigh: high === null ? null : String(high),
        interpretation: interpretResult(numeric, low, high, input.valueText ?? null),
        specimenAt: input.specimenAt ? new Date(input.specimenAt) : null,
        performedBy: input.performedBy ?? null,
        labNote: input.labNote ?? null,
        documentId: input.documentId ?? null,
        enteredBy: ctx.userId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });

      /*
       * RESULTED, and never REVIEWED.
       *
       * Also resets `reviewed_at`: correcting a result the doctor had already
       * signed off means they have NOT read the new value, and leaving the order
       * marked reviewed would hide a corrected potassium behind a tick somebody
       * put there for the old one.
       */
      await tx
        .update(schema.labOrder)
        .set({
          status: 'RESULTED',
          reviewedAt: null,
          reviewedBy: null,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.labOrder.id, orderId));
    });

    this.announce(ctx.clinicId, orderId);
    return this.byId(orderId);
  }

  /**
   * Marks a result as read by a clinician.
   *
   * The only thing that moves an order to `REVIEWED`, and it records who. A
   * result that nobody has opened is the thing the review list exists to show,
   * so this has to be a deliberate act rather than a side effect of a page
   * loading.
   */
  async review(orderId: string): Promise<LabOrder> {
    const ctx = TenantContext.require();

    await this.tenantDb.run(async (tx) => {
      const [order] = await tx
        .select()
        .from(schema.labOrder)
        .where(eq(schema.labOrder.id, orderId))
        .limit(1);
      if (!order) throw new NotFoundException('That order could not be found.');

      if (order.status !== 'RESULTED') {
        throw new ConflictException(
          order.status === 'ORDERED'
            ? 'There is no result to review yet.'
            : `That order is ${order.status.toLowerCase()} and cannot be reviewed.`,
        );
      }

      await tx
        .update(schema.labOrder)
        .set({
          status: 'REVIEWED',
          reviewedAt: new Date(),
          reviewedBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.labOrder.id, orderId));
    });

    this.announce(ctx.clinicId, orderId);
    return this.byId(orderId);
  }

  /* ---- Reads ------------------------------------------------------------- */

  async byId(id: string): Promise<LabOrder> {
    const [order] = await this.list({ orderId: id, limit: 1 });
    if (!order) throw new NotFoundException('That order could not be found.');
    return order;
  }

  /**
   * Orders, with their live result.
   *
   * Superseded results are deliberately not returned here: "the result" should
   * be unambiguous everywhere it is shown. The history is readable through
   * `historyFor`, which is where somebody asking "what did it say before" goes.
   */
  async list(options: {
    patientId?: string;
    orderId?: string;
    /** Only orders a clinician still has to deal with. */
    awaitingOnly?: boolean;
    limit?: number;
  } = {}): Promise<LabOrder[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          order: schema.labOrder,
          patientName: schema.patient.fullName,
          patientMrn: schema.patient.mrn,
          orderedByName: schema.appUser.fullName,
          result: schema.labResult,
        })
        .from(schema.labOrder)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.labOrder.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.labOrder.orderedBy))
        .leftJoin(
          schema.labResult,
          and(
            eq(schema.labResult.labOrderId, schema.labOrder.id),
            isNull(schema.labResult.supersededAt),
          ),
        )
        .where(
          and(
            options.orderId ? eq(schema.labOrder.id, options.orderId) : undefined,
            options.patientId ? eq(schema.labOrder.patientId, options.patientId) : undefined,
            options.awaitingOnly
              ? and(
                  sql`${schema.labOrder.status} IN ('ORDERED', 'RESULTED')`,
                  isNull(schema.labOrder.reviewedAt),
                )
              : undefined,
          ),
        )
        .orderBy(
          // Urgent first, then oldest — a result that has been waiting a week
          // matters more than one that arrived this morning.
          desc(schema.labOrder.isUrgent),
          asc(schema.labOrder.orderedAt),
        )
        .limit(Math.min(options.limit ?? 100, 500)),
    );

    return rows.map(serialise);
  }

  /** Every result ever entered against an order, including superseded ones. */
  async historyFor(orderId: string) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ result: schema.labResult, enteredByName: schema.appUser.fullName })
        .from(schema.labResult)
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.labResult.enteredBy))
        .where(eq(schema.labResult.labOrderId, orderId))
        .orderBy(desc(schema.labResult.resultedAt)),
    );
    return rows.map(({ result, enteredByName }) => serialiseResult(result, enteredByName));
  }

  /**
   * The doctor's "results to review" card.
   *
   * Four numbers, and the split between them is the whole value: a result that
   * arrived and nobody opened is a different problem from an order the patient
   * never went for, and both are different from a critical value sitting unread.
   */
  async reviewSummary(): Promise<LabReviewSummary> {
    const [row] = (
      await this.tenantDb.runReadOnly((tx) =>
        tx.execute<{
          awaiting: number; abnormal: number; critical: number;
          awaiting_result: number; overdue: number;
        }>(sql`
          SELECT
            count(*) FILTER (WHERE o.status = 'RESULTED' AND o.reviewed_at IS NULL)::int
              AS awaiting,
            count(*) FILTER (
              WHERE o.status = 'RESULTED' AND o.reviewed_at IS NULL
                AND r.interpretation IN ('LOW', 'HIGH', 'CRITICAL', 'ABNORMAL')
            )::int AS abnormal,
            count(*) FILTER (
              WHERE o.status = 'RESULTED' AND o.reviewed_at IS NULL
                AND r.interpretation = 'CRITICAL'
            )::int AS critical,
            count(*) FILTER (WHERE o.status = 'ORDERED')::int AS awaiting_result,
            count(*) FILTER (
              WHERE o.status = 'ORDERED'
                AND o.ordered_at < now() - ${sql.raw(`interval '${LabService.OVERDUE_DAYS} days'`)}
            )::int AS overdue
          FROM lab_order o
          LEFT JOIN lab_result r
            ON r.lab_order_id = o.id AND r.superseded_at IS NULL
        `),
      )
    ).rows;

    return {
      awaitingReview: Number(row?.awaiting ?? 0),
      abnormalAwaitingReview: Number(row?.abnormal ?? 0),
      criticalAwaitingReview: Number(row?.critical ?? 0),
      awaitingResult: Number(row?.awaiting_result ?? 0),
      overdue: Number(row?.overdue ?? 0),
    };
  }

  /**
   * Identifiers only, like everything on the SSE pipe.
   *
   * Never the test name or the value: a lab result is among the most sensitive
   * things in the record, and this stream reaches every open tab in the clinic.
   * The screens refetch on receipt.
   */
  private announce(clinicId: string, labOrderId: string): void {
    this.events.emit({ type: 'lab-changed', clinicId, data: { labOrderId } });
  }
}

/* -------------------------------------------------------------------------- */

/**
 * How far outside its range a numeric result has to be to read as critical.
 *
 * A MULTIPLE OF THE RANGE'S OWN WIDTH, not a fixed number, because the tests
 * have no common scale: a sodium 5 units high is unremarkable and a potassium 5
 * units high is a medical emergency. Half a range-width beyond either bound puts
 * a haemoglobin of 5 (range 12-16) and a potassium of 7.3 (range 3.5-5.1) both
 * in the critical band, which is the right answer for both.
 *
 * This is a PROMPT TO LOOK, not a diagnosis, and the interface says so. No
 * product-wide heuristic can know that a given patient's baseline makes a value
 * normal for them.
 */
const CRITICAL_RANGE_MULTIPLE = 0.5;

/**
 * Where a result falls against its range.
 *
 * DERIVED SERVER-SIDE, never accepted from the caller — the same rule as the
 * vitals, for the same reason.
 *
 * Qualitative results get `ABNORMAL` or null rather than a direction, because
 * "Positive" has no magnitude. The word list is deliberately short and
 * conservative: it flags the unmistakable cases and leaves everything else
 * unflagged rather than guessing at a lab's phrasing. An unflagged result still
 * appears in the review list — the flag changes the ordering, not whether
 * somebody has to read it.
 */
export function interpretResult(
  numeric: number | null,
  low: number | null,
  high: number | null,
  text: string | null,
): LabInterpretation | null {
  if (numeric === null) {
    if (!text) return null;
    const normalised = text.trim().toLowerCase();
    if (/^(positive|reactive|detected|growth|abnormal)\b/.test(normalised)) return 'ABNORMAL';
    if (/^(negative|non[- ]?reactive|not detected|no growth|normal|nil)\b/.test(normalised)) {
      return 'NORMAL';
    }
    // Anything else is a free-text report. Not guessed at.
    return null;
  }

  // Nothing to compare against is not the same as normal.
  if (low === null && high === null) return null;

  const width = low !== null && high !== null ? high - low : null;
  const margin = width !== null ? width * CRITICAL_RANGE_MULTIPLE : null;

  if (low !== null && numeric < low) {
    return margin !== null && numeric < low - margin ? 'CRITICAL' : 'LOW';
  }
  if (high !== null && numeric > high) {
    return margin !== null && numeric > high + margin ? 'CRITICAL' : 'HIGH';
  }
  return 'NORMAL';
}

function serialise(row: {
  order: typeof schema.labOrder.$inferSelect;
  patientName: string;
  patientMrn: string;
  orderedByName: string | null;
  result: typeof schema.labResult.$inferSelect | null;
}): LabOrder {
  return {
    id: row.order.id,
    patientId: row.order.patientId,
    patientName: row.patientName,
    patientMrn: row.patientMrn,
    encounterId: row.order.encounterId,
    catalogueItemId: row.order.catalogueItemId,
    testName: row.order.testName,
    unit: row.order.unit,
    status: row.order.status,
    clinicalNote: row.order.clinicalNote,
    isUrgent: row.order.isUrgent,
    orderedAt: row.order.orderedAt.toISOString(),
    orderedBy: row.order.orderedBy,
    orderedByName: row.orderedByName,
    reviewedAt: row.order.reviewedAt?.toISOString() ?? null,
    reviewedBy: row.order.reviewedBy,
    reviewedByName: null,
    cancelledReason: row.order.cancelledReason,
    result: row.result ? serialiseResult(row.result, null) : null,
  };
}

function serialiseResult(
  result: typeof schema.labResult.$inferSelect,
  enteredByName: string | null,
) {
  return {
    id: result.id,
    valueNumeric: numberOrNull(result.valueNumeric),
    valueText: result.valueText,
    unit: result.unit,
    referenceLow: numberOrNull(result.referenceLow),
    referenceHigh: numberOrNull(result.referenceHigh),
    interpretation: result.interpretation,
    specimenAt: result.specimenAt?.toISOString() ?? null,
    resultedAt: result.resultedAt.toISOString(),
    performedBy: result.performedBy,
    labNote: result.labNote,
    documentId: result.documentId,
    supersededAt: result.supersededAt?.toISOString() ?? null,
    supersededReason: result.supersededReason,
    enteredBy: result.enteredBy,
    enteredByName,
  };
}

/** Postgres `numeric` arrives as a string. */
function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}
