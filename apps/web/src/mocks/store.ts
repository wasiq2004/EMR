/**
 * In-memory store backing the mock API.
 *
 * This exists so the whole frontend can be run, demonstrated and taken through
 * the Annex 5 acceptance script before the API service exists. It mirrors the
 * real endpoints exactly, so switching to the live backend is a matter of
 * setting API_BASE_URL — no screen changes.
 *
 * It is NOT a substitute for the API. There is no tenant isolation here, no
 * authorisation, no audit trail. Those live in the database and the NestJS
 * guards, and nothing in this file should ever be taken as evidence they work.
 */

import type {
  Allergy,
  Appointment,
  AuditEvent,
  ClinicalDocument,
  Consent,
  Conversation,
  Encounter,
  InternalNote,
  Invoice,
  MedicationRequest,
  Message,
  Observation,
  Patient,
  StaffUser,
  Task,
} from '@emr/contracts';
import { ALLERGIES, CLINIC, CONDITIONS, OBSERVATIONS, PATIENTS, STAFF } from './seed';
import {
  AUDIT_EVENTS,
  MESSAGE_TEMPLATES,
  SERVICES,
  WHATSAPP_ACCOUNT,
  seedConsents,
  seedDocuments,
} from './seed-extra';

const days = (n: number) => n * 24 * 60 * 60 * 1000;
const mins = (n: number) => n * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

/** Mutable state. Reset whenever the dev server restarts. */
export const store = {
  clinic: { ...CLINIC },
  staff: [...STAFF],
  patients: [...PATIENTS] as Patient[],
  allergies: [...ALLERGIES] as Allergy[],
  conditions: [...CONDITIONS],
  observations: [...OBSERVATIONS] as Observation[],
  encounters: [] as Encounter[],
  prescriptions: [] as MedicationRequest[],
  appointments: [] as Appointment[],
  conversations: [] as Conversation[],
  messages: [] as Message[],
  invoices: [] as Invoice[],
  tasks: [] as Task[],
  internalNotes: [] as InternalNote[],
  auditEvents: [...AUDIT_EVENTS] as AuditEvent[],
  documents: [] as ClinicalDocument[],
  consents: [] as Consent[],
  services: [...SERVICES],
  whatsappAccount: { ...WHATSAPP_ACCOUNT },
  messageTemplates: [...MESSAGE_TEMPLATES],
  /** Proof that a duplicate search ran, keyed by token. */
  searchTokens: new Set<string>(),
  mrnCounter: 500,
  /**
   * Which role the mock is signed in as. Real sessions come from a verified
   * JWT; this exists only so the panels can be demonstrated without a backend.
   * Switch it from the role picker on the sign-in screen.
   */
  currentRole: 'RECEPTIONIST' as StaffUser['role'],
};

const DOCTOR = STAFF[0]!;
const NURSE = STAFF[3]!;
const RECEPTION = STAFF[2]!;
const P = (n: number) => store.patients[n]!;

/* ------------------------------------------------------------------------- *
 * Today's queue — the screen the front desk lives on
 * ------------------------------------------------------------------------- */

function appointment(partial: Partial<Appointment> & { patientId: string }): Appointment {
  return {
    id: uuid(),
    practitionerId: DOCTOR.id,
    locationId: null,
    status: 'ARRIVED',
    scheduledStart: iso(0),
    scheduledEnd: null,
    arrivedAt: iso(0),
    calledAt: null,
    completedAt: null,
    queuePosition: null,
    isWalkIn: true,
    reasonText: null,
    notes: null,
    cancelledReason: null,
    createdAt: iso(0),
    createdBy: RECEPTION.id,
    updatedAt: iso(0),
    updatedBy: null,
    version: 1,
    ...partial,
  };
}

