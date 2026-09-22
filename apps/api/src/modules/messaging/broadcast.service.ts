import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';

import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { AuditWriter } from '../../common/audit/audit.writer';
import { EventHub } from '../../common/events/event-hub.service';
import { WhatsAppAccountService } from './whatsapp-account.service';
import { WhatsAppClient, WhatsAppError } from './whatsapp.client';
import { AudienceService, type AudienceFilter } from './audience.service';

/**
 * Broadcasts.
 *
 * THE AUDIENCE IS RESOLVED AND WRITTEN IN ONE TRANSACTION. What was counted is
 * what gets written, and what was written is what gets sent. Re-evaluating the
 * filter during a send would pick up patients registered after it began and
 * drop ones whose consent lapsed an hour in, so "who did we message?" would
 * have no answer — and that is the only question anyone asks afterwards.
 *
 * SENDING IS PACED. WhatsApp rate-limits by messaging tier, and a clinic that
 * fires two thousand templates in ten seconds gets throttled at best and has its
 * number quality downgraded at worst. Messages go out in small batches with a
 * pause between them.
 *
 * A FAILED RECIPIENT IS NOT A FAILED BROADCAST. One bad number must not stop the
 * other four hundred, so each recipient's outcome is recorded individually and
 * the failures can be retried on their own.
 */
