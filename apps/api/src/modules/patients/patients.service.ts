import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '@emr/db/schema';
import {
  normalisePhone,
  type DuplicateCheckResult,
  type Patient,
  type PatientSnapshot,
  type PatientSummary,
} from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';

/**
 * Tokens proving a duplicate search ran.
 *
 * Search-before-create is a workflow rule enforced by the SERVER, not a UI
 * convention: a client that skips the check cannot register a patient. One
 * mobile number routinely serves a whole family here, and a split record means
 * allergies and history are invisible at the point of prescribing.
 */
const searchTokens = new Map<string, number>();
const SEARCH_TOKEN_TTL_MS = 30 * 60 * 1000;

@Injectable()
export class PatientsService {
  constructor(private readonly tenantDb: TenantDb) {}

  async list(query: string, limit = 50): Promise<PatientSummary[]> {
    const rows = await this.tenantDb.runReadOnly(async (tx) => {
      const term = query.trim();
      const digits = term.replace(/\D/g, '');

      const base = tx
        .select()
        .from(schema.patient)
        .where(isNull(schema.patient.mergedIntoPatientId))
        .orderBy(schema.patient.fullName)
        .limit(limit);

      if (!term) return base;

      return tx
        .select()
        .from(schema.patient)
        .where(
          and(
            isNull(schema.patient.mergedIntoPatientId),
            or(
              sql`${schema.patient.nameNormalized} % ${term.toLowerCase()}`,
              sql`${schema.patient.nameNormalized} ILIKE ${'%' + term.toLowerCase() + '%'}`,
              sql`${schema.patient.mrn} ILIKE ${'%' + term + '%'}`,
              digits.length >= 4
                ? sql`${schema.patient.mobileE164} LIKE ${'%' + digits + '%'}`
                : sql`false`,
            ),
          ),
        )
        .orderBy(schema.patient.fullName)
        .limit(limit);
    });

    return this.summarise(rows);
  }