store.appointments = [
  appointment({
    patientId: P(3).id, // Lakshmi Narayanan — the Flow 3/4 fixture
    status: 'ARRIVED',
    arrivedAt: iso(-mins(28)),
    queuePosition: 10,
    reasonText: 'Sore throat and fever, 3 days',
  }),
  appointment({
    patientId: P(6).id, // Shantabai Pawar — stated age, no DOB
    status: 'ARRIVED',
    arrivedAt: iso(-mins(19)),
    queuePosition: 20,
    reasonText: 'Knee pain review',
  }),
  appointment({
    patientId: P(7).id, // Govind Rao — 22 medicines
    status: 'ARRIVED',
    arrivedAt: iso(-mins(11)),
    queuePosition: 30,
    reasonText: 'Monthly review, repeat medicines',
  }),
  appointment({
    patientId: P(2).id, // Aarav Kumar, paediatric
    status: 'SCHEDULED',
    isWalkIn: false,
    arrivedAt: null,
    scheduledStart: iso(mins(40)),
    scheduledEnd: iso(mins(55)),
    queuePosition: null,
    practitionerId: STAFF[1]!.id,
    reasonText: 'Cough, 2 days',
  }),
  appointment({
    patientId: P(8).id, // Kavita Joshi
    status: 'CONFIRMED',
    isWalkIn: false,
    arrivedAt: null,
    scheduledStart: iso(mins(75)),
    scheduledEnd: iso(mins(90)),
    queuePosition: null,
    reasonText: 'Follow-up',
  }),
  appointment({
    patientId: P(0).id, // Sunita Devi — completed earlier today
    status: 'FULFILLED',
    arrivedAt: iso(-mins(140)),
    calledAt: iso(-mins(120)),
    completedAt: iso(-mins(105)),
    queuePosition: null,
    reasonText: 'Fever',
  }),
];

/* ------------------------------------------------------------------------- *
 * Some history, so the Snapshot is not empty on first open
 * ------------------------------------------------------------------------- */

function encounter(
  partial: Partial<Encounter> & { patientId: string; startedAt: string },
): Encounter {
  return {
    id: uuid(),
    practitionerId: DOCTOR.id,
    appointmentId: null,
    status: 'FINISHED',
    endedAt: partial.startedAt,
    chiefComplaint: null,
    historyOfPresentIllness: null,
    examinationNotes: null,
    assessmentNotes: null,
    planNotes: null,
    followUpAfterDays: null,
    followUpInstructions: null,
    isFinalized: true,
    finalizedAt: partial.startedAt,
    finalizedBy: DOCTOR.id,
    amendsEncounterId: null,
    amendmentReason: null,
    createdAt: partial.startedAt,
    createdBy: DOCTOR.id,
    updatedAt: partial.startedAt,
    updatedBy: DOCTOR.id,
    version: 2,
    ...partial,
  };
}

store.encounters = [
  encounter({
    patientId: P(3).id,
    startedAt: iso(-days(62)),
    chiefComplaint: 'Routine diabetes and blood pressure review',
    examinationNotes: 'BP 146/90. Weight stable. No pedal oedema.',
    assessmentNotes: 'Type 2 diabetes — reasonable control. Hypertension — above target.',
    planNotes: 'Increase telmisartan to 40 mg. Review in 8 weeks with fasting sugar.',
    followUpAfterDays: 56,
  }),
  encounter({
    patientId: P(3).id,
    startedAt: iso(-days(155)),
    chiefComplaint: 'Burning feet at night',
    assessmentNotes: 'Likely early diabetic neuropathy.',
    planNotes: 'Start vitamin B complex. Foot care advice given.',
  }),
  encounter({
    patientId: P(3).id,
    startedAt: iso(-days(240)),
    chiefComplaint: 'Annual review',
    assessmentNotes: 'Stable.',
    planNotes: 'Continue current medicines.',
  }),
  encounter({
    patientId: P(7).id,
    startedAt: iso(-days(7)),
    chiefComplaint: 'Monthly review',
    assessmentNotes: 'CKD stage 3, stable. Polypharmacy reviewed.',
    planNotes: 'Continue. Repeat creatinine in 4 weeks.',
  }),
];

/** Lakshmi's current medicines, shown on the Snapshot. */
function medication(
  patientId: string,
  encounterId: string,
  drugDisplayName: string,
  moleculeName: string,
  strength: string,
  frequency: string,
): MedicationRequest {
  return {
    id: uuid(),
    patientId,
    encounterId,
    practitionerId: DOCTOR.id,
    status: 'ACTIVE',
    catalogueItemId: null,
    drugDisplayName,
    moleculeName,
    strength,
    dosageForm: 'Tablet',
    route: 'Oral',
    frequency,
    timingRelativeToFood: 'AFTER_FOOD',
    durationDays: null,
    quantity: null,
    instructions: null,
    safetyWarningsShown: [],
    safetyOverrideReason: null,
    catalogueVersionAtPrescribing: 'pilot-v1',
    authoredAt: iso(-days(62)),
  };
}

const lakshmiEncounter = store.encounters[0]!.id;
store.prescriptions = [
  medication(P(3).id, lakshmiEncounter, 'Glycomet 500', 'Metformin', '500 mg', '1-0-1'),
  medication(P(3).id, lakshmiEncounter, 'Telma 40', 'Telmisartan', '40 mg', '1-0-0'),
  medication(P(3).id, lakshmiEncounter, 'Atorva 10', 'Atorvastatin', '10 mg', '0-0-1'),
];

