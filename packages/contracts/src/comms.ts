/**
 * WhatsApp inbox, the 24-hour service window, and message templates.
 *
 * The window is the thing to get right. WhatsApp permits free-form messages
 * only within 24 hours of the patient's last inbound message; outside it, only
 * approved templates. It fails SILENTLY — the provider simply rejects the send
 * — so the window is persisted and consulted before every send rather than
 * inferred afterwards.
 *
 * Nothing in this module can reach an internal clinical note. That isolation is
 * a database grant, not a filter in code.
 */

import { z } from 'zod';
import { IsoDateTime, PhoneE164, Uuid } from './common';
import {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationStatus,
  ConversationStatus,
  WhatsappMessageKind,
} from './enums';

export const Conversation = z.object({
  id: Uuid,
  patientId: Uuid.nullable(),
  patientName: z.string().nullable(),
  counterpartyE164: PhoneE164,
  lastInboundAt: IsoDateTime.nullable(),
  lastOutboundAt: IsoDateTime.nullable(),
  /** lastInboundAt + 24h. Free-form sends are permitted only before this. */
  windowExpiresAt: IsoDateTime.nullable(),
  status: ConversationStatus,
  isUnread: z.boolean(),
  assignedToUserId: Uuid.nullable(),
  assignedToName: z.string().nullable(),
  /**
   * True when inbound messages matched no patient, or several. One mobile
   * number routinely serves a family, so a multi-match is as common as a
   * no-match — this is an expected queue, not an error path.
   */
  isUnlinked: z.boolean(),
  candidatePatientIds: z.array(Uuid).default([]),
  isOptedOut: z.boolean(),
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number().int().default(0),
});
export type Conversation = z.infer<typeof Conversation>;

export const Message = z.object({
  id: Uuid,
  conversationId: Uuid.nullable(),
  patientId: Uuid.nullable(),
  channel: CommunicationChannel,
  direction: CommunicationDirection,
  status: CommunicationStatus,
  messageKind: WhatsappMessageKind.nullable(),
  templateName: z.string().nullable(),
  body: z.string().nullable(),
  /** Attached as a secure share link, never as raw clinical content. */
  documentId: Uuid.nullable(),
  documentTitle: z.string().nullable(),
  providerErrorMessage: z.string().nullable(),
  queuedAt: IsoDateTime,
  sentAt: IsoDateTime.nullable(),
  deliveredAt: IsoDateTime.nullable(),
  readAt: IsoDateTime.nullable(),
  failedAt: IsoDateTime.nullable(),
  sentByName: z.string().nullable(),
  costPaise: z.number().int().nullable(),
});
export type Message = z.infer<typeof Message>;

/**
 * The composer does not ask the user to choose between session and template —
 * it resolves the window and tells them what will be sent.
 */
export const SendMessage = z.object({
  conversationId: Uuid,
  body: z.string().trim().min(1, 'Type a message'),
  /** Required when the window has closed. */
  templateName: z.string().nullable().default(null),
  templateVariables: z.record(z.string(), z.string()).default({}),
  documentId: Uuid.nullable().default(null),
  /** Prevents a retried request dispatching the same message twice. */
  idempotencyKey: z.string(),
});
export type SendMessage = z.infer<typeof SendMessage>;

export const LinkConversation = z.object({
  conversationId: Uuid,
  patientId: Uuid,
});
export type LinkConversation = z.infer<typeof LinkConversation>;

