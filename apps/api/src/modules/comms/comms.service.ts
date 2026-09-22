import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { isWindowOpen, type Conversation, type Message } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { EventHub } from '../../common/events/event-hub.service';
import { WhatsAppAccountService } from '../messaging/whatsapp-account.service';
import { WhatsAppClient, WhatsAppError } from '../messaging/whatsapp.client';

/**
 * The patient inbox.
 *
 * Two rules from the messaging design carry into every method here:
 *
 *   - THE 24-HOUR WINDOW. Free-form replies are permitted only within 24 hours
 *     of the patient's last inbound message; outside it, only pre-approved
 *     templates go through. It fails SILENTLY at the provider — the message is
 *     simply rejected — so the window is computed from persisted state and
 *     checked before every send, never inferred at dispatch time.
 *
 *   - AN OPT-OUT IS ABSOLUTE. Nothing is sent to a patient who has opted out,
 *     including a prescription. Those fall back to print or a secure link.
 *
 * Nothing in this module can reach an internal clinical note. That isolation is
 * a database grant, not a filter in code.
 */
@Injectable()
export class CommsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly events: EventHub,
    private readonly accounts: WhatsAppAccountService,
    private readonly whatsapp: WhatsAppClient,
  ) {}

  async conversations(filter?: string): Promise<Conversation[]> {
    const rows = await this.tenantDb.runReadOnly((tx) => {
      const conditions = [];
      if (filter === 'unlinked') conditions.push(eq(schema.whatsappConversation.isUnlinked, true));
      if (filter === 'open') conditions.push(eq(schema.whatsappConversation.status, 'OPEN'));

      return tx
        .select({
          conversation: schema.whatsappConversation,
          patientName: schema.patient.fullName,
          assignedTo: schema.appUser.fullName,
        })
        .from(schema.whatsappConversation)
        .leftJoin(schema.patient, eq(schema.patient.id, schema.whatsappConversation.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.whatsappConversation.assignedToUserId))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(schema.whatsappConversation.lastInboundAt))
        .limit(200);
    });

    /*
     * The last message per conversation, in one query.
     *
     * DISTINCT ON rather than a correlated subquery or an N+1 loop: a rail of
     * two hundred conversations would otherwise be two hundred round trips, and
     * this list is refetched on every inbound message.
     *
     * The preview is deliberately truncated HERE rather than in the browser.
     * The rail shows one line, and shipping a full message body — which may be
     * clinical — for every conversation in the clinic to render forty
     * characters of it is more data leaving the server than the screen needs.
     */
    const ids = rows.map((r) => r.conversation.id);
    const previews = new Map<string, string>();

    if (ids.length > 0) {
      const latest = await this.tenantDb.runReadOnly((tx) =>
        tx.execute<{ conversation_id: string; preview: string }>(sql`
          SELECT DISTINCT ON (conversation_id)
                 conversation_id,
                 left(coalesce(body, ''), 120) AS preview
          FROM communication
          -- A Postgres array literal as ONE bind parameter. Not sql.raw with the
          -- ids interpolated: they are server-generated here, but a pattern that
          -- only works because of where its input happens to come from is one
          -- change away from being an injection.
          WHERE conversation_id = ANY(${`{${ids.join(',')}}`}::uuid[])
          ORDER BY conversation_id, queued_at DESC
        `),
      );

      for (const row of latest.rows) {
        if (row.preview) previews.set(row.conversation_id, row.preview);
      }
    }

    return rows.map(({ conversation, patientName, assignedTo }) => ({
      ...serialiseConversation(conversation, patientName, assignedTo),
      lastMessagePreview: previews.get(conversation.id) ?? null,
    }));
  }

  async conversation(id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [row] = await tx
        .select({
          conversation: schema.whatsappConversation,
          patientName: schema.patient.fullName,
          assignedTo: schema.appUser.fullName,
        })
        .from(schema.whatsappConversation)
        .leftJoin(schema.patient, eq(schema.patient.id, schema.whatsappConversation.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.whatsappConversation.assignedToUserId))
        .where(eq(schema.whatsappConversation.id, id))
        .limit(1);

      if (!row) throw new NotFoundException('That conversation could not be found.');

      await tx
        .update(schema.whatsappConversation)
        .set({ isUnread: false, updatedBy: ctx.userId })
        .where(eq(schema.whatsappConversation.id, id));

      const messages = await tx
        .select({ message: schema.communication, sentBy: schema.appUser.fullName })
        .from(schema.communication)
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.communication.sentByUserId))
        .where(eq(schema.communication.conversationId, id))
        .orderBy(asc(schema.communication.queuedAt));

      return {
        conversation: serialiseConversation(
          { ...row.conversation, isUnread: false },
          row.patientName,
          row.assignedTo,
        ),
        messages: messages.map(({ message, sentBy }) => serialiseMessage(message, sentBy)),
      };
    });
  }

  /**
   * Sends a reply, and actually sends it.
   *
   * IT USED TO WRITE A QUEUED ROW AND STOP. The comment said "a background
   * worker performs the dispatch"; there was no worker. Every reply a
   * receptionist typed was recorded and never left the building, while the
   * interface showed a sent message. That is the same failure as storing a
   * safety warning nobody computed: a record asserting something that did not
   * happen.
   *
   * TWO WAYS TO REPLY, and the rule is the provider's rather than ours:
   *
   *   - free text, only inside the 24-hour service window
   *   - an approved template, at ANY time, window or not
   *
   * The second is why templates belong in the composer and not only on a
   * settings screen. "Your report is ready" is a template, it is the most
   * common thing a clinic sends, and it must not require waiting for the
   * patient to write first.
   */
  async reply(
    conversationId: string,
    input: {
      body?: string;
      templateId?: string | null;
      templateVariables?: Record<string, string>;
    },
  ): Promise<Message> {
    const ctx = TenantContext.require();

    const prepared = await this.tenantDb.run(async (tx) => {
      const [conversation] = await tx
        .select()
        .from(schema.whatsappConversation)
        .where(eq(schema.whatsappConversation.id, conversationId))
        .limit(1);
      if (!conversation) throw new NotFoundException('That conversation could not be found.');

      // An opt-out is honoured immediately and has no clinical override.
      if (conversation.isOptedOut) {
        throw new UnprocessableEntityException(
          'This patient has opted out of messages. Print a copy or use a secure link instead.',
        );
      }

      const open = isWindowOpen(conversation.windowExpiresAt?.toISOString() ?? null);

      let template: typeof schema.messageTemplate.$inferSelect | null = null;

      if (input.templateId) {
        const [found] = await tx
          .select()
          .from(schema.messageTemplate)
          .where(eq(schema.messageTemplate.id, input.templateId))
          .limit(1);

        if (!found) throw new NotFoundException('That template could not be found.');

        // Approval lives with the provider and can be withdrawn retroactively,
        // so it is checked at send rather than trusted from when it was chosen.
        if (found.status !== 'APPROVED') {
          throw new UnprocessableEntityException(
            `WhatsApp has that template as ${found.status}. Only an approved template can be sent.`,
          );
        }
        template = found;
      }

      if (!template && !open) {
        throw new UnprocessableEntityException(
          'The 24-hour reply window has closed. Choose an approved template to message this patient.',
        );
      }

      const text = template
        ? fillTemplate(template.body, input.templateVariables ?? {})
        : (input.body ?? '').trim();

      if (!text) throw new UnprocessableEntityException('Type a message first.');

      const [message] = await tx
        .insert(schema.communication)
        .values({
          clinicId: ctx.clinicId,
          patientId: conversation.patientId,
          conversationId,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          // QUEUED until the provider accepts it. Moved to SENT or FAILED below,
          // once the dispatch actually returns.
          status: 'QUEUED',
          messageKind: template ? 'TEMPLATE' : 'SESSION',
          templateName: template?.name ?? null,
          templateLanguage: template?.language ?? null,
          templateVariables: input.templateVariables ?? null,
          body: text,
          sentByUserId: ctx.userId,
          idempotencyKey: `reply-${conversationId}-${Date.now()}`,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      await tx
        .update(schema.whatsappConversation)
        .set({
          lastOutboundAt: new Date(),
          status: 'WAITING',
          isUnread: false,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.whatsappConversation.id, conversationId));

      return { message: message!, conversation, template, text };
    });

    // Dispatch AFTER the commit. The row exists either way, so a provider
    // refusal leaves a FAILED message on the thread rather than losing what
    // someone typed.
    const sent = await this.dispatch(prepared);

    this.announce('message-new', { conversationId, messageId: prepared.message.id });
    this.announce('conversation-changed', { conversationId });

    return serialiseMessage(sent, ctx.userName);
  }

  /**
   * Hands the message to the provider and records what came back.
   *
   * Never throws. The message is already on the thread; a refusal is
   * information to show beside it, not a reason to fail the request and leave
   * the sender wondering whether it went.
   */
  private async dispatch(prepared: {
    message: typeof schema.communication.$inferSelect;
    conversation: typeof schema.whatsappConversation.$inferSelect;
    template: typeof schema.messageTemplate.$inferSelect | null;
    text: string;
  }): Promise<typeof schema.communication.$inferSelect> {
    const { message, conversation, template, text } = prepared;

    let providerMessageId: string | null = null;
    let failure: string | null = null;

    try {
      const credential = await this.accounts.credential();
      if (!credential) {
        failure = 'No WhatsApp number is connected. Connect one in Settings.';
      } else if (template) {
        const result = await this.whatsapp.sendTemplate(credential, {
          toE164: conversation.counterpartyE164,
          templateName: template.name,
          language: template.language,
          variables: orderedTemplateVariables(
            message.templateVariables as Record<string, string> | null,
            template.variables,
          ),
        });
        providerMessageId = result.providerMessageId;
      } else {
        const result = await this.whatsapp.sendText(credential, {
          toE164: conversation.counterpartyE164,
          body: text,
        });
        providerMessageId = result.providerMessageId;
      }
    } catch (error) {
      failure =
        error instanceof WhatsAppError ? error.message : 'That message could not be sent.';
    }

    const [updated] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.communication)
        .set({
          status: failure ? 'FAILED' : 'SENT',
          providerMessageId,
          providerErrorMessage: failure,
          sentAt: failure ? null : new Date(),
          failedAt: failure ? new Date() : null,
        })
        .where(eq(schema.communication.id, message.id))
        .returning(),
    );

    return updated ?? message;
  }

  /**
   * Announces a change to everyone in this clinic with the inbox open.
   *
   * Identifiers only — never a body, a name or a number. The browser refetches
   * through the ordinary authenticated endpoints, so a delivery bug leaks an id
   * at worst and a recipient who cannot fetch the row learns nothing from it.
   */
  private announce(
    type: 'message-new' | 'conversation-changed' | 'message-status',
    data: Record<string, string | number | boolean | null>,
  ) {
    const ctx = TenantContext.require();
    this.events.emit({ type, clinicId: ctx.clinicId, data });
  }

  /**
   * Links a conversation to a patient.
   *
   * The unlinked queue is a first-class path, not an error log: one mobile
   * number routinely serves an entire family here, so an inbound message
   * matching several patients is as common as one matching none.
   */
  async link(conversationId: string, patientId: string): Promise<Conversation> {
    const ctx = TenantContext.require();

    const conversation = await this.tenantDb.run(async (tx) => {
      const [patient] = await tx
        .select()
        .from(schema.patient)
        .where(eq(schema.patient.id, patientId))
        .limit(1);
      if (!patient) throw new NotFoundException('That patient could not be found.');

      const [updated] = await tx
        .update(schema.whatsappConversation)
        .set({ patientId, isUnlinked: false, updatedBy: ctx.userId })
        .where(eq(schema.whatsappConversation.id, conversationId))
        .returning();

      if (!updated) throw new NotFoundException('That conversation could not be found.');

      // Messages already received become part of that patient's record.
      await tx
        .update(schema.communication)
        .set({ patientId, updatedBy: ctx.userId })
        .where(eq(schema.communication.conversationId, conversationId));

      return serialiseConversation(updated, patient.fullName, null);
    });

    // It has left the unlinked queue, so every open inbox should stop showing
    // it there — including the one belonging to whoever is halfway through
    // linking the same conversation on another screen.
    this.announce('conversation-changed', { conversationId, linked: true });

    return conversation;
  }

  async unreadCount(): Promise<number> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.whatsappConversation)
        .where(eq(schema.whatsappConversation.isUnread, true)),
    );
    return rows[0]?.count ?? 0;
  }

  async account() {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.whatsappAccount)
        .where(eq(schema.whatsappAccount.isActive, true))
        .limit(1),
    );

    const account = rows[0];
    if (!account) return null;

    return {
      id: account.id,
      displayPhoneE164: account.displayPhoneE164,
      verifiedName: account.verifiedName,
      qualityRating: (account.qualityRating ?? 'UNKNOWN') as 'GREEN',
      messagingTier: account.messagingTier,
      localStorageRegion: account.localStorageRegion,
      isActive: account.isActive,
      connectedAt: account.createdAt.toISOString(),
    };
  }
}

