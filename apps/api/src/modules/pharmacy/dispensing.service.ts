import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import {
  suggestedQuantity,
  type AnswerClarification,
  type ClarificationRow,
  type DispenseDetail,
  type DispenseQueueRow,
  type DispenseStatus,
  type FillLine,
  type RaiseClarification,
} from '@emr/contracts';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { StockService, normalise } from './stock.service';
import { EventHub } from '../../common/events/event-hub.service';

/**
 * Prescription to dispense.
 *
 * THE ONE RULE. `medication_request` is read here and never written. What the
 * counter records is a `dispense_line` — a separate fact about what was actually
 * handed over, which may differ from the order and must never be achieved by
 * editing it. The database enforces the same thing with a trigger, because a
 * permission matrix protects against the wrong ROLE and a trigger protects
 * against the wrong CODE.
 *
 * ZERO RE-ENTRY, which is the blueprint's §12 gap #2 and the reason this module
 * is worth building at all. When a doctor finalises an encounter, `enqueue()`
 * copies every prescribed line into a dispense record with the ordered drug, the
 * frequency, the duration and a suggested quantity already computed. A pharmacist
 * picks a batch and confirms; nobody retypes a prescription from a PDF.
 */
@Injectable()
export class DispensingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly stock: StockService,
    private readonly events: EventHub,
  ) {}

  /* ---- Entering the queue ------------------------------------------------- */

  /**
   * Puts a finalised encounter's prescription on the counter's queue.
   *
   * Called from the clinical module at finalisation, inside that transaction, so
   * a prescription cannot be signed without reaching the pharmacy — and cannot
   * reach the pharmacy if the signing fails.
   *
   * IDEMPOTENT. A unique index on (clinic, encounter) means finalising twice, or
   * amending, cannot produce two queue entries for one prescription. Returns null
   * when there is nothing to dispense, which is the common case: most
   * consultations at a small clinic prescribe nothing at all.
   */
  async enqueue(tx: TenantTx, encounterId: string): Promise<string | null> {
    const ctx = TenantContext.require();

    const orders = await tx
      .select({
        id: schema.medicationRequest.id,
        patientId: schema.medicationRequest.patientId,
        drugDisplayName: schema.medicationRequest.drugDisplayName,
        frequency: schema.medicationRequest.frequency,
        durationDays: schema.medicationRequest.durationDays,
        quantity: schema.medicationRequest.quantity,
      })
      .from(schema.medicationRequest)
      .where(
        and(
          eq(schema.medicationRequest.encounterId, encounterId),
          // A cancelled or erroneous line is not dispensed. DRAFT is excluded
          // too: finalisation promotes the lines it means to ACTIVE.
          inArray(schema.medicationRequest.status, ['ACTIVE', 'ON_HOLD']),
        ),
      );

    if (orders.length === 0) return null;

    const [existing] = await tx
      .select({ id: schema.dispenseRecord.id })
      .from(schema.dispenseRecord)
      .where(eq(schema.dispenseRecord.encounterId, encounterId))
      .limit(1);

    if (existing) return existing.id;

    const [record] = await tx
      .insert(schema.dispenseRecord)
      .values({
        clinicId: ctx.clinicId,
        patientId: orders[0]!.patientId,
        encounterId,
        status: 'PENDING',
        queuedAt: new Date(),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .returning({ id: schema.dispenseRecord.id });

    await tx.insert(schema.dispenseLine).values(
      orders.map((order) => ({
        clinicId: ctx.clinicId,
        dispenseRecordId: record!.id,
        medicationRequestId: order.id,
        /*
         * The quantity is COPIED and, where the prescription did not state one,
         * DERIVED from the frequency and duration.
         *
         * `suggestedQuantity` answers only where it is certain — "1-0-1" for
         * five days is ten — and returns null otherwise. A wrong quantity on a
         * controlled medicine is worse than a blank one a pharmacist fills in,
         * so a pattern it does not recognise stays empty rather than guessed.
         */
        quantityPrescribed:
          order.quantity ??
          (suggestedQuantity(order.frequency, order.durationDays)?.toString() ?? null),
        quantityDispensed: 0,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })),
    );

    return record!.id;
  }

  /* ---- The queue ---------------------------------------------------------- */

  /**
   * What is waiting at the counter.
   *
   * Carries the patient's name, age and allergies and nothing else clinical.
   * That is not a compromise — it is exactly what is needed to hand the right
   * medicine to the right person. The consultation note, the diagnosis and the
   * history are absent because none of them are needed, and the PHARMACIST role
   * holds no permission that would return them anyway.
   */
  async queue(options: { status?: DispenseStatus; includeFinished?: boolean } = {}) {
    const rows = await this.tenantDb.runReadOnly(async (tx) => {
      const records = await tx
        .select({
          record: schema.dispenseRecord,
          patientName: schema.patient.fullName,
          patientMrn: schema.patient.mrn,
          patientAge: schema.patient.ageYears,
          patientDob: schema.patient.dateOfBirth,
          prescriberName: schema.appUser.fullName,
          waitingMinutes: sql<number>`
            extract(epoch from (now() - ${schema.dispenseRecord.queuedAt}))::int / 60
          `,
        })
        .from(schema.dispenseRecord)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.dispenseRecord.patientId))
        .innerJoin(schema.encounter, eq(schema.encounter.id, schema.dispenseRecord.encounterId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.encounter.practitionerId))
        .where(
          and(
            options.status ? eq(schema.dispenseRecord.status, options.status) : undefined,
            options.status || options.includeFinished
              ? undefined
              : sql`${schema.dispenseRecord.status} NOT IN ('DISPENSED', 'CANCELLED')`,
          ),
        )
        // Oldest first when open: the queue is a queue. Newest first when
        // showing completed work, which is a history rather than a queue.
        .orderBy(
          options.includeFinished
            ? desc(schema.dispenseRecord.queuedAt)
            : asc(schema.dispenseRecord.queuedAt),
        )
        .limit(200);

      if (records.length === 0) return [];

      const ids = records.map((r) => r.record.id);
      const patientIds = [...new Set(records.map((r) => r.record.patientId))];

      /* Item counts per record, in one query rather than one per row. */
      const counts = await tx
        .select({
          dispenseRecordId: schema.dispenseLine.dispenseRecordId,
          items: sql<number>`count(*)::int`,
          dispensed: sql<number>`count(*) FILTER (WHERE ${schema.dispenseLine.quantityDispensed} > 0)::int`,
        })
        .from(schema.dispenseLine)
        .where(inArray(schema.dispenseLine.dispenseRecordId, ids))
        .groupBy(schema.dispenseLine.dispenseRecordId);

      const open = await tx
        .select({
          dispenseRecordId: schema.rxClarification.dispenseRecordId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.rxClarification)
        .where(
          and(
            inArray(schema.rxClarification.dispenseRecordId, ids),
            eq(schema.rxClarification.status, 'OPEN'),
          ),
        )
        .groupBy(schema.rxClarification.dispenseRecordId);

      /*
       * Allergies, because this is the one clinical fact the counter must see.
       *
       * Dispensing amoxicillin to a penicillin-allergic patient is the precise
       * failure a pharmacy check exists to catch, and expecting the pharmacist
       * to open a record for it means it happens sometimes.
       */
      const allergies = await tx
        .select({
          patientId: schema.allergyIntolerance.patientId,
          substance: schema.allergyIntolerance.substanceText,
        })
        .from(schema.allergyIntolerance)
        .where(
          and(
            inArray(schema.allergyIntolerance.patientId, patientIds),
            // A refuted allergy is one the clinician ruled out. Showing it at
            // the counter would train pharmacists to ignore the strip.
            isNull(schema.allergyIntolerance.refutedAt),
          ),
        );

      const countBy = new Map(counts.map((c) => [c.dispenseRecordId, c]));
      const openBy = new Map(open.map((c) => [c.dispenseRecordId, c.n]));
      const allergyBy = new Map<string, string[]>();
      for (const row of allergies) {
        const list = allergyBy.get(row.patientId) ?? [];
        list.push(row.substance);
        allergyBy.set(row.patientId, list);
      }

      return records.map((row) => ({
        id: row.record.id,
        patientId: row.record.patientId,
        patientName: row.patientName,
        patientMrn: row.patientMrn,
        patientAgeYears: ageFrom(row.patientAge, row.patientDob),
        allergySummary: allergyBy.get(row.record.patientId) ?? [],
        encounterId: row.record.encounterId,
        prescriberName: row.prescriberName ?? 'Unknown',
        status: row.record.status,
        queuedAt: row.record.queuedAt.toISOString(),
        waitingMinutes: row.waitingMinutes,
        itemCount: countBy.get(row.record.id)?.items ?? 0,
        dispensedItemCount: countBy.get(row.record.id)?.dispensed ?? 0,
        openClarificationCount: openBy.get(row.record.id) ?? 0,
      }));
    });

    return rows satisfies DispenseQueueRow[];
  }

  /** One prescription, with every line, its clarifications and the batches that could fill it. */
  async detail(id: string): Promise<DispenseDetail> {
    const [head] = await this.queueRowsById([id]);
    if (!head) throw new NotFoundException('That prescription could not be found.');

    const lines = await this.tenantDb.runReadOnly(async (tx) => {
      const rows = await tx
        .select({
          line: schema.dispenseLine,
          order: schema.medicationRequest,
          productName: schema.pharmacyProduct.name,
          batchNumber: schema.stockBatch.batchNumber,
          expiryDate: schema.stockBatch.expiryDate,
        })
        .from(schema.dispenseLine)
        .innerJoin(
          schema.medicationRequest,
          eq(schema.medicationRequest.id, schema.dispenseLine.medicationRequestId),
        )
        .leftJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.dispenseLine.productId),
        )
        .leftJoin(schema.stockBatch, eq(schema.stockBatch.id, schema.dispenseLine.stockBatchId))
        .where(eq(schema.dispenseLine.dispenseRecordId, id))
        .orderBy(asc(schema.medicationRequest.authoredAt));

      const requestIds = rows.map((r) => r.order.id);

      const clarifications = requestIds.length
        ? await tx
            .select({
              c: schema.rxClarification,
              raisedByName: sql<string | null>`raiser.full_name`,
              answeredByName: sql<string | null>`answerer.full_name`,
            })
            .from(schema.rxClarification)
            .leftJoin(
              sql`${schema.appUser} AS raiser`,
              sql`raiser.id = ${schema.rxClarification.raisedBy}`,
            )
            .leftJoin(
              sql`${schema.appUser} AS answerer`,
              sql`answerer.id = ${schema.rxClarification.answeredBy}`,
            )
            .where(inArray(schema.rxClarification.medicationRequestId, requestIds))
            .orderBy(desc(schema.rxClarification.raisedAt))
        : [];

      const byRequest = new Map<string, typeof clarifications>();
      for (const row of clarifications) {
        const list = byRequest.get(row.c.medicationRequestId) ?? [];
        list.push(row);
        byRequest.set(row.c.medicationRequestId, list);
      }

      return { rows, byRequest };
    });

    /* Batch options are looked up per line, outside the read transaction. */
    const detailed = await Promise.all(
      lines.rows.map(async (row) => ({
        id: row.line.id,
        medicationRequestId: row.order.id,

        orderedDrugName: row.order.drugDisplayName,
        orderedMolecule: row.order.moleculeName,
        orderedStrength: row.order.strength,
        orderedDosageForm: row.order.dosageForm,
        orderedRoute: row.order.route,
        frequency: row.order.frequency,
        durationDays: row.order.durationDays,
        instructions: row.order.instructions,
        timingRelativeToFood: row.order.timingRelativeToFood,

        productId: row.line.productId,
        productName: row.productName,
        stockBatchId: row.line.stockBatchId,
        batchNumber: row.batchNumber,
        expiryDate: row.expiryDate,
        quantityPrescribed: row.line.quantityPrescribed
          ? Number(row.line.quantityPrescribed)
          : null,
        quantityDispensed: row.line.quantityDispensed,
        isSubstitution: row.line.isSubstitution,
        substitutionReason: row.line.substitutionReason,
        unitPricePaise: row.line.unitPricePaise,
        gstRateBps: row.line.gstRateBps,
        lineTotalPaise: row.line.lineTotalPaise,
        notDispensedReason: row.line.notDispensedReason,

        clarifications: (lines.byRequest.get(row.order.id) ?? []).map((c) => ({
          id: c.c.id,
          status: c.c.status,
          question: c.c.question,
          raisedByName: c.raisedByName,
          raisedAt: c.c.raisedAt.toISOString(),
          answer: c.c.answer,
          answeredByName: c.answeredByName,
          answeredAt: c.c.answeredAt?.toISOString() ?? null,
          resolutionAction: c.c.resolutionAction as never,
        })),

        availableBatches: await this.stock.batchesFor({
          catalogueItemId: row.order.catalogueItemId,
          moleculeName: row.order.moleculeName ?? row.order.drugDisplayName,
        }),
      })),
    );

    const sale = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ id: schema.pharmacySale.id, total: schema.pharmacySale.totalPaise })
        .from(schema.pharmacySale)
        .where(
          and(
            eq(schema.pharmacySale.dispenseRecordId, id),
            eq(schema.pharmacySale.status, 'COMPLETED'),
          ),
        )
        .limit(1),
    );

    const record = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          notes: schema.dispenseRecord.notes,
          startedAt: schema.dispenseRecord.startedAt,
          completedAt: schema.dispenseRecord.completedAt,
          cancelledReason: schema.dispenseRecord.cancelledReason,
          dispensedByName: schema.appUser.fullName,
        })
        .from(schema.dispenseRecord)
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.dispenseRecord.dispensedBy))
        .where(eq(schema.dispenseRecord.id, id))
        .limit(1),
    );

    return {
      ...head,
      notes: record[0]?.notes ?? null,
      startedAt: record[0]?.startedAt?.toISOString() ?? null,
      completedAt: record[0]?.completedAt?.toISOString() ?? null,
      dispensedByName: record[0]?.dispensedByName ?? null,
      cancelledReason: record[0]?.cancelledReason ?? null,
      lines: detailed as never,
      saleId: sale[0]?.id ?? null,
      saleTotalPaise: sale[0]?.total ?? null,
    };
  }

  /* ---- Working the counter ------------------------------------------------ */

  /** Claims a prescription, so two people do not prepare the same one. */
  async start(id: string) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const record = await this.requireRecord(tx, id);
      if (record.status === 'DISPENSED' || record.status === 'CANCELLED') {
        throw new ConflictException('That prescription is already closed.');
      }

      await tx
        .update(schema.dispenseRecord)
        .set({
          status: record.status === 'PENDING' ? 'IN_PROGRESS' : record.status,
          startedAt: record.startedAt ?? new Date(),
          dispensedBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.dispenseRecord.id, id));

      return { started: true };
    });
  }

  /**
   * Records what was handed over for one line.
   *
   * The substitution check is the interesting part. A pharmacist may hand over a
   * different BRAND of the same molecule freely — that is normal practice and not
   * a substitution in any sense a prescriber would recognise. A different
   * MOLECULE is a different matter, and this refuses it without a reason, because
   * the alternative is a silent change to what the doctor decided.
   */
  async fillLine(lineId: string, input: FillLine) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [line] = await tx
        .select({
          line: schema.dispenseLine,
          order: schema.medicationRequest,
        })
        .from(schema.dispenseLine)
        .innerJoin(
          schema.medicationRequest,
          eq(schema.medicationRequest.id, schema.dispenseLine.medicationRequestId),
        )
        .where(eq(schema.dispenseLine.id, lineId))
        .limit(1);

      if (!line) throw new NotFoundException('That prescription line could not be found.');

      const record = await this.requireRecord(tx, line.line.dispenseRecordId);
      if (record.status === 'DISPENSED' || record.status === 'CANCELLED') {
        throw new ConflictException(
          'That prescription is closed. Reopen it before changing what was dispensed.',
        );
      }

      /* Declining a line: no batch, no quantity, and a reason is required. */
      if (input.quantityDispensed === 0) {
        if (!input.notDispensedReason?.trim()) {
          throw new UnprocessableEntityException({
            title: 'Say why it was not dispensed',
            message:
              'A line left undispensed needs a reason — out of stock, patient declined, or a clarification is open.',
          });
        }

        await this.reverseExisting(tx, line.line, record.id);

        await tx
          .update(schema.dispenseLine)
          .set({
            quantityDispensed: 0,
            stockBatchId: null,
            productId: null,
            lineTotalPaise: 0,
            notDispensedReason: input.notDispensedReason.trim(),
            updatedBy: ctx.userId,
          })
          .where(eq(schema.dispenseLine.id, lineId));

        await this.recomputeStatus(tx, record.id);
        return { dispensed: 0 };
      }

      if (!input.stockBatchId) {
        throw new UnprocessableEntityException({
          title: 'Choose a batch',
          message:
            'Dispensing needs the batch it came from — it is what connects this patient to a recall notice.',
        });
      }

      const [batch] = await tx
        .select({
          batch: schema.stockBatch,
          productMolecule: schema.pharmacyProduct.moleculeName,
          productCatalogueId: schema.pharmacyProduct.catalogueItemId,
          productId: schema.pharmacyProduct.id,
          gstRateBps: schema.pharmacyProduct.gstRateBps,
          mrpPaise: schema.pharmacyProduct.mrpPaise,
          requiresPrescription: schema.pharmacyProduct.requiresPrescription,
        })
        .from(schema.stockBatch)
        .innerJoin(
          schema.pharmacyProduct,
          eq(schema.pharmacyProduct.id, schema.stockBatch.productId),
        )
        .where(eq(schema.stockBatch.id, input.stockBatchId))
        .limit(1);

      if (!batch) throw new NotFoundException('That batch could not be found.');

      /*
       * An expired batch is refused outright.
       *
       * Checked against the database's date, not the caller's: a counter machine
       * with a wrong clock must not be able to dispense expired stock by
       * disagreeing about what day it is.
       */
      const [clock] = await tx.execute<{ expired: boolean }>(
        sql`SELECT ${batch.batch.expiryDate}::date < current_date AS expired`,
      ).then((r) => r.rows);

      if (clock?.expired) {
        throw new ConflictException(
          'That batch has expired. Write it off from the alerts screen and pick another.',
        );
      }

      /* Is this the same drug the doctor ordered? */
      const sameCatalogueItem =
        line.order.catalogueItemId !== null &&
        batch.productCatalogueId === line.order.catalogueItemId;
      const sameMolecule =
        normalise(batch.productMolecule ?? '') ===
        normalise(line.order.moleculeName ?? line.order.drugDisplayName);

      const isSubstitution = !sameCatalogueItem && !sameMolecule;

      if (isSubstitution && !input.substitutionReason?.trim()) {
        throw new UnprocessableEntityException({
          title: 'A substitution needs a reason',
          message:
            'This product is not the molecule that was prescribed. Record why, or raise a clarification with the prescriber.',
        });
      }

      /* Reverse whatever this line dispensed before, then issue the new amount. */
      await this.reverseExisting(tx, line.line, record.id);

      await this.stock.move(tx, {
        stockBatchId: input.stockBatchId,
        movementType: 'DISPENSE',
        quantityDelta: -input.quantityDispensed,
        referenceType: 'DISPENSE',
        referenceId: record.id,
      });

      const unitPrice = input.unitPricePaise ?? batch.batch.mrpPaise ?? batch.mrpPaise ?? 0;

      await tx
        .update(schema.dispenseLine)
        .set({
          productId: batch.productId,
          stockBatchId: input.stockBatchId,
          quantityDispensed: input.quantityDispensed,
          isSubstitution,
          substitutionReason: isSubstitution ? input.substitutionReason!.trim() : null,
          unitPricePaise: unitPrice,
          gstRateBps: batch.gstRateBps,
          lineTotalPaise: unitPrice * input.quantityDispensed,
          notDispensedReason: null,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.dispenseLine.id, lineId));

      await this.recomputeStatus(tx, record.id);

      return { dispensed: input.quantityDispensed, isSubstitution };
    });
  }

  /** Closes a prescription. Refuses while a question is still open. */
  async complete(id: string) {
    const ctx = TenantContext.require();

    const result = await this.tenantDb.run(async (tx) => {
      const record = await this.requireRecord(tx, id);

      const [open] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.rxClarification)
        .where(
          and(
            eq(schema.rxClarification.dispenseRecordId, id),
            eq(schema.rxClarification.status, 'OPEN'),
          ),
        );

      if ((open?.n ?? 0) > 0) {
        throw new ConflictException(
          'A question to the prescriber is still open. Wait for the answer, or withdraw the question.',
        );
      }

      const lines = await tx
        .select({
          quantityDispensed: schema.dispenseLine.quantityDispensed,
          notDispensedReason: schema.dispenseLine.notDispensedReason,
        })
        .from(schema.dispenseLine)
        .where(eq(schema.dispenseLine.dispenseRecordId, id));

      const undecided = lines.filter(
        (l) => l.quantityDispensed === 0 && !l.notDispensedReason,
      );
      if (undecided.length > 0) {
        throw new ConflictException(
          `${undecided.length} item${undecided.length === 1 ? '' : 's'} on this prescription has neither been dispensed nor explained.`,
        );
      }

      const anyDispensed = lines.some((l) => l.quantityDispensed > 0);
      const allDispensed = lines.every((l) => l.quantityDispensed > 0);

      await tx
        .update(schema.dispenseRecord)
        .set({
          status: allDispensed ? 'DISPENSED' : anyDispensed ? 'PARTIAL' : 'DISPENSED',
          completedAt: new Date(),
          dispensedBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.dispenseRecord.id, id));

      return { patientId: record.patientId, status: allDispensed ? 'DISPENSED' : 'PARTIAL' };
    });

    /*
     * Announced after the transaction commits, never inside it.
     *
     * A subscriber that reads the record must not be able to arrive before the
     * write is visible — which is exactly what happens if the event is published
     * from inside the transaction.
     */
    this.events.emit({
      type: 'rx-dispensed',
      clinicId: TenantContext.require().clinicId,
      data: { dispenseRecordId: id, status: result.status },
    });

    return { completed: true, status: result.status };
  }

  /** Reopens a closed prescription, e.g. the patient returned for the rest. */
  async reopen(id: string) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const record = await this.requireRecord(tx, id);
      if (record.status === 'CANCELLED') {
        throw new ConflictException('A cancelled prescription cannot be reopened.');
      }

      await tx
        .update(schema.dispenseRecord)
        .set({ status: 'IN_PROGRESS', completedAt: null, updatedBy: ctx.userId })
        .where(eq(schema.dispenseRecord.id, id));

      return { reopened: true };
    });
  }

  async cancel(id: string, reason: string) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const record = await this.requireRecord(tx, id);
      if (record.status === 'CANCELLED') return { cancelled: true };

      /* Anything already issued goes back on the shelf. */
      const lines = await tx
        .select()
        .from(schema.dispenseLine)
        .where(eq(schema.dispenseLine.dispenseRecordId, id));

      for (const line of lines) {
        await this.reverseExisting(tx, line, id);
        await tx
          .update(schema.dispenseLine)
          .set({ quantityDispensed: 0, lineTotalPaise: 0, updatedBy: ctx.userId })
          .where(eq(schema.dispenseLine.id, line.id));
      }

      await tx
        .update(schema.dispenseRecord)
        .set({
          status: 'CANCELLED',
          cancelledReason: reason,
          completedAt: new Date(),
          updatedBy: ctx.userId,
        })
        .where(eq(schema.dispenseRecord.id, id));

      return { cancelled: true };
    });
  }

  /* ---- Clarifications ----------------------------------------------------- */

  /**
   * A question from the counter to the prescriber.
   *
   * Raising one moves the whole prescription to CLARIFICATION_NEEDED, which is
   * what makes it visible on the queue as stuck rather than merely slow. A
   * pharmacist should not have to remember which of eleven waiting prescriptions
   * is blocked on someone else.
   */
  async raiseClarification(dispenseRecordId: string, input: RaiseClarification) {
    const ctx = TenantContext.require();

    const created = await this.tenantDb.run(async (tx) => {
      const record = await this.requireRecord(tx, dispenseRecordId);

      const [line] = await tx
        .select({ id: schema.dispenseLine.id })
        .from(schema.dispenseLine)
        .where(
          and(
            eq(schema.dispenseLine.dispenseRecordId, dispenseRecordId),
            eq(schema.dispenseLine.medicationRequestId, input.medicationRequestId),
          ),
        )
        .limit(1);

      if (!line) {
        throw new UnprocessableEntityException({
          title: 'That item is not on this prescription',
          message: 'Reload the prescription and try again.',
        });
      }

      const [clarification] = await tx
        .insert(schema.rxClarification)
        .values({
          clinicId: ctx.clinicId,
          medicationRequestId: input.medicationRequestId,
          dispenseRecordId,
          status: 'OPEN',
          question: input.question.trim(),
          raisedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning({ id: schema.rxClarification.id });

      await tx
        .update(schema.dispenseRecord)
        .set({ status: 'CLARIFICATION_NEEDED', updatedBy: ctx.userId })
        .where(eq(schema.dispenseRecord.id, dispenseRecordId));

      /*
       * A task for the prescriber as well as a clarification row.
       *
       * The clarification is the record; the task is what makes a doctor see it
       * without opening the pharmacy panel, which they have no permission to do.
       */
      await tx.insert(schema.task).values({
        clinicId: ctx.clinicId,
        taskType: 'PHARMACY_CLARIFICATION',
        title: 'Pharmacy has a question about a prescription',
        description: input.question.trim(),
        patientId: record.patientId,
        encounterId: record.encounterId,
        focusResourceType: 'medication_request',
        focusResourceId: input.medicationRequestId,
        status: 'REQUESTED',
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });

      return clarification!.id;
    });

    this.events.emit({
      type: 'rx-clarification',
      clinicId: ctx.clinicId,
      data: { clarificationId: created, dispenseRecordId, state: 'raised' },
    });

    return { id: created };
  }

  /** Answered by the prescriber, never by whoever asked. */
  async answerClarification(id: string, input: AnswerClarification) {
    const ctx = TenantContext.require();

    const result = await this.tenantDb.run(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.rxClarification)
        .where(eq(schema.rxClarification.id, id))
        .limit(1);

      if (!existing) throw new NotFoundException('That question could not be found.');
      if (existing.status !== 'OPEN') {
        throw new ConflictException('That question has already been closed.');
      }

      /*
       * The asker cannot answer their own question.
       *
       * The permission matrix already separates `clarification:create` from
       * `:resolve`, so a pharmacist cannot reach this handler at all. This guards
       * the remaining case: a doctor who raised a query while also holding
       * prescribing rights closing their own loop, which would make the record
       * say a prescriber confirmed something nobody independently confirmed.
       */
      if (existing.raisedBy === ctx.userId) {
        throw new ForbiddenException(
          'The person who raised a question cannot answer it. Ask the prescriber.',
        );
      }

      await tx
        .update(schema.rxClarification)
        .set({
          status: 'ANSWERED',
          answer: input.answer.trim(),
          resolutionAction: input.resolutionAction,
          answeredBy: ctx.userId,
          answeredAt: new Date(),
          updatedBy: ctx.userId,
        })
        .where(eq(schema.rxClarification.id, id));

      /* Close the task that pushed it to the doctor. */
      await tx
        .update(schema.task)
        .set({
          status: 'COMPLETED',
          completedAt: new Date(),
          completedBy: ctx.userId,
          resolutionNotes: input.answer.trim(),
          updatedBy: ctx.userId,
        })
        .where(
          and(
            eq(schema.task.focusResourceId, existing.medicationRequestId),
            eq(schema.task.taskType, 'PHARMACY_CLARIFICATION'),
            eq(schema.task.status, 'REQUESTED'),
          ),
        );

      if (existing.dispenseRecordId) {
        await this.releaseIfNothingOpen(tx, existing.dispenseRecordId);
      }

      return existing.dispenseRecordId;
    });

    if (result) {
      this.events.emit({
        type: 'rx-clarification',
        clinicId: ctx.clinicId,
        data: { clarificationId: id, dispenseRecordId: result, state: 'answered' },
      });
    }

    return { answered: true };
  }

  /** The pharmacist resolved it themselves; the trace stays. */
  async withdrawClarification(id: string, reason: string) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.rxClarification)
        .where(eq(schema.rxClarification.id, id))
        .limit(1);

      if (!existing) throw new NotFoundException('That question could not be found.');
      if (existing.status !== 'OPEN') {
        throw new ConflictException('That question has already been closed.');
      }

      await tx
        .update(schema.rxClarification)
        .set({
          status: 'WITHDRAWN',
          withdrawnReason: reason,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.rxClarification.id, id));

      if (existing.dispenseRecordId) {
        await this.releaseIfNothingOpen(tx, existing.dispenseRecordId);
      }

      return { withdrawn: true };
    });
  }

  /**
   * The clarification list.
   *
   * Serves two audiences from one query: the counter's "what am I waiting on"
   * and the doctor's "what must I answer". The caller narrows by status.
   */
  async clarifications(options: { status?: 'OPEN' | 'ANSWERED' | 'WITHDRAWN' } = {}) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          c: schema.rxClarification,
          order: schema.medicationRequest,
          patientName: schema.patient.fullName,
          patientAge: schema.patient.ageYears,
          patientDob: schema.patient.dateOfBirth,
          prescriberName: sql<string | null>`prescriber.full_name`,
          raisedByName: sql<string | null>`raiser.full_name`,
          answeredByName: sql<string | null>`answerer.full_name`,
          waitingMinutes: sql<number>`
            extract(epoch from (now() - ${schema.rxClarification.raisedAt}))::int / 60
          `,
        })
        .from(schema.rxClarification)
        .innerJoin(
          schema.medicationRequest,
          eq(schema.medicationRequest.id, schema.rxClarification.medicationRequestId),
        )
        .innerJoin(schema.patient, eq(schema.patient.id, schema.medicationRequest.patientId))
        .leftJoin(
          sql`${schema.appUser} AS prescriber`,
          sql`prescriber.id = ${schema.medicationRequest.practitionerId}`,
        )
        .leftJoin(
          sql`${schema.appUser} AS raiser`,
          sql`raiser.id = ${schema.rxClarification.raisedBy}`,
        )
        .leftJoin(
          sql`${schema.appUser} AS answerer`,
          sql`answerer.id = ${schema.rxClarification.answeredBy}`,
        )
        .where(options.status ? eq(schema.rxClarification.status, options.status) : undefined)
        .orderBy(asc(schema.rxClarification.raisedAt))
        .limit(200),
    );

    return rows.map((row) => ({
      id: row.c.id,
      status: row.c.status,
      question: row.c.question,
      answer: row.c.answer,
      resolutionAction: row.c.resolutionAction as never,
      raisedByName: row.raisedByName,
      raisedAt: row.c.raisedAt.toISOString(),
      answeredByName: row.answeredByName,
      answeredAt: row.c.answeredAt?.toISOString() ?? null,
      medicationRequestId: row.order.id,
      drugDisplayName: row.order.drugDisplayName,
      strength: row.order.strength,
      frequency: row.order.frequency,
      patientId: row.order.patientId,
      patientName: row.patientName,
      patientAgeYears: ageFrom(row.patientAge, row.patientDob),
      prescriberName: row.prescriberName ?? 'Unknown',
      dispenseRecordId: row.c.dispenseRecordId,
      waitingMinutes: row.waitingMinutes,
    })) satisfies ClarificationRow[];
  }

  /** Open clarifications a given doctor must answer. Drives the Doctor home card. */
  async openForPrescriber(practitionerId: string): Promise<ClarificationRow[]> {
    const all = await this.clarifications({ status: 'OPEN' });
    const mine = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ id: schema.medicationRequest.id })
        .from(schema.medicationRequest)
        .where(eq(schema.medicationRequest.practitionerId, practitionerId)),
    );
    const ids = new Set(mine.map((m) => m.id));
    return all.filter((row) => ids.has(row.medicationRequestId));
  }

  /* ---- Internals ---------------------------------------------------------- */

  private async queueRowsById(ids: string[]): Promise<DispenseQueueRow[]> {
    const all = await this.queue({ includeFinished: true });
    return all.filter((row) => ids.includes(row.id));
  }

  private async requireRecord(tx: TenantTx, id: string) {
    const [record] = await tx
      .select()
      .from(schema.dispenseRecord)
      .where(eq(schema.dispenseRecord.id, id))
      .limit(1);
    if (!record) throw new NotFoundException('That prescription could not be found.');
    return record;
  }

  /**
   * Puts back whatever a line had already issued.
   *
   * Called before every re-fill so that correcting a mistake at the counter —
   * wrong batch, wrong count — does not quietly lose stock. The reversal is its
   * own ledger row rather than an edit to the original, because the ledger is
   * append-only and because "issued 10, put 10 back, issued 8" is the truth.
   */
  private async reverseExisting(
    tx: TenantTx,
    line: typeof schema.dispenseLine.$inferSelect,
    recordId: string,
  ) {
    if (line.quantityDispensed <= 0 || !line.stockBatchId) return;

    await this.stock.move(tx, {
      stockBatchId: line.stockBatchId,
      movementType: 'DISPENSE',
      quantityDelta: line.quantityDispensed,
      reason: 'Correction at the counter — previous quantity returned to stock',
      referenceType: 'DISPENSE',
      referenceId: recordId,
    });
  }

  /** Moves a record out of CLARIFICATION_NEEDED once nothing is open on it. */
  private async releaseIfNothingOpen(tx: TenantTx, dispenseRecordId: string) {
    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.rxClarification)
      .where(
        and(
          eq(schema.rxClarification.dispenseRecordId, dispenseRecordId),
          eq(schema.rxClarification.status, 'OPEN'),
        ),
      );

    if ((open?.n ?? 0) > 0) return;

    await tx
      .update(schema.dispenseRecord)
      .set({ status: 'IN_PROGRESS' })
      .where(
        and(
          eq(schema.dispenseRecord.id, dispenseRecordId),
          eq(schema.dispenseRecord.status, 'CLARIFICATION_NEEDED'),
        ),
      );
  }

  /** Keeps the record's status honest as lines are filled one at a time. */
  private async recomputeStatus(tx: TenantTx, recordId: string) {
    const lines = await tx
      .select({
        quantityDispensed: schema.dispenseLine.quantityDispensed,
        notDispensedReason: schema.dispenseLine.notDispensedReason,
      })
      .from(schema.dispenseLine)
      .where(eq(schema.dispenseLine.dispenseRecordId, recordId));

    const [current] = await tx
      .select({ status: schema.dispenseRecord.status })
      .from(schema.dispenseRecord)
      .where(eq(schema.dispenseRecord.id, recordId))
      .limit(1);

    // A blocked prescription stays blocked; a filled line does not unblock it.
    if (current?.status === 'CLARIFICATION_NEEDED') return;

    const decided = lines.filter((l) => l.quantityDispensed > 0 || l.notDispensedReason);
    const next: DispenseStatus =
      decided.length === 0
        ? 'IN_PROGRESS'
        : decided.length === lines.length
          ? 'READY'
          : 'IN_PROGRESS';

    await tx
      .update(schema.dispenseRecord)
      .set({ status: next })
      .where(
        and(
          eq(schema.dispenseRecord.id, recordId),
          sql`${schema.dispenseRecord.status} NOT IN ('DISPENSED', 'CANCELLED')`,
        ),
      );
  }
}

/**
 * Age, from whichever the record has.
 *
 * A date of birth is preferred and often absent: walk-in registration at an
 * Indian clinic routinely captures "about 45" and nothing more, which is why
 * `patient` carries both columns.
 */
function ageFrom(ageYears: number | null, dateOfBirth: string | null): number | null {
  if (dateOfBirth) {
    const dob = new Date(`${dateOfBirth}T00:00:00`);
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const month = now.getMonth() - dob.getMonth();
    if (month < 0 || (month === 0 && now.getDate() < dob.getDate())) age -= 1;
    return age;
  }
  return ageYears;
}