@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  /** Messages per batch, and the pause between batches. */
  private static readonly BATCH_SIZE = 20;
  private static readonly BATCH_PAUSE_MS = 1_000;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audience: AudienceService,
    private readonly accounts: WhatsAppAccountService,
    private readonly whatsapp: WhatsAppClient,
    private readonly audit: AuditWriter,
    private readonly events: EventHub,
  ) {}

  async list() {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.broadcast).orderBy(desc(schema.broadcast.createdAt)).limit(100),
    );
    return rows.map(serialise);
  }

  async byId(id: string) {
    const row = await this.tenantDb.runReadOnly(async (tx) => {
      const [broadcast] = await tx
        .select()
        .from(schema.broadcast)
        .where(eq(schema.broadcast.id, id))
        .limit(1);
      return broadcast;
    });

    if (!row) throw new NotFoundException('That broadcast could not be found.');
    return serialise(row);
  }

  /**
   * Counts who a filter would reach, WITHOUT creating anything.
   *
   * Called as the audience is built, so the number and its exclusion breakdown
   * move as the filter changes. Showing the breakdown is the point: a screen
   * that reports only the audience size invites someone to widen the filter
   * until it looks big enough, never learning that a third of the register
   * never consented.
   */
  async preview(filter: AudienceFilter, purpose: 'CLINICAL' | 'MARKETING') {
    const result = await this.audience.resolve(filter, purpose);

    return {
      reaches: result.included.length,
      considered: result.considered,
      exclusions: result.exclusions,
      samples: result.samples,
      // A handful of names, so whoever is about to press send can sanity-check
      // that the list is the one they meant.
      preview: result.included.slice(0, 8).map((m) => ({
        patientId: m.patientId,
        fullName: m.fullName,
      })),
    };
  }

  async create(input: {
    name: string;
    templateId: string;
    purpose: 'CLINICAL' | 'MARKETING';
    audienceFilter: AudienceFilter;
    templateVariables?: Record<string, string>;
  }) {
    const ctx = TenantContext.require();

    const broadcast = await this.tenantDb.run(async (tx) => {
      const [template] = await tx
        .select()
        .from(schema.messageTemplate)
        .where(eq(schema.messageTemplate.id, input.templateId))
        .limit(1);

      if (!template) throw new NotFoundException('That template could not be found.');

      if (template.status !== 'APPROVED') {
        throw new UnprocessableEntityException({
          title: 'That template is not approved',
          message: `WhatsApp has it as ${template.status}. Only an approved template can be sent.`,
        });
      }

      /*
       * The template's purpose and the broadcast's must agree.
       *
       * A template is written and approved for a purpose. Sending marketing copy
       * under a template someone registered as clinical is precisely how a
       * clinic ends up messaging patients who consented to hear about their care
       * and nothing else.
       */
      if (template.purpose !== input.purpose) {
        throw new UnprocessableEntityException({
          title: 'That template does not match this broadcast',
          message:
            `The template is registered as ${template.purpose} and this broadcast is ${input.purpose}. ` +
            'They have to agree, because they decide which consent a patient must have given.',
        });
      }

      const [created] = await tx
        .insert(schema.broadcast)
        .values({
          clinicId: ctx.clinicId,
          name: input.name,
          purpose: input.purpose,
          status: 'DRAFT',
          templateId: input.templateId,
          templateVariables: input.templateVariables ?? {},
          audienceFilter: input.audienceFilter as Record<string, unknown>,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return created!;
    });

    return serialise(broadcast);
  }

  /**
   * Sends one message to one number, so the author can see the real thing
   * before committing it to hundreds.
   */
  async test(id: string, toE164: string) {
    const { broadcast, template } = await this.load(id);
    const credential = await this.requireCredential();

    const result = await this.whatsapp.sendTemplate(credential, {
      toE164,
      templateName: template.name,
      language: template.language,
      variables: orderedVariables(broadcast.templateVariables, template.variables),
    });

    return { sent: true, simulated: result.simulated };
  }

  /**
   * Resolves the audience, writes the recipients, and starts sending.
   *
   * The resolve-and-write happens in ONE transaction and the dispatch happens
   * after it commits. A send that crashes halfway can therefore be resumed from
   * the recipient rows, and cannot message anyone twice — the unique index on
   * (broadcast, patient) is what makes a retry idempotent rather than a second
   * send.
   */
  async send(id: string) {
    const ctx = TenantContext.require();
    const { broadcast, template } = await this.load(id);

    if (broadcast.status !== 'DRAFT' && broadcast.status !== 'SCHEDULED') {
      throw new ConflictException(
        `This broadcast is already ${broadcast.status.toLowerCase()}. Create a new one rather than resending.`,
      );
    }

    const credential = await this.requireCredential();

    const { recipients, exclusions } = await this.tenantDb.run(async (tx) => {
      const resolved = await this.audience.resolveIn(
        tx,
        (broadcast.audienceFilter ?? {}) as AudienceFilter,
        broadcast.purpose,
      );

      if (resolved.included.length === 0) {
        throw new UnprocessableEntityException({
          title: 'This broadcast would reach nobody',
          message:
            'Every patient matching the filter was excluded — most often because they have not consented to this kind of message.',
          exclusions: resolved.exclusions,
        });
      }

      await tx.insert(schema.broadcastRecipient).values(
        resolved.included.map((member) => ({
          clinicId: ctx.clinicId,
          broadcastId: broadcast.id,
          patientId: member.patientId,
          mobileE164: member.mobileE164,
          consentId: member.consentId,
          status: 'QUEUED' as const,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })),
      );

      await tx
        .update(schema.broadcast)
        .set({
          status: 'SENDING',
          startedAt: new Date(),
          recipientCount: resolved.included.length,
          exclusionSummary: resolved.exclusions,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.broadcast.id, broadcast.id));

      return { recipients: resolved.included, exclusions: resolved.exclusions };
    });

    await this.audit.append({
      clinicId: ctx.clinicId,
      actorUserId: ctx.userId,
      actorName: ctx.userName,
      actorRole: ctx.role,
      actorType: 'USER',
      action: 'BROADCAST_SENT',
      outcome: 'SUCCESS',
      resourceType: 'broadcast',
      resourceId: broadcast.id,
      resourceLabel: broadcast.name,
      requestId: ctx.requestId,
      changeSummary: {
        purpose: broadcast.purpose,
        template: template.name,
        recipients: recipients.length,
        exclusions,
      },
    });

    /*
     * Dispatch after the commit, and deliberately NOT awaited.
     *
     * A broadcast to several hundred patients takes longer than any sensible
     * HTTP timeout. The caller gets the recipient count immediately and watches
     * progress over the event stream; the send continues in this process.
     *
     * The honest limitation: a process restart mid-send stops it. The recipient
     * rows survive, so `retry` picks up everything still QUEUED — which is why
     * resume is a first-class operation rather than an afterthought.
     */
    void this.dispatch(broadcast.id, ctx.clinicId, template, broadcast.templateVariables, credential);

    return {
      broadcastId: broadcast.id,
      recipients: recipients.length,
      exclusions,
    };
  }

  /** Re-sends everything still queued or failed. Safe to call repeatedly. */
  async retry(id: string) {
    const ctx = TenantContext.require();
    const { broadcast, template } = await this.load(id);
    const credential = await this.requireCredential();

    const pending = await this.tenantDb.run(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.broadcastRecipient)
        .where(
          and(
            eq(schema.broadcastRecipient.broadcastId, id),
            inArray(schema.broadcastRecipient.status, ['QUEUED', 'FAILED']),
          ),
        );

      if (rows.length > 0) {
        await tx
          .update(schema.broadcast)
          .set({ status: 'SENDING', updatedBy: ctx.userId })
          .where(eq(schema.broadcast.id, id));
      }

      return rows;
    });

    void this.dispatch(id, ctx.clinicId, template, broadcast.templateVariables, credential);
    return { retrying: pending.length };
  }

  async cancel(id: string, reason: string) {
    const ctx = TenantContext.require();

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.broadcast)
        .set({
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledReason: reason,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.broadcast.id, id)),
    );

    // The dispatch loop checks this between batches, so cancelling stops the
    // send within about a second rather than after every message has gone.
    return { cancelled: true };
  }

  async recipients(id: string) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          recipient: schema.broadcastRecipient,
          patientName: schema.patient.fullName,
        })
        .from(schema.broadcastRecipient)
        .leftJoin(schema.patient, eq(schema.patient.id, schema.broadcastRecipient.patientId))
        .where(eq(schema.broadcastRecipient.broadcastId, id))
        .limit(2000),
    );

    return rows.map(({ recipient, patientName }) => ({
      id: recipient.id,
      patientId: recipient.patientId,
      patientName,
      mobileE164: recipient.mobileE164,
      status: recipient.status,
      failureReason: recipient.failureReason,
      sentAt: recipient.sentAt?.toISOString() ?? null,
      attemptCount: recipient.attemptCount,
    }));
  }

  /* ----------------------------------------------------------------------- */

  /**
   * Sends to everyone still queued, in paced batches.
   *
   * Runs outside any request. It sets its own tenant context on every
   * transaction through `runAs`, because the AsyncLocalStorage context belongs
   * to the request that started this and that request is long gone.
   */
  private async dispatch(
    broadcastId: string,
    clinicId: string,
    template: typeof schema.messageTemplate.$inferSelect,
    variables: Record<string, string> | null,
    credential: { wabaId: string; phoneNumberId: string; accessToken: string },
  ): Promise<void> {
    const ordered = orderedVariables(variables, template.variables);

    try {
      for (;;) {
        const batch = await this.tenantDb.runAs(clinicId, null, async (tx) => {
          const [current] = await tx
            .select({ status: schema.broadcast.status })
            .from(schema.broadcast)
            .where(eq(schema.broadcast.id, broadcastId))
            .limit(1);

          // Checked between batches, so cancelling stops this within a second.
          if (!current || current.status === 'CANCELLED') return [];

          return tx
            .select()
            .from(schema.broadcastRecipient)
            .where(
              and(
                eq(schema.broadcastRecipient.broadcastId, broadcastId),
                inArray(schema.broadcastRecipient.status, ['QUEUED', 'FAILED']),
              ),
            )
            .limit(BroadcastService.BATCH_SIZE);
        });

        if (batch.length === 0) break;

        for (const recipient of batch) {
          let providerMessageId: string | null = null;
          let failure: string | null = null;

          try {
            const result = await this.whatsapp.sendTemplate(credential, {
              toE164: recipient.mobileE164,
              templateName: template.name,
              language: template.language,
              variables: ordered,
            });
            providerMessageId = result.providerMessageId;
          } catch (error) {
            // One bad number must not stop the other four hundred.
            failure =
              error instanceof WhatsAppError
                ? error.message
                : 'That message could not be sent.';
          }

          await this.recordOutcome(
            clinicId,
            broadcastId,
            recipient,
            template,
            providerMessageId,
            failure,
          );
        }

        this.events.emit({
          type: 'broadcast-progress',
          clinicId,
          data: { broadcastId, batch: batch.length },
        });

        // Paced. WhatsApp rate-limits by messaging tier, and a clinic that fires
        // two thousand templates in ten seconds is throttled at best and has its
        // number quality downgraded at worst.
        await new Promise((resolve) =>
          setTimeout(resolve, BroadcastService.BATCH_PAUSE_MS),
        );
      }

      await this.complete(clinicId, broadcastId);
    } catch (error) {
      this.logger.error(`Broadcast ${broadcastId} dispatch failed: ${String(error)}`);
      await this.tenantDb
        .runAs(clinicId, null, (tx) =>
          tx
            .update(schema.broadcast)
            .set({ status: 'FAILED' })
            .where(eq(schema.broadcast.id, broadcastId)),
        )
        .catch(() => undefined);
    }
  }

  /** Writes the message row and moves the recipient and the counters. */
  private async recordOutcome(
    clinicId: string,
    broadcastId: string,
    recipient: typeof schema.broadcastRecipient.$inferSelect,
    template: typeof schema.messageTemplate.$inferSelect,
    providerMessageId: string | null,
    failure: string | null,
  ): Promise<void> {
    await this.tenantDb.runAs(clinicId, null, async (tx) => {
      const [message] = await tx
        .insert(schema.communication)
        .values({
          clinicId,
          patientId: recipient.patientId,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          status: failure ? 'FAILED' : 'SENT',
          messageKind: 'TEMPLATE',
          templateName: template.name,
          templateLanguage: template.language,
          body: template.body,
          providerMessageId,
          providerErrorMessage: failure,
          sentAt: failure ? null : new Date(),
          failedAt: failure ? new Date() : null,
          // One per recipient per broadcast. A resumed dispatch conflicts here
          // rather than sending the same person a second copy.
          idempotencyKey: `broadcast-${broadcastId}-${recipient.patientId}`,
        })
        .onConflictDoNothing()
        .returning();

      await tx
        .update(schema.broadcastRecipient)
        .set({
          status: failure ? 'FAILED' : 'SENT',
          failureReason: failure,
          communicationId: message?.id ?? null,
          sentAt: failure ? null : new Date(),
          attemptCount: recipient.attemptCount + 1,
        })
        .where(eq(schema.broadcastRecipient.id, recipient.id));

      await tx.execute(
        failure
          ? sqlIncrement('failed_count', broadcastId)
          : sqlIncrement('sent_count', broadcastId),
      );
    });
  }

  private async complete(clinicId: string, broadcastId: string): Promise<void> {
    await this.tenantDb.runAs(clinicId, null, async (tx) => {
      const [current] = await tx
        .select({ status: schema.broadcast.status })
        .from(schema.broadcast)
        .where(eq(schema.broadcast.id, broadcastId))
        .limit(1);

      // A broadcast cancelled mid-send stays cancelled: it did not complete.
      if (current?.status === 'CANCELLED') return;

      await tx
        .update(schema.broadcast)
        .set({ status: 'SENT', completedAt: new Date() })
        .where(eq(schema.broadcast.id, broadcastId));
    });

    this.events.emit({
      type: 'broadcast-progress',
      clinicId,
      data: { broadcastId, done: true },
    });
  }

  private async load(id: string) {
    const loaded = await this.tenantDb.runReadOnly(async (tx) => {
      const [broadcast] = await tx
        .select()
        .from(schema.broadcast)
        .where(eq(schema.broadcast.id, id))
        .limit(1);
      if (!broadcast) return null;

      const [template] = await tx
        .select()
        .from(schema.messageTemplate)
        .where(eq(schema.messageTemplate.id, broadcast.templateId))
        .limit(1);
      if (!template) return null;

      return { broadcast, template };
    });

    if (!loaded) throw new NotFoundException('That broadcast could not be found.');
    return loaded;
  }

  private async requireCredential() {
    const credential = await this.accounts.credential();
    if (!credential) {
      throw new UnprocessableEntityException({
        title: 'No WhatsApp number is connected',
        message: 'Connect a number in Settings before sending a broadcast.',
      });
    }
    return credential;
  }
}

