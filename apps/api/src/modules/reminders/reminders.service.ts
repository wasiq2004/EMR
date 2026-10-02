import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import {
  REMINDER_SETTINGS_DEFAULTS,
  ReminderSettings,
  type RunDueResult,
  type ScheduledReminder,
} from '@emr/contracts';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { ClinicDirectoryService } from '../platform/clinic-directory.service';
import { WhatsAppAccountService } from '../messaging/whatsapp-account.service';
import { WhatsAppClient, WhatsAppError } from '../messaging/whatsapp.client';

/**
 * Follow-up reminders: scheduling them, and sending the ones that are due.
 *
 * THE TEMPLATE NAME A CLINIC MUST HAVE APPROVED. WhatsApp permits
 * business-initiated messages only as templates Meta has approved, so a reminder
 * needs one named `follow_up_reminder` with two variables — the patient's name
 * and the date. A clinic without it gets a FAILED reminder saying exactly that,
 * rather than silence: "no template" is a thing an administrator can fix in ten
 * minutes, and a reminder that quietly never sends is a thing nobody discovers
 * until a patient does not come back.
 *
 * WHAT MAKES `runDue` SAFE TO CALL TWICE. Three things, in layers:
 *
 *   1. The claim. Rows move `PENDING → SENDING` in one statement with
 *      `FOR UPDATE SKIP LOCKED`, so two overlapping cron runs — which is what
 *      happens the first time a send is slow — take disjoint sets.
 *   2. The idempotency key on the `communication` row, derived from the
 *      reminder's id. Even a claim that somehow raced cannot produce two
 *      messages, because the second insert conflicts.
 *   3. The unique index on (encounter_id, kind) for live statuses, so the
 *      SCHEDULING side cannot create two reminders for one consultation either.
 *
 * Layer 1 alone would be enough on a healthy day. Layers 2 and 3 are there
 * because the failure being guarded against is a patient receiving the same
 * message twice from their doctor, which costs the clinic more trust than a
 * missed reminder does.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  /** The approved template a follow-up reminder is sent as. */
  static readonly TEMPLATE_NAME = 'follow_up_reminder';

  /** How many reminders one run will send per clinic. */
  private static readonly BATCH_SIZE = 50;

  /**
   * How long a claim may be held before it is assumed dead.
   *
   * A runner that dies mid-send leaves its rows in `SENDING` for ever, and
   * nothing would ever pick them up again. Fifteen minutes is far longer than
   * any send takes and far shorter than the time it takes anybody to notice.
   */
  private static readonly STALE_CLAIM_MS = 15 * 60_000;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly clinics: ClinicDirectoryService,
    private readonly accounts: WhatsAppAccountService,
    private readonly whatsapp: WhatsAppClient,
  ) {}

  /* ---- Scheduling -------------------------------------------------------- */

  /**
   * Schedules the follow-up reminder for a consultation being signed.
   *
   * CALLED INSIDE THE SIGNING TRANSACTION, deliberately, and for the same reason
   * the pharmacy enqueue is: a signed consultation must not be able to exist
   * without its reminder scheduled, and a signing that fails must not leave a
   * reminder behind. A job that ran afterwards would leave both failure modes
   * open.
   *
   * NOT WHILE THE DRAFT IS BEING TYPED. `follow_up_after_days` autosaves every
   * few seconds, and scheduling on change would create and cancel reminders as
   * the doctor edits the number — with a real chance of sending one before they
   * finished deciding.
   *
   * Returns the reminder, or null with a reason it was not scheduled. Null is a
   * normal outcome: most consultations set no follow-up at all.
   */
  async scheduleFollowUp(
    tx: TenantTx,
    encounter: {
      id: string;
      clinicId: string;
      patientId: string;
      followUpAfterDays: number | null;
    },
    settings: ReminderSettings,
  ): Promise<{ scheduled: boolean; reason?: string }> {
    if (!encounter.followUpAfterDays || encounter.followUpAfterDays < 1) {
      return { scheduled: false, reason: 'no follow-up requested' };
    }
    if (!settings.followUpEnabled) {
      return { scheduled: false, reason: 'reminders are off for this clinic' };
    }

    const { timezone } = await clinicTimezone(tx);
    const dueAt = followUpDueAt(
      encounter.followUpAfterDays,
      settings,
      timezone,
      new Date(),
    );

    /*
     * A follow-up whose reminder time has already passed is not scheduled.
     *
     * "Come back in 1 day" signed at 7pm with a one-day lead time means the
     * reminder was due this morning. Sending it immediately would reach the
     * patient minutes after they left the clinic, which reads as a mistake
     * rather than a reminder.
     */
    if (dueAt.getTime() <= Date.now()) {
      return { scheduled: false, reason: 'the reminder time has already passed' };
    }

    const inserted = await tx
      .insert(schema.scheduledReminder)
      .values({
        clinicId: encounter.clinicId,
        patientId: encounter.patientId,
        kind: 'FOLLOW_UP',
        encounterId: encounter.id,
        dueAt,
        channel: 'WHATSAPP',
        status: 'PENDING',
        notifyClinic: settings.notifyClinicNumber,
      })
      /*
       * Amending a signed consultation, or any path that reaches here twice,
       * must not schedule a second reminder — the patient would get two
       * identical messages and nobody could say why.
       */
      .onConflictDoNothing()
      .returning({ id: schema.scheduledReminder.id });

    return inserted.length > 0
      ? { scheduled: true }
      : { scheduled: false, reason: 'already scheduled' };
  }

  /** The clinic's reminder settings, with defaults for anything unset. */
  async settingsFor(tx: TenantTx): Promise<ReminderSettings> {
    const [row] = await tx
      .select({ settings: schema.clinic.settings })
      .from(schema.clinic)
      .limit(1);

    const stored = (row?.settings as Record<string, unknown> | null) ?? {};
    const parsed = ReminderSettings.safeParse(stored.reminders ?? {});
    // Unparseable settings fall back to the defaults rather than throwing. A
    // malformed JSONB blob must not make signing a consultation impossible.
    return parsed.success ? parsed.data : REMINDER_SETTINGS_DEFAULTS;
  }

  /** The settings as a clinic reads them, for the settings screen. */
  async readSettings(): Promise<ReminderSettings> {
    return this.tenantDb.runReadOnly((tx) => this.settingsFor(tx));
  }

  /**
   * Saves the reminder settings into `clinic.settings` JSONB.
   *
   * MERGED, not replaced, and twice over. The patch merges into the current
   * reminder settings, and those merge back into the rest of `clinic.settings` —
   * which also holds consultation duration and queue preferences. Writing the
   * whole blob would silently drop every sibling key, and the screen that did it
   * would look like it worked.
   *
   * `clinic.settings` is deliberately not in `updateClinic`'s allow-list: a
   * generic JSONB patch would let any caller write any key, and these have a
   * shape worth validating.
   */
  async saveSettings(patch: Partial<ReminderSettings>): Promise<ReminderSettings> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [row] = await tx
        .select({ settings: schema.clinic.settings })
        .from(schema.clinic)
        .limit(1);

      const all = (row?.settings as Record<string, unknown> | null) ?? {};
      const current = await this.settingsFor(tx);
      const merged = ReminderSettings.parse({ ...current, ...patch });

      await tx
        .update(schema.clinic)
        .set({
          settings: { ...all, reminders: merged },
          updatedBy: ctx.userId,
        })
        .where(eq(schema.clinic.id, ctx.clinicId));

      return merged;
    });
  }

  /* ---- The log ----------------------------------------------------------- */

  /**
   * What has been scheduled and what became of it.
   *
   * The question is always asked about one patient — "why didn't Mrs Rao get
   * hers" — so `lastError` is on the row rather than only in a log file, and
   * SKIPPED carries its own reason distinct from FAILED.
   */
  async list(options: { patientId?: string; limit?: number } = {}) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          reminder: schema.scheduledReminder,
          patientName: schema.patient.fullName,
          patientMobile: schema.patient.mobileE164,
        })
        .from(schema.scheduledReminder)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.scheduledReminder.patientId))
        .where(
          options.patientId
            ? eq(schema.scheduledReminder.patientId, options.patientId)
            : undefined,
        )
        .orderBy(desc(schema.scheduledReminder.dueAt))
        .limit(Math.min(options.limit ?? 100, 500)),
    );

    return rows.map(({ reminder, patientName, patientMobile }) => serialise(reminder, patientName, patientMobile));
  }

  /** Cancels a scheduled reminder that has not gone out yet. */
  async cancel(id: string): Promise<{ cancelled: boolean }> {
    const ctx = TenantContext.require();
    const updated = await this.tenantDb.run((tx) =>
      tx
        .update(schema.scheduledReminder)
        .set({ status: 'CANCELLED', updatedBy: ctx.userId })
        .where(
          and(
            eq(schema.scheduledReminder.id, id),
            // Only a PENDING one. A sent message cannot be unsent, and
            // "cancelling" one would misrepresent what the patient received.
            eq(schema.scheduledReminder.status, 'PENDING'),
          ),
        )
        .returning({ id: schema.scheduledReminder.id }),
    );
    return { cancelled: updated.length > 0 };
  }

  /* ---- The job ----------------------------------------------------------- */

  /**
   * Sends everything that is due, across every clinic.
   *
   * HOW THIS ENUMERATES CLINICS WITHOUT CROSSING THE TENANT BOUNDARY. The clinic
   * list comes from `ClinicDirectoryService`, which returns ids and nothing
   * else. Behind it is the operations plane's connection: BYPASSRLS, but holding
   * grants on seven platform tables and nothing clinical — so it CANNOT read
   * `scheduled_reminder`, `patient` or an encounter. An attempt would be a
   * permission error, not a leak. All the actual work happens inside
   * `runAs(clinicId)` under ordinary RLS, exactly like the broadcast
   * dispatcher.
   *
   * This adds no `SECURITY DEFINER` function and does not touch the three
   * pre-tenant resolvers — see the README. A clinic id read from a platform
   * table is not a tenant crossing; reading a patient without a tenant scope
   * would be, and nothing here can.
   */
  async runDue(): Promise<RunDueResult> {
    const result: RunDueResult = {
      claimed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      recovered: 0,
    };

    const clinicIds = await this.clinics.activeClinicIds();

    for (const clinicId of clinicIds) {
      try {
        const forClinic = await this.runDueFor(clinicId);
        result.claimed += forClinic.claimed;
        result.sent += forClinic.sent;
        result.skipped += forClinic.skipped;
        result.failed += forClinic.failed;
        result.recovered += forClinic.recovered;
      } catch (error) {
        /*
         * One clinic's failure must not stop the others.
         *
         * A clinic with a revoked WhatsApp token should not prevent reminders
         * going out for the other forty on the deployment, and a cron line that
         * exits non-zero every night because of one tenant is a cron line
         * somebody turns off.
         */
        this.logger.error(`Reminder run failed for clinic ${clinicId}: ${String(error)}`);
        result.failed += 1;
      }
    }

    return result;
  }

  private async runDueFor(clinicId: string): Promise<RunDueResult> {
    const result: RunDueResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, recovered: 0 };

    /*
     * Step 1 — release claims from a run that died.
     *
     * Back to PENDING rather than to FAILED: nothing is known about whether the
     * message went, and the idempotency key on `communication` means a retry
     * cannot duplicate one that did. Attempts is already incremented, so a row
     * that keeps dying is visible rather than silently looping.
     */
    result.recovered = await this.tenantDb.runAs(clinicId, null, async (tx) => {
      const released = await tx
        .update(schema.scheduledReminder)
        .set({ status: 'PENDING', claimedAt: null })
        .where(
          and(
            eq(schema.scheduledReminder.status, 'SENDING'),
            lte(
              schema.scheduledReminder.claimedAt,
              new Date(Date.now() - RemindersService.STALE_CLAIM_MS),
            ),
          ),
        )
        .returning({ id: schema.scheduledReminder.id });
      return released.length;
    });

    /*
     * Step 2 — claim. One statement, so two runners cannot take the same row.
     *
     * `FOR UPDATE SKIP LOCKED` in the sub-select is what makes this safe: the
     * second runner skips rows the first has locked instead of waiting for them
     * and then sending them too.
     */
    const claimed = await this.tenantDb.runAs(clinicId, null, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE scheduled_reminder
        SET status = 'SENDING', claimed_at = now(), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM scheduled_reminder
          WHERE status = 'PENDING' AND due_at <= now()
          ORDER BY due_at
          LIMIT ${RemindersService.BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `);
      return (rows.rows ?? []).map((r) => r.id);
    });

    result.claimed = claimed.length;
    if (claimed.length === 0) return result;

    // The credential once per clinic, not once per reminder.
    const credential = await this.accounts.credentialFor(clinicId);

    for (const reminderId of claimed) {
      /*
       * A CLAIMED ROW MUST REACH A TERMINAL STATUS, whatever happens.
       *
       * `sendOne` writes one on every path it knows about, but an unexpected
       * throw — a dropped connection mid-transaction, a provider client bug —
       * would otherwise leave the row in SENDING, where nothing touches it again
       * until the stale-claim sweep fifteen minutes later. That was observed:
       * two rows sat claimed and silent, and from the outside it was
       * indistinguishable from a reminder that had simply not been picked up.
       *
       * So the outcome is forced here as well as inside. FAILED rather than
       * PENDING, because `attempts` is already incremented and a row that keeps
       * throwing should stop rather than loop — and `lastError` says what
       * happened, which is the question somebody will actually ask.
       */
      let outcome: 'SENT' | 'SKIPPED' | 'FAILED';
      try {
        outcome = await this.sendOne(clinicId, reminderId, credential);
      } catch (error) {
        this.logger.error(`Reminder ${reminderId} threw: ${String(error)}`);
        outcome = 'FAILED';
        await this.finish(clinicId, reminderId, {
          status: 'FAILED',
          error: `The reminder could not be processed: ${String(error)}`,
        }).catch(() =>
          // Even the bookkeeping failed. Logged and left to the sweep, which is
          // the only honest remaining option.
          this.logger.error(`Reminder ${reminderId} could not be marked failed.`),
        );
      }

      if (outcome === 'SENT') result.sent += 1;
      else if (outcome === 'SKIPPED') result.skipped += 1;
      else result.failed += 1;
    }

    return result;
  }

  /**
   * Sends one claimed reminder and records what happened.
   *
   * Every exit writes a terminal status. A reminder left in `SENDING` because a
   * branch returned early is a reminder that only the stale-claim sweep will
   * ever touch again, fifteen minutes later — so the outcome is set on every
   * path, including the ones that decide not to send.
   */
  private async sendOne(
    clinicId: string,
    reminderId: string,
    credential: { wabaId: string; phoneNumberId: string; accessToken: string } | null,
  ): Promise<'SENT' | 'SKIPPED' | 'FAILED'> {
    const context = await this.tenantDb.runAs(clinicId, null, async (tx) => {
      const [row] = await tx
        .select({
          reminder: schema.scheduledReminder,
          patientName: schema.patient.fullName,
          patientMobile: schema.patient.mobileE164,
          followUpAfterDays: schema.encounter.followUpAfterDays,
          followUpInstructions: schema.encounter.followUpInstructions,
        })
        .from(schema.scheduledReminder)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.scheduledReminder.patientId))
        .leftJoin(
          schema.encounter,
          eq(schema.encounter.id, schema.scheduledReminder.encounterId),
        )
        .where(eq(schema.scheduledReminder.id, reminderId))
        .limit(1);
      if (!row) return null;

      /*
       * Consent, checked at SEND time rather than at scheduling time.
       *
       * A patient who withdrew consent between the consultation and the
       * reminder must not receive it, and the whole point of a withdrawal is
       * that it takes effect without anyone remembering to go and cancel
       * things. ACTIVE, not withdrawn, and not expired — an expired consent is
       * not consent.
       */
      const [consent] = await tx
        .select({ id: schema.consent.id })
        .from(schema.consent)
        .where(
          and(
            eq(schema.consent.patientId, row.reminder.patientId),
            eq(schema.consent.scope, 'WHATSAPP_COMMUNICATION'),
            eq(schema.consent.status, 'ACTIVE'),
            isNull(schema.consent.withdrawnAt),
            or(
              isNull(schema.consent.expiresAt),
              gt(schema.consent.expiresAt, new Date()),
            ),
          ),
        )
        .limit(1);

      /*
       * Has the patient already booked the follow-up?
       *
       * Reminding somebody to book an appointment they have booked is the kind
       * of message that makes a clinic switch reminders off. Checked at send
       * time because it can only be known then.
       */
      const [booked] = await tx
        .select({ id: schema.appointment.id })
        .from(schema.appointment)
        .where(
          and(
            eq(schema.appointment.patientId, row.reminder.patientId),
            gt(schema.appointment.scheduledStart, new Date()),
            sql`${schema.appointment.status} NOT IN ('CANCELLED', 'NOSHOW')`,
          ),
        )
        .limit(1);

      const [template] = await tx
        .select()
        .from(schema.messageTemplate)
        .where(
          and(
            eq(schema.messageTemplate.name, RemindersService.TEMPLATE_NAME),
            eq(schema.messageTemplate.status, 'APPROVED'),
          ),
        )
        .limit(1);

      const settings = await this.settingsFor(tx);

      return {
        ...row,
        hasConsent: Boolean(consent),
        alreadyBooked: Boolean(booked),
        template: template ?? null,
        settings,
      };
    });

    if (!context) {
      /*
       * The row, or its patient, vanished between the claim and here.
       *
       * Still written to a terminal status rather than returned from silently:
       * if the reminder row itself is gone the update affects nothing, and if it
       * is the PATIENT that is gone — merged, or deleted — then the row is still
       * there, claimed, and would sit in SENDING for ever.
       */
      await this.finish(clinicId, reminderId, {
        status: 'SKIPPED',
        error: 'The reminder or its patient no longer exists.',
      });
      return 'SKIPPED';
    }

    /* --- The reasons not to send, each recorded as what it is --- */

    if (!context.hasConsent) {
      await this.finish(clinicId, reminderId, {
        status: 'SKIPPED',
        error: 'The patient has not consented to WhatsApp messages.',
      });
      return 'SKIPPED';
    }

    if (context.alreadyBooked) {
      await this.finish(clinicId, reminderId, {
        status: 'SKIPPED',
        error: 'The patient has already booked a future appointment.',
      });
      return 'SKIPPED';
    }

    if (!context.patientMobile) {
      await this.finish(clinicId, reminderId, {
        status: 'FAILED',
        error: 'No mobile number on the patient record.',
      });
      return 'FAILED';
    }

    if (context.reminder.channel === 'EMAIL') {
      /*
       * Modelled, not implemented, and it says so.
       *
       * There is no mail provider in this deployment. A clear failure is the
       * honest outcome — a reminder that silently never sends is discovered when
       * a patient does not come back.
       */
      await this.finish(clinicId, reminderId, {
        status: 'FAILED',
        error: 'Email reminders are not available: this deployment has no mail provider.',
      });
      return 'FAILED';
    }

    if (!context.template) {
      await this.finish(clinicId, reminderId, {
        status: 'FAILED',
        error:
          `No approved WhatsApp template named "${RemindersService.TEMPLATE_NAME}". ` +
          'Add it under Settings → Message templates and have Meta approve it.',
      });
      return 'FAILED';
    }

    if (!credential) {
      await this.finish(clinicId, reminderId, {
        status: 'FAILED',
        error: 'This clinic has no WhatsApp number connected.',
      });
      return 'FAILED';
    }

    /* --- The send --- */

    const variables = [
      context.patientName,
      formatInClinicDate(context.reminder.dueAt, context.settings),
    ];

    let providerMessageId: string | null = null;
    let failure: string | null = null;

    try {
      const sent = await this.whatsapp.sendTemplate(credential, {
        toE164: context.patientMobile,
        templateName: context.template.name,
        language: context.template.language,
        variables,
      });
      providerMessageId = sent.providerMessageId;
    } catch (error) {
      failure =
        error instanceof WhatsAppError ? error.message : 'That reminder could not be sent.';
    }

    const communicationId = await this.recordMessage(clinicId, {
      reminderId,
      patientId: context.reminder.patientId,
      encounterId: context.reminder.encounterId,
      template: context.template,
      providerMessageId,
      failure,
    });

    await this.finish(clinicId, reminderId, {
      status: failure ? 'FAILED' : 'SENT',
      error: failure,
      communicationId,
    });

    /*
     * The copy to the clinic's own number, after the patient's and never
     * instead of it.
     *
     * A failure here is logged and does not change the reminder's outcome: the
     * patient got their message, which is what the reminder was for, and
     * marking it failed because the clinic's copy bounced would hide a success.
     */
    if (!failure && context.reminder.notifyClinic) {
      await this.notifyClinicNumber(
        { ...context, template: context.template },
        credential,
      ).catch((error) =>
        this.logger.warn(`Clinic copy for reminder ${reminderId} failed: ${String(error)}`),
      );
    }

    return failure ? 'FAILED' : 'SENT';
  }

  /** Writes the `communication` row, which owns the delivery lifecycle. */
  private async recordMessage(
    clinicId: string,
    args: {
      reminderId: string;
      patientId: string;
      /** The consultation that asked for the reminder, where there was one. */
      encounterId: string | null;
      template: typeof schema.messageTemplate.$inferSelect;
      providerMessageId: string | null;
      failure: string | null;
    },
  ): Promise<string | null> {
    return this.tenantDb.runAs(clinicId, null, async (tx) => {
      const [message] = await tx
        .insert(schema.communication)
        .values({
          clinicId,
          patientId: args.patientId,
          /*
           * Linked to the consultation, so "what did we send this patient about
           * this visit" is answerable from the message side too. The column is
           * nullable and its own comment says reminders are why.
           */
          encounterId: args.encounterId,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          status: args.failure ? 'FAILED' : 'SENT',
          messageKind: 'TEMPLATE',
          templateName: args.template.name,
          templateLanguage: args.template.language,
          body: args.template.body,
          providerMessageId: args.providerMessageId,
          providerErrorMessage: args.failure,
          sentAt: args.failure ? null : new Date(),
          failedAt: args.failure ? new Date() : null,
          /*
           * Derived from the reminder, so a retry cannot send a second copy.
           *
           * This is the layer under the claim: if two runners somehow both got
           * this row, the second insert conflicts here and the patient receives
           * one message.
           */
          idempotencyKey: `reminder-${args.reminderId}`,
        })
        .onConflictDoNothing()
        .returning({ id: schema.communication.id });

      if (message) return message.id;

      // Conflicted: a previous attempt already recorded this one. Return the
      // existing row so the reminder still points at the real message.
      const [existing] = await tx
        .select({ id: schema.communication.id })
        .from(schema.communication)
        .where(eq(schema.communication.idempotencyKey, `reminder-${args.reminderId}`))
        .limit(1);
      return existing?.id ?? null;
    });
  }

  /**
   * The optional copy to the clinic's own number.
   *
   * Sent as the same approved template, because a free-form message is only
   * permitted inside a 24-hour service window the clinic's own number has not
   * opened. Not recorded against a patient: the `communication` row would
   * otherwise claim the patient was messaged twice.
   */
  private async notifyClinicNumber(
    context: {
      patientName: string;
      settings: ReminderSettings;
      /*
       * Non-null. The caller has already failed the reminder when there is no
       * approved template, so by the time the clinic copy is considered there
       * certainly is one — and narrowing it here rather than re-checking keeps
       * the "no template" decision in exactly one place.
       */
      template: typeof schema.messageTemplate.$inferSelect;
      reminder: { id: string; dueAt: Date };
    },
    credential: { wabaId: string; phoneNumberId: string; accessToken: string },
  ): Promise<void> {
    const to = context.settings.clinicNotifyMobileE164;
    if (!to) return;

    await this.whatsapp.sendTemplate(credential, {
      toE164: to,
      templateName: context.template.name,
      language: context.template.language,
      variables: [
        context.patientName,
        formatInClinicDate(context.reminder.dueAt, context.settings),
      ],
    });

    this.logger.log(`Reminder ${context.reminder.id}: clinic copy sent to ${mask(to)}`);
  }

  /** The one place a claimed reminder reaches a terminal status. */
  private async finish(
    clinicId: string,
    reminderId: string,
    outcome: { status: 'SENT' | 'FAILED' | 'SKIPPED'; error?: string | null; communicationId?: string | null },
  ): Promise<void> {
    await this.tenantDb.runAs(clinicId, null, (tx) =>
      tx
        .update(schema.scheduledReminder)
        .set({
          status: outcome.status,
          lastError: outcome.error ?? null,
          sentAt: outcome.status === 'SENT' ? new Date() : null,
          communicationId: outcome.communicationId ?? null,
          claimedAt: null,
        })
        .where(eq(schema.scheduledReminder.id, reminderId)),
    );
  }
}

/* -------------------------------------------------------------------------- */

function serialise(
  reminder: typeof schema.scheduledReminder.$inferSelect,
  patientName: string,
  patientMobile: string | null,
): ScheduledReminder {
  return {
    id: reminder.id,
    patientId: reminder.patientId,
    patientName,
    patientMobile,
    kind: reminder.kind,
    encounterId: reminder.encounterId,
    appointmentId: reminder.appointmentId,
    dueAt: reminder.dueAt.toISOString(),
    channel: reminder.channel,
    status: reminder.status,
    attempts: reminder.attempts,
    lastError: reminder.lastError,
    sentAt: reminder.sentAt?.toISOString() ?? null,
    communicationId: reminder.communicationId,
    notifyClinic: reminder.notifyClinic,
  };
}

async function clinicTimezone(tx: TenantTx): Promise<{ timezone: string }> {
  const [row] = await tx
    .select({ timezone: schema.clinic.timezone })
    .from(schema.clinic)
    .limit(1);
  return { timezone: row?.timezone ?? 'Asia/Kolkata' };
}

/**
 * When a follow-up reminder should go out.
 *
 * The follow-up date is N days after the consultation; the reminder goes out
 * `leadTimeDays` before that, at the start of the clinic's quiet-hours window.
 *
 * ALL OF IT IN THE CLINIC'S OWN TIMEZONE. "Nine in the morning" is nine where
 * the clinic is, and computing it in UTC puts an Asia/Kolkata clinic's reminders
 * at half past two in the afternoon.
 */
export function followUpDueAt(
  followUpAfterDays: number,
  settings: ReminderSettings,
  timezone: string,
  from: Date,
): Date {
  const offsetMs = offsetFor(from, timezone);

  // The local date of the follow-up, computed on the clinic's calendar.
  const localNow = new Date(from.getTime() + offsetMs);
  const followUpLocalDay = new Date(localNow);
  followUpLocalDay.setUTCDate(
    followUpLocalDay.getUTCDate() + followUpAfterDays - settings.leadTimeDays,
  );

  /*
   * Clamped into the quiet-hours window rather than refused.
   *
   * A reminder computed for 3am is moved to the start of the window, not
   * dropped. Quiet hours are not politeness: a WhatsApp business number that
   * messages people at 3am collects "report business" taps, and Meta's quality
   * rating decides whether the clinic's messages are delivered at all.
   */
  followUpLocalDay.setUTCHours(settings.quietHoursStart, 0, 0, 0);

  return new Date(followUpLocalDay.getTime() - offsetMs);
}

/** The offset to add to a UTC instant to get the clinic's wall clock. */
function offsetFor(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (
    Date.UTC(
      read('year'),
      read('month') - 1,
      read('day') % 32,
      read('hour') % 24,
      read('minute'),
      read('second'),
    ) - instant.getTime()
  );
}

/** The follow-up date as the patient should read it. */
function formatInClinicDate(dueAt: Date, settings: ReminderSettings): string {
  const followUp = new Date(dueAt.getTime() + settings.leadTimeDays * 86_400_000);
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
  }).format(followUp);
}

/** A phone number in a log line. Never the whole thing. */
function mask(e164: string): string {
  return e164.length <= 4 ? '****' : `${e164.slice(0, 3)}…${e164.slice(-3)}`;
}