function serialiseConversation(
  row: typeof schema.whatsappConversation.$inferSelect,
  patientName: string | null,
  assignedTo: string | null,
): Conversation {
  return {
    id: row.id,
    patientId: row.patientId,
    patientName,
    counterpartyE164: row.counterpartyE164,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: row.lastOutboundAt?.toISOString() ?? null,
    windowExpiresAt: row.windowExpiresAt?.toISOString() ?? null,
    status: row.status,
    isUnread: row.isUnread,
    assignedToUserId: row.assignedToUserId,
    assignedToName: assignedTo,
    isUnlinked: row.isUnlinked,
    candidatePatientIds: [],
    isOptedOut: row.isOptedOut,
    lastMessagePreview: null,
    unreadCount: row.isUnread ? 1 : 0,
  } as Conversation;
}

function serialiseMessage(
  row: typeof schema.communication.$inferSelect,
  sentBy: string | null,
): Message {
  return {
    ...row,
    queuedAt: row.queuedAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    documentTitle: null,
    sentByName: sentBy,
  } as unknown as Message;
}

/**
 * Substitutes {{1}}, {{2}} and so on into an approved body.
 *
 * What is STORED and shown is the filled text, because that is what the patient
 * received. A thread showing "Namaste {{1}}" months later is a record of
 * nothing. The positional parameters go to the provider separately.
 */
function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(
    /\{\{\s*(\d+)\s*\}\}/g,
    (match, index: string) => values[index] ?? match,
  );
}

/**
 * Template parameters in {{1}}, {{2}} order.
 *
 * The provider takes them positionally, so a map keyed by index has to be
 * flattened in the right order — object order is how a reminder ends up
 * addressed to a date.
 */
function orderedTemplateVariables(
  values: Record<string, string> | null,
  declared: { index: number; label: string }[] | null,
): string[] {
  if (!declared?.length) return [];
  return [...declared]
    .sort((a, b) => a.index - b.index)
    .map((variable) => values?.[String(variable.index)] ?? '');
}