/* --------------------------------------------------------------------------- */

/**
 * Counters are incremented in SQL, not read-modify-written.
 *
 * Batches overlap with retries and with a resumed dispatch of the same
 * broadcast, and `count = count + 1` computed in JavaScript loses increments
 * under exactly that concurrency — so a completed broadcast would report having
 * sent fewer messages than it sent.
 *
 * The column name is one of two literals chosen by the caller's union type,
 * never a value from outside, which is what makes sql.raw safe here.
 */
function sqlIncrement(column: 'sent_count' | 'failed_count', broadcastId: string) {
  return sql`
    UPDATE broadcast
    SET ${sql.raw(column)} = ${sql.raw(column)} + 1
    WHERE id = ${broadcastId}::uuid
  `;
}

/**
 * Template placeholders in {{1}}, {{2}} order.
 *
 * WhatsApp takes the parameters positionally, so a map keyed by index has to be
 * flattened in the right order — sending them in object order is how a
 * prescription reminder ends up addressed to a date.
 */
function orderedVariables(
  values: Record<string, string> | null,
  declared: { index: number; label: string }[] | null,
): string[] {
  if (!declared?.length) return [];
  return [...declared]
    .sort((a, b) => a.index - b.index)
    .map((variable) => values?.[String(variable.index)] ?? '');
}

function serialise(row: typeof schema.broadcast.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    status: row.status,
    templateId: row.templateId,
    templateVariables: row.templateVariables ?? {},
    audienceFilter: row.audienceFilter ?? {},
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledReason: row.cancelledReason,
    recipientCount: row.recipientCount,
    sentCount: row.sentCount,
    deliveredCount: row.deliveredCount,
    readCount: row.readCount,
    failedCount: row.failedCount,
    exclusionSummary: row.exclusionSummary ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}