/* ------------------------------------------------------------------------- *
 * Inbox — including the unlinked queue, which is an expected path
 * ------------------------------------------------------------------------- */

const conversationId = uuid();
const unlinkedConversationId = uuid();

store.conversations = [
  {
    id: conversationId,
    patientId: P(3).id,
    patientName: P(3).fullName,
    counterpartyE164: P(3).mobileE164!,
    lastInboundAt: iso(-mins(95)),
    lastOutboundAt: iso(-mins(90)),
    // Still open — the composer should offer a free-form reply.
    windowExpiresAt: iso(days(1) - mins(95)),
    status: 'WAITING',
    isUnread: false,
    assignedToUserId: null,
    assignedToName: null,
    isUnlinked: false,
    candidatePatientIds: [],
    isOptedOut: false,
    lastMessagePreview: 'Thank you doctor, I will come at 11.',
    unreadCount: 0,
  },
  {
    id: unlinkedConversationId,
    patientId: null,
    patientName: null,
    // Three patients share this number, so inbound cannot be matched to one.
    counterpartyE164: '+919876543210',
    lastInboundAt: iso(-mins(22)),
    lastOutboundAt: null,
    windowExpiresAt: iso(days(1) - mins(22)),
    status: 'OPEN',
    isUnread: true,
    assignedToUserId: null,
    assignedToName: null,
    isUnlinked: true,
    candidatePatientIds: [P(0).id, P(1).id, P(2).id],
    isOptedOut: false,
    lastMessagePreview: 'Doctor, baby has fever since morning. Can we come today?',
    unreadCount: 2,
  },
  {
    id: uuid(),
    patientId: P(7).id,
    patientName: P(7).fullName,
    counterpartyE164: P(7).mobileE164!,
    lastInboundAt: iso(-days(3)),
    lastOutboundAt: iso(-days(3)),
    // Window has closed — only an approved template can be sent.
    windowExpiresAt: iso(-days(2)),
    status: 'CLOSED',
    isUnread: false,
    assignedToUserId: null,
    assignedToName: null,
    isUnlinked: false,
    candidatePatientIds: [],
    isOptedOut: false,
    lastMessagePreview: 'Received the prescription, thank you.',
    unreadCount: 0,
  },
];

store.messages = [
  {
    id: uuid(),
    conversationId,
    patientId: P(3).id,
    channel: 'WHATSAPP',
    direction: 'OUTBOUND',
    status: 'READ',
    messageKind: 'TEMPLATE',
    templateName: 'appointment_reminder_v2',
    body: 'Reminder: you have an appointment with Dr Anjali Mehta today at 11:00 AM.',
    documentId: null,
    documentTitle: null,
    providerErrorMessage: null,
    queuedAt: iso(-mins(180)),
    sentAt: iso(-mins(180)),
    deliveredAt: iso(-mins(179)),
    readAt: iso(-mins(120)),
    failedAt: null,
    sentByName: null,
    costPaise: 16,
  },
  {
    id: uuid(),
    conversationId,
    patientId: P(3).id,
    channel: 'WHATSAPP',
    direction: 'INBOUND',
    status: 'RECEIVED',
    messageKind: null,
    templateName: null,
    body: 'Thank you doctor, I will come at 11.',
    documentId: null,
    documentTitle: null,
    providerErrorMessage: null,
    queuedAt: iso(-mins(95)),
    sentAt: iso(-mins(95)),
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    sentByName: null,
    costPaise: null,
  },
  {
    id: uuid(),
    conversationId: unlinkedConversationId,
    patientId: null,
    channel: 'WHATSAPP',
    direction: 'INBOUND',
    status: 'RECEIVED',
    messageKind: null,
    templateName: null,
    body: 'Doctor, baby has fever since morning. Can we come today?',
    documentId: null,
    documentTitle: null,
    providerErrorMessage: null,
    queuedAt: iso(-mins(22)),
    sentAt: iso(-mins(22)),
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    sentByName: null,
    costPaise: null,
  },
];

/* ------------------------------------------------------------------------- *
 * Tasks — where the safety mechanisms terminate
 * ------------------------------------------------------------------------- */

