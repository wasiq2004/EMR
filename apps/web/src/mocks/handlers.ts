/**
 * Mock API router.
 *
 * Mirrors the endpoint surface from the Phase 0 API specification exactly, so
 * the frontend is written against the real shapes and switching to the live
 * NestJS service is a matter of setting API_BASE_URL.
 *
 * What this deliberately does NOT reproduce: tenant isolation, authorisation,
 * and the audit trail. Those are database and guard concerns. Nothing here
 * should ever be read as evidence that they work.
 */

import {
  computeInvoiceTotals,
  normalisePhone,
  type Allergy,
  type Appointment,
  type Condition,
  type Conversation,
  type DuplicateCandidate,
  type Encounter,
  type Invoice,
  type MedicationRequest,
  type Message,
  type Observation,
  type Patient,
  type PatientSnapshot,
  type PatientSummary,
  type Problem,
  type QueueEntry,
  type Session,
  type Task,
} from '@emr/contracts';
import { nextMrn, store, uuid } from './store';
import { searchDrugs } from './drugs';

const nowIso = () => new Date().toISOString();

export interface MockResponse {
  status: number;
  body: unknown;
}

function ok(body: unknown): MockResponse {
  return { status: 200, body };
}

function created(body: unknown): MockResponse {
  return { status: 201, body };
}

function problem(status: number, title: string, detail?: string): MockResponse {
  const body: Problem = { type: 'about:blank', title, status, detail };
  return { status, body };
}

/* ------------------------------------------------------------------------- *
 * Derived reads
 * ------------------------------------------------------------------------- */

function highCriticalityAllergy(patientId: string): boolean {
  return store.allergies.some(
    (a) => a.patientId === patientId && a.refutedAt === null && a.criticality === 'HIGH',
  );
}

function lastVisit(patientId: string): string | null {
  const visits = store.encounters
    .filter((e) => e.patientId === patientId)
    .map((e) => e.startedAt)
    .sort();
  return visits.at(-1) ?? null;
}

function toSummary(patient: Patient): PatientSummary {
  return {
    id: patient.id,
    mrn: patient.mrn,
    fullName: patient.fullName,
    mobileE164: patient.mobileE164,
    gender: patient.gender,
    dateOfBirth: patient.dateOfBirth,
    ageYears: patient.ageYears,
    ageRecordedAt: patient.ageRecordedAt,
    tags: patient.tags,
    lastVisitAt: lastVisit(patient.id),
    hasHighCriticalityAllergy: highCriticalityAllergy(patient.id),
  };
}

function staffName(id: string | null): string {
  return store.staff.find((s) => s.id === id)?.fullName ?? 'Unknown';
}

/** Crude trigram-ish similarity, standing in for pg_trgm. */
function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const [x, y] = [norm(a), norm(b)];
  if (x === y) return 1;
  const grams = (s: string) => {
    const out = new Set<string>();
    const padded = `  ${s} `;
    for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let shared = 0;
  for (const g of gx) if (gy.has(g)) shared += 1;
  return shared / Math.max(gx.size + gy.size - shared, 1);
}

/* ------------------------------------------------------------------------- *
 * The router
 * ------------------------------------------------------------------------- */