  async byId(id: string): Promise<Patient> {
    const row = await this.tenantDb.runReadOnly(async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.patient)
        .where(eq(schema.patient.id, id))
        .limit(1);
      return found;
    });

    if (!row) throw new NotFoundException('That patient record could not be found.');
    return row as unknown as Patient;
  }

  /**
   * Search before create.
   *
   * Returns everyone already registered on the number as a picker — a family
   * sharing one handset is normal, not an error — plus fuzzy matches elsewhere,
   * because transliteration is unstable: Mohd, Mohammed, Muhammad.
   */
  async duplicateCheck(mobileRaw: string, name: string): Promise<DuplicateCheckResult> {
    const mobile = normalisePhone(mobileRaw ?? '');
    const trimmedName = (name ?? '').trim();

    const { onSameMobile, similar } = await this.tenantDb.runReadOnly(async (tx) => {
      const onSameMobile = mobile
        ? await tx
            .select()
            .from(schema.patient)
            .where(
              and(
                eq(schema.patient.mobileE164, mobile),
                isNull(schema.patient.mergedIntoPatientId),
              ),
            )
        : [];

      const similar = trimmedName
        ? await tx
            .select({
              patient: schema.patient,
              score: sql<number>`similarity(${schema.patient.nameNormalized}, ${trimmedName.toLowerCase()})`,
            })
            .from(schema.patient)
            .where(
              and(
                isNull(schema.patient.mergedIntoPatientId),
                sql`similarity(${schema.patient.nameNormalized}, ${trimmedName.toLowerCase()}) > 0.35`,
              ),
            )
            .orderBy(sql`similarity(${schema.patient.nameNormalized}, ${trimmedName.toLowerCase()}) DESC`)
            .limit(5)
        : [];

      return { onSameMobile, similar };
    });

    const token = randomUUID();
    searchTokens.set(token, Date.now() + SEARCH_TOKEN_TTL_MS);
    sweepTokens();

    const onSameMobileIds = new Set(onSameMobile.map((p) => p.id));

    return {
      searchToken: token,
      onSameMobile: await this.summarise(onSameMobile),
      similar: await Promise.all(
        similar
          .filter((row) => !onSameMobileIds.has(row.patient.id))
          .map(async (row) => ({
            patient: (await this.summarise([row.patient]))[0]!,
            reasons: ['SIMILAR_NAME' as const],
            nameSimilarity: Number(Number(row.score).toFixed(2)),
          })),
      ),
    };
  }

  async register(input: Record<string, unknown>): Promise<Patient> {
    const token = input.searchToken as string | undefined;
    const expiry = token ? searchTokens.get(token) : undefined;

    if (!token || !expiry || expiry < Date.now()) {
      throw new UnprocessableEntityException(
        'Search for the patient before creating a new record. One mobile number often covers a whole family.',
      );
    }
    searchTokens.delete(token);

    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const mrn = await this.nextMrn(tx);

      const [created] = await tx
        .insert(schema.patient)
        .values({
          clinicId: ctx.clinicId,
          mrn,
          fullName: String(input.fullName ?? '').trim(),
          // Written by trigger, but NOT NULL — supply a value so the insert is
          // valid before the trigger normalises it.
          nameNormalized: String(input.fullName ?? '').trim().toLowerCase(),
          mobileE164: (input.mobileE164 as string) ?? null,
          mobileBelongsToRelative: Boolean(input.mobileBelongsToRelative),
          gender: (input.gender as 'MALE') ?? 'UNKNOWN',
          dateOfBirth: (input.dateOfBirth as string) ?? null,
          ageYears: (input.ageYears as number) ?? null,
          // A stated age is only meaningful with the date it was stated —
          // otherwise it silently rots and corrupts paediatric dosing.
          ageRecordedAt: input.ageYears ? new Date().toISOString().slice(0, 10) : null,
          email: (input.email as string) ?? null,
          bloodGroup: (input.bloodGroup as string) ?? null,
          addressLine1: (input.addressLine1 as string) ?? null,
          city: (input.city as string) ?? null,
          state: (input.state as string) ?? null,
          pincode: (input.pincode as string) ?? null,
          emergencyContactName: (input.emergencyContactName as string) ?? null,
          emergencyContactPhoneE164: (input.emergencyContactPhoneE164 as string) ?? null,
          emergencyContactRelation: (input.emergencyContactRelation as string) ?? null,
          tags: (input.tags as string[]) ?? [],
          notes: (input.notes as string) ?? null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return created as unknown as Patient;
    });
  }

  async update(id: string, input: Record<string, unknown>, version?: number): Promise<Patient> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.patient)
        .where(eq(schema.patient.id, id))
        .limit(1);

      if (!current) throw new NotFoundException('That patient record could not be found.');

      // Optimistic concurrency. Two receptionists editing one patient is
      // routine; a silent last-write-wins is not acceptable on a clinical record.
      if (version !== undefined && version !== current.version) {
        throw new ConflictException(
          'Someone else changed this record while you were editing. Reload to see their version.',
        );
      }

      const patch: Record<string, unknown> = { updatedBy: ctx.userId };
      for (const key of [
        'fullName', 'mobileE164', 'mobileBelongsToRelative', 'gender', 'dateOfBirth',
        'email', 'bloodGroup', 'addressLine1', 'addressLine2', 'city', 'state',
        'pincode', 'clinicalAlert', 'emergencyContactName', 'emergencyContactPhoneE164',
        'emergencyContactRelation', 'tags', 'notes',
      ]) {
        if (key in input) patch[key] = input[key];
      }
      if (typeof patch.fullName === 'string') {
        patch.nameNormalized = patch.fullName.toLowerCase();
      }

      const [updated] = await tx
        .update(schema.patient)
        .set(patch)
        .where(eq(schema.patient.id, id))
        .returning();

      return updated as unknown as Patient;
    });
  }

  /**
   * The Snapshot.
   *
   * One aggregate read rather than six round trips, because the budget is a
   * full render in under a second — below that doctors stop opening it, and the
   * allergy lives here.
   */
  async snapshot(patientId: string): Promise<PatientSnapshot> {
    return this.tenantDb.runReadOnly(async (tx) => {
      const [patient] = await tx
        .select()
        .from(schema.patient)
        .where(eq(schema.patient.id, patientId))
        .limit(1);
      if (!patient) throw new NotFoundException('That patient record could not be found.');

      const [allergies, conditions, medications, vitals, encounters, documents, invoices] =
        await Promise.all([
          tx
            .select()
            .from(schema.allergyIntolerance)
            .where(
              and(
                eq(schema.allergyIntolerance.patientId, patientId),
                isNull(schema.allergyIntolerance.refutedAt),
              ),
            ),
          tx
            .select()
            .from(schema.condition)
            .where(
              and(
                eq(schema.condition.patientId, patientId),
                eq(schema.condition.clinicalStatus, 'ACTIVE'),
              ),
            ),
          tx
            .select()
            .from(schema.medicationRequest)
            .where(
              and(
                eq(schema.medicationRequest.patientId, patientId),
                eq(schema.medicationRequest.status, 'ACTIVE'),
              ),
            ),
          // Most recent value per distinct measurement.
          tx.execute(sql`
            SELECT DISTINCT ON (code) * FROM observation
            WHERE patient_id = ${patientId}::uuid
            ORDER BY code, effective_at DESC
          `),
          tx
            .select({ encounter: schema.encounter, practitioner: schema.appUser.fullName })
            .from(schema.encounter)
            .leftJoin(schema.appUser, eq(schema.appUser.id, schema.encounter.practitionerId))
            .where(eq(schema.encounter.patientId, patientId))
            .orderBy(desc(schema.encounter.startedAt))
            .limit(5),
          tx
            .select()
            .from(schema.documentReference)
            .where(eq(schema.documentReference.patientId, patientId))
            .orderBy(desc(schema.documentReference.createdAt))
            .limit(5),
          tx
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.patientId, patientId)),
        ]);

      const criticality = { HIGH: 0, UNABLE_TO_ASSESS: 1, LOW: 2 } as const;

      const diagnosesByEncounter = await tx
        .select({ encounterId: schema.condition.encounterId, text: schema.condition.displayText })
        .from(schema.condition)
        .where(eq(schema.condition.patientId, patientId));

      return {
        patientId,
        // Highest criticality first. The doctor reads the top of this list.
        allergies: allergies.sort(
          (a, b) => criticality[a.criticality] - criticality[b.criticality],
        ) as unknown as PatientSnapshot['allergies'],
        conditions: conditions.sort(
          (a, b) => Number(b.isChronic) - Number(a.isChronic),
        ) as unknown as PatientSnapshot['conditions'],
        activeMedications: medications as unknown as PatientSnapshot['activeMedications'],
        latestVitals: (vitals.rows ?? []).map(mapObservation) as never,
        recentEncounters: encounters.map((row) => ({
          id: row.encounter.id,
          startedAt: row.encounter.startedAt.toISOString(),
          practitionerName: row.practitioner ?? 'Unknown',
          chiefComplaint: row.encounter.chiefComplaint,
          diagnoses: diagnosesByEncounter
            .filter((d) => d.encounterId === row.encounter.id)
            .map((d) => d.text),
          isFinalized: row.encounter.isFinalized,
        })),
        recentDocuments: documents.map((d) => ({
          id: d.id,
          title: d.title,
          documentType: d.documentType,
          createdAt: d.createdAt.toISOString(),
        })),
        outstandingPaise: invoices.reduce(
          (sum, i) => sum + (Number(i.totalPaise) - Number(i.paidPaise)),
          0,
        ),
      } as PatientSnapshot;
    });
  }

  /**
   * Merge.
   *
   * Never automatic. An incorrect merge is considerably harder to unwind than a
   * duplicate, so a person confirms every one. Clinical rows are re-parented,
   * the merged record is kept permanently with a pointer to the survivor, and
   * the whole thing is recorded so a clinician can later reconstruct why a
   * history looks the way it does.
   */
  async merge(input: { survivingPatientId: string; mergedPatientId: string; reason: string }) {
    const ctx = TenantContext.require();

    if (input.survivingPatientId === input.mergedPatientId) {
      throw new UnprocessableEntityException('A record cannot be merged into itself.');
    }

    return this.tenantDb.run(async (tx) => {
      const [survivor] = await tx
        .select().from(schema.patient)
        .where(eq(schema.patient.id, input.survivingPatientId)).limit(1);
      const [merged] = await tx
        .select().from(schema.patient)
        .where(eq(schema.patient.id, input.mergedPatientId)).limit(1);

      if (!survivor || !merged) throw new NotFoundException('One of those records was not found.');
      if (merged.mergedIntoPatientId) {
        throw new ConflictException('That record has already been merged.');
      }

      const counts: Record<string, number> = {};
      for (const [name, table] of [
        ['encounter', schema.encounter],
        ['observation', schema.observation],
        ['condition', schema.condition],
        ['allergy', schema.allergyIntolerance],
        ['medicationRequest', schema.medicationRequest],
        ['documentReference', schema.documentReference],
        ['appointment', schema.appointment],
        ['invoice', schema.invoice],
      ] as const) {
        const moved = await tx
          .update(table as never)
          .set({ patientId: survivor.id } as never)
          .where(eq((table as never as { patientId: never }).patientId, merged.id))
          .returning({ id: (table as never as { id: never }).id });
        counts[name] = moved.length;
      }

      await tx.insert(schema.patientMergeLog).values({
        clinicId: ctx.clinicId,
        survivingPatientId: survivor.id,
        mergedPatientId: merged.id,
        reparentedCounts: counts,
        // The full record as it was, so the merge is reconstructable.
        mergedRecordSnapshot: merged as unknown as Record<string, unknown>,
        performedBy: ctx.userId,
        reason: input.reason,
        createdBy: ctx.userId,
      });

      // Kept, never deleted: an incorrect merge has to be traceable.
      await tx
        .update(schema.patient)
        .set({ mergedIntoPatientId: survivor.id, mergedAt: new Date(), updatedBy: ctx.userId })
        .where(eq(schema.patient.id, merged.id));

      return { survivingPatientId: survivor.id, reparented: counts };
    });
  }

  /** Adds the derived fields the list screens show. */
  private async summarise(rows: (typeof schema.patient.$inferSelect)[]): Promise<PatientSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const { allergic, lastVisits } = await this.tenantDb.runReadOnly(async (tx) => {
      // inArray, not `= ANY(${ids})`. A JS array interpolated into a `sql`
      // template is expanded into a placeholder LIST — `ANY(($2, $3, $4))` —
      // which is not valid SQL and fails at execution, not at compile time.
      const allergyRows = await tx
        .select({ patientId: schema.allergyIntolerance.patientId })
        .from(schema.allergyIntolerance)
        .where(
          and(
            eq(schema.allergyIntolerance.criticality, 'HIGH'),
            isNull(schema.allergyIntolerance.refutedAt),
            inArray(schema.allergyIntolerance.patientId, ids),
          ),
        );

      const visitRows = await tx
        .select({
          patientId: schema.encounter.patientId,
          // mapWith applies the column's driver decoder to the aggregate. A bare
          // `sql<Date>` is a type assertion only — the value arrives as whatever
          // the driver hands back, and the mismatch surfaces as a TypeError at
          // the first call site rather than at the query.
          last: sql<Date>`max(${schema.encounter.startedAt})`.mapWith(
            schema.encounter.startedAt,
          ),
        })
        .from(schema.encounter)
        .where(inArray(schema.encounter.patientId, ids))
        .groupBy(schema.encounter.patientId);

      return {
        allergic: new Set(allergyRows.map((r) => r.patientId)),
        lastVisits: new Map(visitRows.map((r) => [r.patientId, r.last])),
      };
    });

    return rows.map((row) => ({
      id: row.id,
      mrn: row.mrn,
      fullName: row.fullName,
      mobileE164: row.mobileE164,
      gender: row.gender,
      dateOfBirth: row.dateOfBirth,
      ageYears: row.ageYears,
      ageRecordedAt: row.ageRecordedAt,
      tags: row.tags ?? [],
      lastVisitAt: lastVisits.get(row.id)?.toISOString() ?? null,
      hasHighCriticalityAllergy: allergic.has(row.id),
    })) as PatientSummary[];
  }

  /**
   * Human-readable, sequential per clinic. Spoken aloud at the desk.
   *
   * The character class is `[^0-9]` rather than the shorter `\D` on purpose.
   * This is a JS template literal, where a backslash sequence is an escape: the
   * shorter form collapses to a bare `D`, which silently strips the letter D
   * from every MRN and then asks Postgres to cast `MRN-000118` to a bigint. The
   * explicit class cannot be written wrong.
   *
   * Runs inside the caller's transaction, so RLS confines the scan to this
   * clinic and the number is theirs alone.
   */
  private async nextMrn(tx: { execute: (q: never) => Promise<{ rows: { next: number }[] }> }) {
    const result = await tx.execute(sql`
      SELECT coalesce(max(nullif(regexp_replace(mrn, '[^0-9]', '', 'g'), '')::bigint), 0) + 1 AS next
      FROM patient
    ` as never);
    const next = Number(result.rows[0]?.next ?? 1);
    return `MRN-${String(next).padStart(6, '0')}`;
  }
}

function mapObservation(row: Record<string, unknown>) {
  return {
    id: row.id,
    patientId: row.patient_id,
    encounterId: row.encounter_id,
    code: row.code,
    display: row.display,
    valueNumeric: row.value_numeric === null ? null : Number(row.value_numeric),
    valueUnit: row.value_unit,
    valueText: row.value_text,
    referenceLow: row.reference_low === null ? null : Number(row.reference_low),
    referenceHigh: row.reference_high === null ? null : Number(row.reference_high),
    interpretation: row.interpretation,
    effectiveAt: toIso(row.effective_at),
    recordedBy: row.recorded_by,
  };
}

/**
 * A timestamp from a raw `execute()` row, as an ISO string.
 *
 * Rows from the query builder are decoded by Drizzle using the column's type,
 * so a timestamptz arrives as a Date. Rows from a raw `execute()` are not — they
 * arrive as whatever the driver produced, which for these queries is a string.
 * Calling .toISOString() on one throws at the call site rather than at the
 * query, so the failure looks like a bug in the mapper.
 */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function sweepTokens() {
  const now = Date.now();
  for (const [token, expiry] of searchTokens) {
    if (expiry < now) searchTokens.delete(token);
  }
}