store.tasks = [
  {
    id: uuid(),
    status: 'REQUESTED',
    priority: 'URGENT',
    taskType: 'DELIVERY_FAILED',
    title: 'Prescription not delivered to Govind Rao Deshpande',
    description:
      'The WhatsApp message was accepted but not confirmed delivered within 15 minutes. Print a copy or call the patient.',
    patientId: P(7).id,
    patientName: P(7).fullName,
    encounterId: null,
    focusResourceType: 'communication',
    focusResourceId: null,
    assignedToUserId: null,
    assignedToName: null,
    assignedToRole: 'RECEPTIONIST',
    dueAt: iso(mins(30)),
    completedAt: null,
    resolutionNotes: null,
    createdAt: iso(-mins(18)),
  },
  {
    id: uuid(),
    status: 'REQUESTED',
    priority: 'ROUTINE',
    taskType: 'DUPLICATE_REVIEW',
    title: 'Possible duplicate: Mohd Imran and Mohammed Imran',
    description:
      'Same date of birth and a close name match on two different mobile numbers. Review and merge if they are the same person.',
    patientId: P(4).id,
    patientName: P(4).fullName,
    encounterId: null,
    focusResourceType: 'patient',
    focusResourceId: P(5).id,
    assignedToUserId: null,
    assignedToName: null,
    assignedToRole: 'OWNER_ADMIN',
    dueAt: null,
    completedAt: null,
    resolutionNotes: null,
    createdAt: iso(-days(1)),
  },
  {
    id: uuid(),
    status: 'REQUESTED',
    priority: 'ROUTINE',
    taskType: 'FOLLOW_UP_CALL',
    title: 'Follow-up call for Lakshmi Narayanan',
    description: 'Dr Mehta asked for a check-in call two weeks after the last visit.',
    patientId: P(3).id,
    patientName: P(3).fullName,
    encounterId: null,
    focusResourceType: 'patient',
    focusResourceId: P(3).id,
    assignedToUserId: NURSE.id,
    assignedToName: NURSE.fullName,
    assignedToRole: null,
    dueAt: iso(days(2)),
    completedAt: null,
    resolutionNotes: null,
    createdAt: iso(-days(3)),
  },
];

/* ------------------------------------------------------------------------- *
 * Billing
 * ------------------------------------------------------------------------- */

store.invoices = [
  {
    id: uuid(),
    patientId: P(0).id,
    patientName: P(0).fullName,
    encounterId: null,
    invoiceNumber: 'INV-2026-0311',
    status: 'ISSUED',
    lineItems: [
      {
        serviceItemId: null,
        description: 'New consultation',
        quantity: 1,
        unitPricePaise: 60000,
        amountPaise: 60000,
        hsnSac: null,
      },
    ],
    subtotalPaise: 60000,
    discountPaise: 0,
    discountReason: null,
    taxPaise: 0,
    totalPaise: 60000,
    paidPaise: 0,
    currency: 'INR',
    issuedAt: iso(-mins(105)),
    isFinalized: true,
    cancelledReason: null,
    payments: [],
    createdAt: iso(-mins(105)),
    createdBy: RECEPTION.id,
    updatedAt: iso(-mins(105)),
    updatedBy: null,
    version: 1,
  },
  {
    id: uuid(),
    patientId: P(7).id,
    patientName: P(7).fullName,
    encounterId: null,
    invoiceNumber: 'INV-2026-0308',
    status: 'BALANCED',
    lineItems: [
      {
        serviceItemId: null,
        description: 'Follow-up consultation',
        quantity: 1,
        unitPricePaise: 40000,
        amountPaise: 40000,
        hsnSac: null,
      },
    ],
    subtotalPaise: 40000,
    discountPaise: 5000,
    discountReason: 'Senior citizen',
    taxPaise: 0,
    totalPaise: 35000,
    paidPaise: 35000,
    currency: 'INR',
    issuedAt: iso(-days(7)),
    isFinalized: true,
    cancelledReason: null,
    payments: [
      {
        id: uuid(),
        invoiceId: 'x',
        patientId: P(7).id,
        amountPaise: 35000,
        method: 'UPI',
        referenceNumber: '429183746152',
        receivedAt: iso(-days(7)),
        receivedByName: RECEPTION.fullName,
        isRefund: false,
        refundReason: null,
      },
    ],
    createdAt: iso(-days(7)),
    createdBy: RECEPTION.id,
    updatedAt: iso(-days(7)),
    updatedBy: null,
    version: 2,
  },
];

export function nextMrn(): string {
  store.mrnCounter += 1;
  return `MRN-${String(store.mrnCounter).padStart(6, '0')}`;
}

export { uuid };

/* Documents and consents for the Snapshot fixture patient. */
store.documents = seedDocuments(P(3).id, P(3).fullName, DOCTOR.fullName);
store.consents = seedConsents(P(3).id);