export const MessageTemplate = z.object({
  id: Uuid,
  name: z.string(),
  purpose: z.enum([
    'APPOINTMENT_REMINDER',
    'APPOINTMENT_CONFIRMATION',
    'PRESCRIPTION_READY',
    'REPORT_READY',
    'FOLLOW_UP_DUE',
    'MISSED_APPOINTMENT',
    'SHARE_LINK_OTP',
  ]),
  category: z.enum(['UTILITY', 'AUTHENTICATION', 'MARKETING']),
  language: z.string(),
  body: z.string(),
  variables: z.array(z.string()),
  /** Provider-side approval. Can be revoked retroactively and without notice. */
  status: z.enum(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED']),
  /** Two variants are maintained per purpose so one rejection is not an outage. */
  isPrimary: z.boolean(),
  lastCheckedAt: IsoDateTime.nullable(),
});
export type MessageTemplate = z.infer<typeof MessageTemplate>;

export const WhatsappAccount = z.object({
  id: Uuid,
  displayPhoneE164: PhoneE164,
  verifiedName: z.string().nullable(),
  /** A falling rating precedes suspension, so it is surfaced before an outage. */
  qualityRating: z.enum(['GREEN', 'YELLOW', 'RED', 'UNKNOWN']),
  messagingTier: z.string().nullable(),
  /** Anything other than India is a compliance finding for an Indian clinic. */
  localStorageRegion: z.string().nullable(),
  isActive: z.boolean(),
  connectedAt: IsoDateTime.nullable(),

  /**
   * Whether this deployment can actually send.
   *
   * A connected row can exist with no usable access token, and the gap between
   * "connected" and "will send" is the most important thing the settings screen
   * communicates. A clinic that believes a prescription reminder reached a
   * patient, when it reached nobody, is worse off than one that knows the
   * channel is not live.
   */
  canSend: z.boolean(),
  /** Last four characters of the token, so two numbers can be told apart. */
  tokenHint: z.string().nullable(),
  wabaId: z.string().nullable(),
  phoneNumberId: z.string().nullable(),
});
export type WhatsappAccount = z.infer<typeof WhatsappAccount>;

/**
 * A template as the PROVIDER holds it, mirrored locally.
 *
 * Distinct from `MessageTemplate` above, and the two axes are different:
 * `MessageTemplate.purpose` says which clinic workflow sends it (an appointment
 * reminder, a report-ready note); `purpose` here says which CONSENT its content
 * requires. A template can be an appointment reminder and clinical, or a camp
 * invitation and marketing, and only the second axis decides who may lawfully
 * receive it.
 */
export const WhatsappTemplate = z.object({
  id: Uuid,
  name: z.string(),
  language: z.string(),
  category: z.string().nullable(),
  status: z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED']),
  /** The provider's reason, when rejected or paused. */
  statusReason: z.string().nullable(),
  body: z.string(),
  headerText: z.string().nullable(),
  footerText: z.string().nullable(),
  buttons: z
    .array(z.object({ type: z.string(), text: z.string(), url: z.string().optional() }))
    .nullable(),
  variables: z.array(z.object({ index: z.number().int(), label: z.string() })),
  purpose: z.enum(['CLINICAL', 'MARKETING']),
  lastSyncedAt: IsoDateTime.nullable(),
});
export type WhatsappTemplate = z.infer<typeof WhatsappTemplate>;

export const ConnectWhatsapp = z.object({
  wabaId: z
    .string()
    .trim()
    .min(5, 'Enter the WhatsApp Business Account ID')
    .regex(/^\d+$/, 'The WABA ID is all digits — copy it from Meta Business Manager'),
  phoneNumberId: z
    .string()
    .trim()
    .min(5, 'Enter the Phone Number ID')
    .regex(/^\d+$/, 'The Phone Number ID is all digits — it is not the phone number itself'),
  accessToken: z.string().trim().min(20, 'Enter the permanent access token'),
});
export type ConnectWhatsapp = z.infer<typeof ConnectWhatsapp>;

export const ReminderRule = z.object({
  id: Uuid,
  purpose: MessageTemplate.shape.purpose,
  enabled: z.boolean(),
  /** Hours before the appointment. Negative means after, for follow-ups. */
  offsetHours: z.number().int(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/),
  channelFallback: CommunicationChannel.nullable(),
});
export type ReminderRule = z.infer<typeof ReminderRule>;

/** Milliseconds left in the service window; negative once it has closed. */
export function windowRemainingMs(windowExpiresAt: string | null, now = Date.now()): number {
  if (!windowExpiresAt) return -1;
  return new Date(windowExpiresAt).getTime() - now;
}

export function isWindowOpen(windowExpiresAt: string | null, now = Date.now()): boolean {
  return windowRemainingMs(windowExpiresAt, now) > 0;
}

/* ------------------------------------------------------------------------- *
 * Scheduled reminders
 * ------------------------------------------------------------------------- */

export const ReminderKind = z.enum(['FOLLOW_UP', 'APPOINTMENT']);
export type ReminderKind = z.infer<typeof ReminderKind>;

export const ReminderChannel = z.enum(['WHATSAPP', 'EMAIL']);
export type ReminderChannel = z.infer<typeof ReminderChannel>;

export const ReminderStatus = z.enum([
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
]);
export type ReminderStatus = z.infer<typeof ReminderStatus>;

export const REMINDER_STATUS_LABEL: Record<ReminderStatus, string> = {
  PENDING: 'Scheduled',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  /** Correctly not sent — no consent, or the patient already booked. */
  SKIPPED: 'Not needed',
  CANCELLED: 'Cancelled',
};

export const REMINDER_KIND_LABEL: Record<ReminderKind, string> = {
  FOLLOW_UP: 'Follow-up',
  APPOINTMENT: 'Appointment',
};

/**
 * One reminder, as the log shows it.
 *
 * `skipReason` and `lastError` are separate fields because they are separate
 * facts. "The patient never consented to WhatsApp" is a correct outcome and
 * "the provider rejected the number" is a fault; collapsing them into one
 * message makes a working system look broken and buries the real failures.
 */
export const ScheduledReminder = z.object({
  id: Uuid,
  patientId: Uuid,
  patientName: z.string(),
  patientMobile: z.string().nullable(),
  kind: ReminderKind,
  encounterId: Uuid.nullable(),
  appointmentId: Uuid.nullable(),
  dueAt: IsoDateTime,
  channel: ReminderChannel,
  status: ReminderStatus,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  sentAt: IsoDateTime.nullable(),
  communicationId: Uuid.nullable(),
  notifyClinic: z.boolean(),
});
export type ScheduledReminder = z.infer<typeof ScheduledReminder>;

/**
 * What `POST /jobs/run-due` reports back.
 *
 * Counted rather than listed, because the caller is a cron line and what it
 * needs is an exit status and a number for the log. The log screen is where
 * anybody looks at individual reminders.
 *
 * `claimed` is reported separately from `sent` on purpose: claimed-but-not-sent
 * is the shape of a run that died partway, and a response that only said "sent:
 * 3" would make that indistinguishable from a quiet night.
 */
export const RunDueResult = z.object({
  claimed: z.number().int(),
  sent: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  /** Rows left in SENDING from a previous run that died, recovered this time. */
  recovered: z.number().int(),
});
export type RunDueResult = z.infer<typeof RunDueResult>;

/**
 * The clinic's reminder settings, held in `clinic.settings` JSONB.
 *
 * JSONB rather than columns because these change per release and carry no
 * referential integrity — the same reason the rest of `settings` is there.
 */
export const ReminderSettings = z.object({
  /**
   * Whether follow-up reminders are created at all.
   *
   * Off by default. A clinic that has not connected WhatsApp and has not thought
   * about what its patients consented to should not start messaging them because
   * the feature shipped.
   */
  followUpEnabled: z.boolean().default(false),

  /**
   * How long before the follow-up date the reminder goes out.
   *
   * One day by default. A reminder that arrives on the morning of is too late to
   * rearrange a day around, and one a week early is forgotten by the time it
   * matters.
   */
  leadTimeDays: z.number().int().min(0).max(14).default(1),

  /**
   * The hour a reminder may first go out, in the clinic's own timezone.
   *
   * QUIET HOURS ARE NOT POLITENESS, they are whether the clinic gets blocked. A
   * WhatsApp business number that messages people at 3am collects "report
   * business" taps, and Meta's quality rating is what decides whether the
   * clinic's messages are delivered at all. Defaults to a 9am–8pm window.
   */
  quietHoursStart: z.number().int().min(0).max(23).default(9),
  quietHoursEnd: z.number().int().min(0).max(23).default(20),

  /**
   * A copy to the clinic's own number.
   *
   * Off by default, and a deliberate choice rather than an oversight: a clinic
   * copied on every patient reminder has a phone it cannot use, and it is the
   * patient's appointment rather than the clinic's. Audited when on, because it
   * means a patient's name and appointment leave the record to a second number.
   */
  notifyClinicNumber: z.boolean().default(false),
  /** Where the copy goes. E.164. Required when `notifyClinicNumber` is on. */
  clinicNotifyMobileE164: z.string().nullable().default(null),
});
export type ReminderSettings = z.infer<typeof ReminderSettings>;

export const REMINDER_SETTINGS_DEFAULTS: ReminderSettings = ReminderSettings.parse({});

export const SaveReminderSettings = ReminderSettings.partial().refine(
  (v) =>
    !v.notifyClinicNumber ||
    (v.clinicNotifyMobileE164 != null && /^\+[1-9]\d{7,14}$/.test(v.clinicNotifyMobileE164)),
  {
    message: 'Give the number the copy should go to, with its country code',
    path: ['clinicNotifyMobileE164'],
  },
);
export type SaveReminderSettings = z.infer<typeof SaveReminderSettings>;