export async function handleMock(
  method: string,
  path: string,
  search: URLSearchParams,
  body: unknown,
): Promise<MockResponse> {
  const segments = path.split('/').filter(Boolean);
  const route = `${method} /${segments.join('/')}`;

  /* --- Session -------------------------------------------------------- */

  if (route === 'GET /auth/me') {
    const role = (search.get('as') ?? store.currentRole) as Session['role'];
    const user =
      store.staff.find((s) => s.role === role) ?? store.staff[0]!;
    const session: Session = {
      userId: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      clinicId: store.clinic.id,
      clinicName: store.clinic.name,
      clinicSlug: store.clinic.slug,
      hasMedicalRegistration: Boolean(user.medicalRegistrationNumber),
      mfaEnabled: user.mfaEnabled,
      mfaGraceDaysRemaining: user.mfaEnabled ? null : 5,
    };
    return ok(session);
  }

  if (route === 'POST /auth/login') {
    const input = body as { email?: string };
    const user = store.staff.find((s) => s.email === input?.email);
    if (!user) {
      // Identical message whether the email is unknown or the password is
      // wrong — the login endpoint must not confirm which accounts exist.
      return problem(401, 'Sign in failed', 'That email and password do not match.');
    }
    store.currentRole = user.role;
    return ok({ mfaRequired: user.mfaEnabled });
  }

  if (route === 'POST /auth/mfa/verify') {
    const input = body as { code?: string };
    if (input?.code !== '123456') {
      return problem(401, 'Incorrect code', 'Check the code in your authenticator app and try again.');
    }
    return ok({ ok: true });
  }

  if (route === 'POST /auth/logout') {
    return { status: 204, body: null };
  }

  if (route === 'GET /nav/counts') {
    return ok({
      inbox: store.conversations.filter((c) => c.isUnread).length,
      tasks: store.tasks.filter((t) => t.status === 'REQUESTED').length,
      queue: store.appointments.filter((a) =>
        ['ARRIVED', 'IN_PROGRESS'].includes(a.status),
      ).length,
    });
  }

  /* --- Patients -------------------------------------------------------- */

  if (route === 'GET /patients/search') {
    const q = (search.get('q') ?? '').trim();
    const limit = Number(search.get('limit') ?? 25);
    if (!q) return ok({ items: [], nextCursor: null });

    const digits = q.replace(/\D/g, '');
    const matches = store.patients.filter((p) => {
      if (p.mergedIntoPatientId) return false;
      if (digits.length >= 4 && p.mobileE164?.includes(digits)) return true;
      return similarity(p.fullName, q) > 0.25 || p.mrn.toLowerCase().includes(q.toLowerCase());
    });

    return ok({
      items: matches.slice(0, limit).map(toSummary),
      nextCursor: null,
      total: matches.length,
    });
  }

  /**
   * Search before create. Returns everyone already on the number as a picker,
   * plus fuzzy matches elsewhere — and issues the token the registration form
   * must present, so the form is unreachable without a search having run.
   */
  if (route === 'GET /patients/duplicates') {
    const mobile = normalisePhone(search.get('mobile') ?? '');
    const name = (search.get('name') ?? '').trim();

    const onSameMobile = mobile
      ? store.patients.filter((p) => p.mobileE164 === mobile && !p.mergedIntoPatientId)
      : [];

    const similar: DuplicateCandidate[] = name
      ? store.patients
          .filter((p) => !onSameMobile.some((m) => m.id === p.id) && !p.mergedIntoPatientId)
          .map((p) => ({ p, score: similarity(p.fullName, name) }))
          .filter((x) => x.score > 0.45)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(({ p, score }) => ({
            patient: toSummary(p),
            reasons: ['SIMILAR_NAME' as const],
            nameSimilarity: Number(score.toFixed(2)),
          }))
      : [];

    const token = uuid();
    store.searchTokens.add(token);

    return ok({ searchToken: token, onSameMobile: onSameMobile.map(toSummary), similar });
  }

  if (route === 'POST /patients') {
    const input = body as Record<string, unknown>;
    const token = input.searchToken as string | undefined;

    // Search-before-create is enforced here, not only in the UI. A client that
    // skips the duplicate check cannot register a patient.
    if (!token || !store.searchTokens.has(token)) {
      return problem(
        422,
        'Search for the patient first',
        'A duplicate check must run before a new record is created.',
      );
    }
    store.searchTokens.delete(token);

    const patient: Patient = {
      id: uuid(),
      mrn: nextMrn(),
      fullName: String(input.fullName ?? '').trim(),
      mobileE164: (input.mobileE164 as string) ?? null,
      mobileBelongsToRelative: Boolean(input.mobileBelongsToRelative),
      alternatePhoneE164: null,
      email: (input.email as string) ?? null,
      gender: (input.gender as Patient['gender']) ?? 'UNKNOWN',
      dateOfBirth: (input.dateOfBirth as string) ?? null,
      ageYears: (input.ageYears as number) ?? null,
      ageRecordedAt: input.ageYears ? nowIso().slice(0, 10) : null,
      bloodGroup: (input.bloodGroup as string) ?? null,
      addressLine1: (input.addressLine1 as string) ?? null,
      addressLine2: null,
      city: (input.city as string) ?? null,
      state: (input.state as string) ?? null,
      pincode: (input.pincode as string) ?? null,
      abhaNumber: null,
      clinicalAlert: null,
      emergencyContactName: (input.emergencyContactName as string) ?? null,
      emergencyContactPhoneE164: (input.emergencyContactPhoneE164 as string) ?? null,
      emergencyContactRelation: (input.emergencyContactRelation as string) ?? null,
      tags: (input.tags as string[]) ?? [],
      notes: (input.notes as string) ?? null,
      isActive: true,
      mergedIntoPatientId: null,
      createdAt: nowIso(),
      createdBy: null,
      updatedAt: nowIso(),
      updatedBy: null,
      version: 1,
    };

    store.patients.push(patient);
    return created(patient);
  }

  if (segments[0] === 'patients' && segments[1] && segments.length === 2) {
    const patient = store.patients.find((p) => p.id === segments[1]);
    if (!patient) return problem(404, 'Patient not found');

    if (method === 'GET') return ok(patient);

    if (method === 'PATCH') {
      const input = body as Record<string, unknown>;
      // Optimistic concurrency, exactly as the database trigger enforces it.
      if (typeof input.version === 'number' && input.version !== patient.version) {
        return problem(
          409,
          'Someone else changed this record',
          'Reload to see their version before saving yours.',
        );
      }
      Object.assign(patient, input, {
        version: patient.version + 1,
        updatedAt: nowIso(),
      });
      return ok(patient);
    }
  }

  if (segments[0] === 'patients' && segments[2] === 'snapshot') {
    const patientId = segments[1]!;
    const patient = store.patients.find((p) => p.id === patientId);
    if (!patient) return problem(404, 'Patient not found');

    const criticalityRank = { HIGH: 0, UNABLE_TO_ASSESS: 1, LOW: 2 } as const;

    const snapshot: PatientSnapshot = {
      patientId,
      allergies: store.allergies
        .filter((a) => a.patientId === patientId && a.refutedAt === null)
        .sort((a, b) => criticalityRank[a.criticality] - criticalityRank[b.criticality]),
      conditions: store.conditions
        .filter((c) => c.patientId === patientId && c.clinicalStatus === 'ACTIVE')
        .sort((a, b) => Number(b.isChronic) - Number(a.isChronic)),
      activeMedications: store.prescriptions.filter(
        (m) => m.patientId === patientId && m.status === 'ACTIVE',
      ),
      latestVitals: Object.values(
        store.observations
          .filter((o) => o.patientId === patientId)
          .reduce<Record<string, Observation>>((acc, o) => {
            const existing = acc[o.code];
            if (!existing || existing.effectiveAt < o.effectiveAt) acc[o.code] = o;
            return acc;
          }, {}),
      ),
      recentEncounters: store.encounters
        .filter((e) => e.patientId === patientId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 5)
        .map((e) => ({
          id: e.id,
          startedAt: e.startedAt,
          practitionerName: staffName(e.practitionerId),
          chiefComplaint: e.chiefComplaint,
          diagnoses: store.conditions
            .filter((c) => c.encounterId === e.id)
            .map((c) => c.displayText),
          isFinalized: e.isFinalized,
        })),
      recentDocuments: [],
      outstandingPaise: store.invoices
        .filter((i) => i.patientId === patientId)
        .reduce((sum, i) => sum + (i.totalPaise - i.paidPaise), 0),
    };

    return ok(snapshot);
  }

  if (segments[0] === 'patients' && segments[2] === 'allergies') {
    const patientId = segments[1]!;
    if (method === 'GET') {
      return ok(store.allergies.filter((a) => a.patientId === patientId));
    }
    if (method === 'POST') {
      const input = body as Record<string, unknown>;
      const allergy: Allergy = {
        id: uuid(),
        patientId,
        category: (input.category as Allergy['category']) ?? 'MEDICATION',
        criticality: (input.criticality as Allergy['criticality']) ?? 'UNABLE_TO_ASSESS',
        substanceMoleculeId: null,
        substanceText: String(input.substanceText ?? ''),
        reactionDescription: (input.reactionDescription as string) ?? null,
        reactionSeverity: (input.reactionSeverity as Allergy['reactionSeverity']) ?? null,
        onsetDate: null,
        refutedAt: null,
        recordedAt: nowIso(),
        recordedBy: store.staff[0]!.id,
      };
      store.allergies.push(allergy);
      return created(allergy);
    }
  }

  if (segments[0] === 'patients' && segments[2] === 'visits') {
    const patientId = segments[1]!;
    return ok(
      store.encounters
        .filter((e) => e.patientId === patientId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    );
  }

  if (route === 'GET /patients') {
    const q = (search.get('q') ?? '').trim();
    const items = store.patients
      .filter((p) => !p.mergedIntoPatientId)
      .filter((p) =>
        q
          ? p.fullName.toLowerCase().includes(q.toLowerCase()) ||
            p.mrn.toLowerCase().includes(q.toLowerCase()) ||
            (p.mobileE164 ?? '').includes(q.replace(/\D/g, ''))
          : true,
      )
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map(toSummary);
    return ok({ items, nextCursor: null, total: items.length });
  }

  /* --- Queue and appointments ------------------------------------------ */

  if (route === 'GET /queue') {
    const entries: QueueEntry[] = store.appointments
      .filter((a) => ['ARRIVED', 'IN_PROGRESS'].includes(a.status))
      .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
      .map((appointment) => {
        const patient = store.patients.find((p) => p.id === appointment.patientId)!;
        const open = store.encounters.find(
          (e) => e.appointmentId === appointment.id && !e.isFinalized,
        );
        return {
          appointment,
          patient: toSummary(patient),
          practitionerName: appointment.practitionerId
            ? staffName(appointment.practitionerId)
            : null,
          waitingMinutes: appointment.arrivedAt
            ? Math.round((Date.now() - new Date(appointment.arrivedAt).getTime()) / 60000)
            : null,
          encounterId: open?.id ?? null,
        };
      });

    const completed = store.appointments
      .filter((a) => a.status === 'FULFILLED')
      .map((appointment) => ({
        appointment,
        patient: toSummary(store.patients.find((p) => p.id === appointment.patientId)!),
        practitionerName: staffName(appointment.practitionerId),
        waitingMinutes: null,
        encounterId: null,
      }));

    return ok({ waiting: entries, completed });
  }

  if (route === 'POST /queue') {
    const input = body as { patientId: string; practitionerId?: string | null; reasonText?: string };
    const maxPosition = Math.max(
      0,
      ...store.appointments.map((a) => a.queuePosition ?? 0),
    );
    const appointment: Appointment = {
      id: uuid(),
      patientId: input.patientId,
      practitionerId: input.practitionerId ?? store.staff[0]!.id,
      locationId: null,
      status: 'ARRIVED',
      scheduledStart: nowIso(),
      scheduledEnd: null,
      arrivedAt: nowIso(),
      calledAt: null,
      completedAt: null,
      queuePosition: maxPosition + 10,
      isWalkIn: true,
      reasonText: input.reasonText ?? null,
      notes: null,
      cancelledReason: null,
      createdAt: nowIso(),
      createdBy: null,
      updatedAt: nowIso(),
      updatedBy: null,
      version: 1,
    };
    store.appointments.push(appointment);
    return created(appointment);
  }

  if (segments[0] === 'queue' && segments[2] === 'position' && method === 'PATCH') {
    const input = body as { beforeAppointmentId?: string | null };
    const moving = store.appointments.find((a) => a.id === segments[1]);
    if (!moving) return problem(404, 'Appointment not found');

    const queue = store.appointments
      .filter((a) => ['ARRIVED', 'IN_PROGRESS'].includes(a.status))
      .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));

    const target = input.beforeAppointmentId
      ? queue.find((a) => a.id === input.beforeAppointmentId)
      : null;

    // Sparse positions mean a re-prioritisation never renumbers the queue,
    // which matters because the front desk reorders constantly.
    if (target) {
      const targetIndex = queue.indexOf(target);
      const previous = queue[targetIndex - 1];
      const before = previous?.queuePosition ?? 0;
      moving.queuePosition = Math.round((before + (target.queuePosition ?? 0)) / 2);
    } else {
      moving.queuePosition =
        Math.max(0, ...queue.map((a) => a.queuePosition ?? 0)) + 10;
    }
    moving.updatedAt = nowIso();
    return ok(moving);
  }

  if (segments[0] === 'appointments' && segments[2] === 'status' && method === 'PATCH') {
    const input = body as { status: Appointment['status']; cancelledReason?: string };
    const appointment = store.appointments.find((a) => a.id === segments[1]);
    if (!appointment) return problem(404, 'Appointment not found');
    appointment.status = input.status;
    if (input.status === 'IN_PROGRESS') appointment.calledAt = nowIso();
    if (input.status === 'FULFILLED') appointment.completedAt = nowIso();
    if (input.cancelledReason) appointment.cancelledReason = input.cancelledReason;
    appointment.updatedAt = nowIso();
    appointment.version += 1;
    return ok(appointment);
  }

  if (route === 'GET /appointments') {
    return ok({
      items: store.appointments.map((appointment) => ({
        appointment,
        patient: toSummary(store.patients.find((p) => p.id === appointment.patientId)!),
        practitionerName: appointment.practitionerId
          ? staffName(appointment.practitionerId)
          : null,
      })),
    });
  }

  /* --- Encounters ------------------------------------------------------- */

  if (route === 'POST /encounters') {
    const input = body as { patientId: string; appointmentId?: string | null };
    const existing = store.encounters.find(
      (e) => e.patientId === input.patientId && !e.isFinalized,
    );
    if (existing) return ok(existing);

    const encounter: Encounter = {
      id: uuid(),
      patientId: input.patientId,
      practitionerId: store.staff[0]!.id,
      appointmentId: input.appointmentId ?? null,
      status: 'IN_PROGRESS',
      startedAt: nowIso(),
      endedAt: null,
      chiefComplaint: null,
      historyOfPresentIllness: null,
      examinationNotes: null,
      assessmentNotes: null,
      planNotes: null,
      followUpAfterDays: null,
      followUpInstructions: null,
      isFinalized: false,
      finalizedAt: null,
      finalizedBy: null,
      amendsEncounterId: null,
      amendmentReason: null,
      createdAt: nowIso(),
      createdBy: null,
      updatedAt: nowIso(),
      updatedBy: null,
      version: 1,
    };
    store.encounters.push(encounter);

    if (input.appointmentId) {
      const appointment = store.appointments.find((a) => a.id === input.appointmentId);
      if (appointment) {
        appointment.status = 'IN_PROGRESS';
        appointment.calledAt = nowIso();
      }
    }

    return created(encounter);
  }

  if (segments[0] === 'encounters' && segments[1] && segments.length === 2) {
    const encounter = store.encounters.find((e) => e.id === segments[1]);
    if (!encounter) return problem(404, 'Consultation not found');

    if (method === 'GET') return ok(encounter);

    if (method === 'PATCH') {
      // The database rejects edits to a finalised encounter; the API says so in
      // language a doctor can act on.
      if (encounter.isFinalized) {
        return problem(
          409,
          'This consultation is finalised',
          'Finalised records cannot be edited. Create an amendment instead.',
        );
      }
      Object.assign(encounter, body, { updatedAt: nowIso(), version: encounter.version + 1 });
      return ok(encounter);
    }
  }

  if (segments[0] === 'encounters' && segments[2] === 'finalise' && method === 'POST') {
    const encounter = store.encounters.find((e) => e.id === segments[1]);
    if (!encounter) return problem(404, 'Consultation not found');
    if (encounter.isFinalized) {
      return problem(409, 'Already finalised', 'This consultation has already been signed.');
    }

    const signer = store.staff.find((s) => s.role === store.currentRole);
    if (!signer || signer.role !== 'DOCTOR') {
      return problem(
        403,
        'Only a doctor can finalise a consultation',
        'Finalising produces a document bearing a practitioner registration number.',
      );
    }
    if (!signer.medicalRegistrationNumber) {
      return problem(
        403,
        'Medical registration number required',
        'A registration number must be on file before you can sign. Ask a clinic administrator to add it.',
      );
    }

    encounter.isFinalized = true;
    encounter.finalizedAt = nowIso();
    encounter.finalizedBy = signer.id;
    encounter.status = 'FINISHED';
    encounter.endedAt = nowIso();
    encounter.version += 1;

    for (const line of store.prescriptions.filter((m) => m.encounterId === encounter.id)) {
      line.status = 'ACTIVE';
    }

    if (encounter.appointmentId) {
      const appointment = store.appointments.find((a) => a.id === encounter.appointmentId);
      if (appointment) {
        appointment.status = 'FULFILLED';
        appointment.completedAt = nowIso();
      }
    }

    return ok(encounter);
  }

  if (segments[0] === 'encounters' && segments[2] === 'internal-notes') {
    const encounterId = segments[1]!;
    if (method === 'GET') {
      return ok(store.internalNotes.filter((n) => n.encounterId === encounterId));
    }
    if (method === 'POST') {
      const input = body as { note: string; patientId: string };
      const note = {
        id: uuid(),
        encounterId,
        patientId: input.patientId,
        note: input.note,
        authorId: store.staff[0]!.id,
        authorName: store.staff[0]!.fullName,
        createdAt: nowIso(),
      };
      store.internalNotes.push(note);
      return created(note);
    }
  }

  /* --- Clinical detail --------------------------------------------------- */

  if (route === 'POST /observations') {
    const input = body as Record<string, unknown>;
    const observation: Observation = {
      id: uuid(),
      patientId: String(input.patientId),
      encounterId: (input.encounterId as string) ?? null,
      code: String(input.code),
      display: String(input.display),
      valueNumeric: (input.valueNumeric as number) ?? null,
      valueUnit: (input.valueUnit as string) ?? null,
      valueText: (input.valueText as string) ?? null,
      referenceLow: (input.referenceLow as number) ?? null,
      referenceHigh: (input.referenceHigh as number) ?? null,
      interpretation: (input.interpretation as Observation['interpretation']) ?? null,
      effectiveAt: nowIso(),
      recordedBy: store.staff[0]!.id,
    };
    store.observations.push(observation);
    return created(observation);
  }

  if (route === 'POST /conditions') {
    const input = body as Record<string, unknown>;
    const condition: Condition = {
      id: uuid(),
      patientId: String(input.patientId),
      encounterId: (input.encounterId as string) ?? null,
      clinicalStatus: 'ACTIVE',
      code: (input.code as string) ?? null,
      codeSystem: (input.codeSystem as string) ?? null,
      displayText: String(input.displayText),
      isChronic: Boolean(input.isChronic),
      onsetDate: null,
      recordedAt: nowIso(),
      recordedBy: store.staff[0]!.id,
      notes: (input.notes as string) ?? null,
    };
    store.conditions.push(condition);
    return created(condition);
  }

  if (segments[0] === 'conditions' && segments[1] && method === 'DELETE') {
    store.conditions = store.conditions.filter((c) => c.id !== segments[1]);
    return { status: 204, body: null };
  }

  /* --- Prescribing ------------------------------------------------------- */

  if (route === 'GET /drugs/search') {
    return ok({ items: searchDrugs(search.get('q') ?? '', 12) });
  }

  if (segments[0] === 'encounters' && segments[2] === 'prescriptions') {
    const encounterId = segments[1]!;
    if (method === 'GET') {
      return ok(store.prescriptions.filter((m) => m.encounterId === encounterId));
    }
    if (method === 'POST') {
      const input = body as Record<string, unknown>;
      const encounter = store.encounters.find((e) => e.id === encounterId);
      if (!encounter) return problem(404, 'Consultation not found');

      const line: MedicationRequest = {
        id: uuid(),
        patientId: encounter.patientId,
        encounterId,
        practitionerId: store.staff[0]!.id,
        status: 'DRAFT',
        catalogueItemId: (input.catalogueItemId as string) ?? null,
        drugDisplayName: String(input.drugDisplayName),
        moleculeName: (input.moleculeName as string) ?? null,
        strength: (input.strength as string) ?? null,
        dosageForm: (input.dosageForm as string) ?? null,
        route: (input.route as string) ?? null,
        frequency: String(input.frequency ?? ''),
        timingRelativeToFood:
          (input.timingRelativeToFood as MedicationRequest['timingRelativeToFood']) ?? null,
        durationDays: (input.durationDays as number) ?? null,
        quantity: (input.quantity as number) ?? null,
        instructions: (input.instructions as string) ?? null,
        safetyWarningsShown: (input.safetyWarningsShown as never[]) ?? [],
        safetyOverrideReason: (input.safetyOverrideReason as string) ?? null,
        catalogueVersionAtPrescribing: 'pilot-v1',
        authoredAt: nowIso(),
      };
      store.prescriptions.push(line);
      return created(line);
    }
  }

  if (segments[0] === 'prescriptions' && segments[1] && method === 'DELETE') {
    const line = store.prescriptions.find((m) => m.id === segments[1]);
    if (line) {
      const encounter = store.encounters.find((e) => e.id === line.encounterId);
      if (encounter?.isFinalized) {
        return problem(
          409,
          'This prescription is finalised',
          'Issue a new prescription rather than editing a signed one.',
        );
      }
    }
    store.prescriptions = store.prescriptions.filter((m) => m.id !== segments[1]);
    return { status: 204, body: null };
  }

  /* --- Inbox -------------------------------------------------------------- */

  if (route === 'GET /inbox/conversations') {
    const filter = search.get('filter');
    let items: Conversation[] = store.conversations;
    if (filter === 'unlinked') items = items.filter((c) => c.isUnlinked);
    if (filter === 'open') items = items.filter((c) => c.status === 'OPEN');
    return ok({
      items: [...items].sort((a, b) =>
        (b.lastInboundAt ?? '').localeCompare(a.lastInboundAt ?? ''),
      ),
    });
  }

  if (segments[0] === 'inbox' && segments[1] === 'conversations' && segments[2]) {
    const conversation = store.conversations.find((c) => c.id === segments[2]);
    if (!conversation) return problem(404, 'Conversation not found');

    if (segments[3] === undefined && method === 'GET') {
      conversation.isUnread = false;
      conversation.unreadCount = 0;
      return ok({
        conversation,
        messages: store.messages
          .filter((m) => m.conversationId === conversation.id)
          .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
      });
    }

    if (segments[3] === 'reply' && method === 'POST') {
      const input = body as { body: string; templateName?: string | null };
      const open =
        conversation.windowExpiresAt !== null &&
        new Date(conversation.windowExpiresAt).getTime() > Date.now();

      if (!open && !input.templateName) {
        return problem(
          422,
          'The 24-hour reply window has closed',
          'Choose an approved template to message this patient.',
        );
      }

      const message: Message = {
        id: uuid(),
        conversationId: conversation.id,
        patientId: conversation.patientId,
        channel: 'WHATSAPP',
        direction: 'OUTBOUND',
        status: 'SENT',
        messageKind: open ? 'SESSION' : 'TEMPLATE',
        templateName: input.templateName ?? null,
        body: input.body,
        documentId: null,
        documentTitle: null,
        providerErrorMessage: null,
        queuedAt: nowIso(),
        sentAt: nowIso(),
        deliveredAt: null,
        readAt: null,
        failedAt: null,
        sentByName: store.staff[0]!.fullName,
        costPaise: open ? 0 : 16,
      };
      store.messages.push(message);
      conversation.lastOutboundAt = nowIso();
      conversation.status = 'WAITING';
      conversation.lastMessagePreview = input.body.slice(0, 90);
      return created(message);
    }

    if (segments[3] === 'link' && method === 'POST') {
      const input = body as { patientId: string };
      const patient = store.patients.find((p) => p.id === input.patientId);
      if (!patient) return problem(404, 'Patient not found');
      conversation.patientId = patient.id;
      conversation.patientName = patient.fullName;
      conversation.isUnlinked = false;
      conversation.candidatePatientIds = [];
      return ok(conversation);
    }
  }

  /* --- Tasks --------------------------------------------------------------- */

  if (route === 'GET /tasks') {
    const filter = search.get('filter') ?? 'open';
    const items =
      filter === 'all'
        ? store.tasks
        : store.tasks.filter((t) =>
            ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS'].includes(t.status),
          );
    const rank = { STAT: 0, ASAP: 1, URGENT: 2, ROUTINE: 3 } as const;
    return ok({ items: [...items].sort((a, b) => rank[a.priority] - rank[b.priority]) });
  }

  if (segments[0] === 'tasks' && segments[1] && method === 'PATCH') {
    const task = store.tasks.find((t) => t.id === segments[1]);
    if (!task) return problem(404, 'Task not found');
    const input = body as Partial<Task>;
    Object.assign(task, input);
    if (input.status === 'COMPLETED') task.completedAt = nowIso();
    return ok(task);
  }

  /* --- Billing ------------------------------------------------------------- */

  if (route === 'GET /invoices') {
    return ok({
      items: [...store.invoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
  }

  if (route === 'POST /invoices') {
    const input = body as {
      patientId: string;
      lineItems: Invoice['lineItems'];
      discountPaise?: number;
    };
    const patient = store.patients.find((p) => p.id === input.patientId);
    if (!patient) return problem(404, 'Patient not found');

    const totals = computeInvoiceTotals(input.lineItems, input.discountPaise ?? 0, 0);
    const invoice: Invoice = {
      id: uuid(),
      patientId: patient.id,
      patientName: patient.fullName,
      encounterId: null,
      invoiceNumber: `INV-2026-${String(400 + store.invoices.length).padStart(4, '0')}`,
      status: 'ISSUED',
      lineItems: input.lineItems,
      subtotalPaise: totals.subtotalPaise,
      discountPaise: input.discountPaise ?? 0,
      discountReason: null,
      taxPaise: totals.taxPaise,
      totalPaise: totals.totalPaise,
      paidPaise: 0,
      currency: 'INR',
      issuedAt: nowIso(),
      isFinalized: true,
      cancelledReason: null,
      payments: [],
      createdAt: nowIso(),
      createdBy: null,
      updatedAt: nowIso(),
      updatedBy: null,
      version: 1,
    };
    store.invoices.push(invoice);
    return created(invoice);
  }

  if (segments[0] === 'invoices' && segments[1] && segments.length === 2 && method === 'GET') {
    const invoice = store.invoices.find((i) => i.id === segments[1]);
    return invoice ? ok(invoice) : problem(404, 'Invoice not found');
  }

  if (segments[0] === 'invoices' && segments[2] === 'payments' && method === 'POST') {
    const invoice = store.invoices.find((i) => i.id === segments[1]);
    if (!invoice) return problem(404, 'Invoice not found');
    const input = body as { amountPaise: number; method: string; referenceNumber?: string };

    invoice.payments.push({
      id: uuid(),
      invoiceId: invoice.id,
      patientId: invoice.patientId,
      amountPaise: input.amountPaise,
      method: input.method as never,
      referenceNumber: input.referenceNumber ?? null,
      receivedAt: nowIso(),
      receivedByName: store.staff[2]!.fullName,
      isRefund: false,
      refundReason: null,
    });
    invoice.paidPaise += input.amountPaise;
    if (invoice.paidPaise >= invoice.totalPaise) invoice.status = 'BALANCED';
    return ok(invoice);
  }

  /* --- Reports, settings, audit ------------------------------------------- */

  if (route === 'GET /reports/summary') {
    const visits = store.encounters.length;
    const collections = store.invoices.reduce((sum, i) => sum + i.paidPaise, 0);
    const outstanding = store.invoices.reduce(
      (sum, i) => sum + (i.totalPaise - i.paidPaise),
      0,
    );
    const series = Array.from({ length: 14 }, (_, i) => {
      const date = new Date(Date.now() - (13 - i) * 86_400_000);
      return {
        date: date.toISOString().slice(0, 10),
        visits: 12 + ((i * 7) % 11),
        collectionsPaise: (28000 + ((i * 4300) % 22000)) * 10,
      };
    });

    return ok({
      rangeFrom: new Date(Date.now() - 13 * 86_400_000).toISOString(),
      rangeTo: nowIso(),
      visits,
      newPatients: 6,
      collectionsPaise: collections,
      outstandingPaise: outstanding,
      appointmentsBooked: store.appointments.length,
      noShows: 2,
      series,
      byPractitioner: store.staff
        .filter((s) => s.role === 'DOCTOR')
        .map((s, i) => ({
          practitionerId: s.id,
          practitionerName: s.fullName,
          visits: i === 0 ? 148 : 63,
          collectionsPaise: i === 0 ? 8_900_00 : 3_400_00,
        })),
    });
  }

  if (route === 'GET /clinic') return ok(store.clinic);
  if (route === 'GET /users') return ok({ items: store.staff });
  if (route === 'GET /audit-events') {
    return ok({ items: store.auditEvents });
  }

/* --- Documents and sharing --------------------------------------------- */

  if (route === 'GET /documents') {
    const patientId = search.get('patientId');
    const q = (search.get('q') ?? '').toLowerCase();
    let items = store.documents;
    if (patientId) items = items.filter((d) => d.patientId === patientId);
    if (q) {
      items = items.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.patientName.toLowerCase().includes(q),
      );
    }
    return ok({ items });
  }

  if (segments[0] === 'documents' && segments[1] && segments.length === 2) {
    const document = store.documents.find((d) => d.id === segments[1]);
    return document ? ok(document) : problem(404, 'Document not found');
  }

  if (segments[0] === 'documents' && segments[2] === 'share' && method === 'POST') {
    const document = store.documents.find((d) => d.id === segments[1]);
    if (!document) return problem(404, 'Document not found');

    // A patient upload that has not passed scanning must never be re-served.
    if (document.virusScanStatus && document.virusScanStatus !== 'CLEAN') {
      return problem(
        403,
        'This file has not completed security scanning',
        'It cannot be shared until the scan confirms it is clean.',
      );
    }

    const token = uuid().replace(/-/g, '');
    return created({
      url: `https://sunrise.app.example.in/share/${token}`,
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      requiresOtp: !['PRESCRIPTION', 'INVOICE'].includes(document.documentType),
    });
  }

  /**
   * The public share resolver.
   *
   * Every failure returns the SAME message. Distinguishing "expired" from
   * "unknown" would confirm that a link once existed, which turns this endpoint
   * into a way to probe for valid ones.
   */
  if (segments[0] === 'share' && segments[1] && method === 'POST') {
    const input = body as { otp?: string | null };
    if (!input?.otp) {
      return {
        status: 403,
        body: {
          type: 'about:blank',
          title: 'Verification required',
          status: 403,
          detail: 'A verification code has been sent to the number ending 2300.',
          code: 'OTP_REQUIRED',
        },
      };
    }
    if (input.otp !== '123456') {
      return problem(403, 'Incorrect code', 'Check the code and try again.');
    }
    return ok({ title: 'Prescription, 15 July' });
  }

  /* --- Consent ------------------------------------------------------------ */

  if (segments[0] === 'patients' && segments[2] === 'consents') {
    return ok(store.consents.filter((c) => c.patientId === segments[1]));
  }

  /* --- Settings reference data -------------------------------------------- */

  if (route === 'GET /services') return ok({ items: store.services });
  if (route === 'GET /whatsapp/account') return ok(store.whatsappAccount);
  if (route === 'GET /whatsapp/templates') return ok({ items: store.messageTemplates });

  /* --- Appointments ------------------------------------------------------- */

  if (route === 'POST /appointments') {
    const input = body as Record<string, unknown>;
    const service = store.services.find((s) => s.id === input.serviceItemId);
    const start = new Date(String(input.scheduledStart));
    const appointment: Appointment = {
      id: uuid(),
      patientId: String(input.patientId),
      practitionerId: (input.practitionerId as string) ?? null,
      locationId: null,
      status: 'SCHEDULED',
      scheduledStart: start.toISOString(),
      // The service sets the slot length, so nobody has to remember it.
      scheduledEnd: new Date(
        start.getTime() + (service?.defaultDurationMinutes ?? 15) * 60_000,
      ).toISOString(),
      arrivedAt: null,
      calledAt: null,
      completedAt: null,
      queuePosition: null,
      isWalkIn: false,
      reasonText: (input.reasonText as string) ?? null,
      notes: null,
      cancelledReason: null,
      createdAt: nowIso(),
      createdBy: null,
      updatedAt: nowIso(),
      updatedBy: null,
      version: 1,
    };
    store.appointments.push(appointment);
    return created(appointment);
  }

  /* --- Amendments --------------------------------------------------------- */

  if (segments[0] === 'encounters' && segments[2] === 'amend' && method === 'POST') {
    const original = store.encounters.find((e) => e.id === segments[1]);
    if (!original) return problem(404, 'Consultation not found');
    const input = body as { amendmentReason: string };

    // A correction is a NEW record linked to the original. The original is
    // never edited — the database enforces that with a trigger.
    const amendment: Encounter = {
      ...original,
      id: uuid(),
      startedAt: nowIso(),
      endedAt: null,
      status: 'IN_PROGRESS',
      isFinalized: false,
      finalizedAt: null,
      finalizedBy: null,
      amendsEncounterId: original.id,
      amendmentReason: input.amendmentReason,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      version: 1,
    };
    store.encounters.push(amendment);
    return created(amendment);
  }

  return problem(404, 'Not found', `No mock handler for ${route}`);
}

