import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { isWindowOpen, type Conversation, type Message } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';

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
  constructor(private readonly tenantDb: TenantDb) {}

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

    return rows.map(({ conversation, patientName, assignedTo }) =>
      serialiseConversation(conversation, patientName, assignedTo),
    );
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

  async reply(conversationId: string, body: string, templateName: string | null): Promise<Message> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
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

      if (!open && !templateName) {
        throw new UnprocessableEntityException(
          'The 24-hour reply window has closed. Choose an approved template to message this patient.',
        );
      }

      const [message] = await tx
        .insert(schema.communication)
        .values({
          clinicId: ctx.clinicId,
          patientId: conversation.patientId,
          conversationId,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          // QUEUED, not SENT. A background worker performs the dispatch and
          // moves it on; claiming SENT here would be a lie the delivery
          // reconciliation would later contradict.
          status: 'QUEUED',
          messageKind: open ? 'SESSION' : 'TEMPLATE',
          templateName: open ? null : templateName,
          body,
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
          updatedBy: ctx.userId,
        })
        .where(eq(schema.whatsappConversation.id, conversationId));

      return serialiseMessage(message!, ctx.userName);
    });
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

    return this.tenantDb.run(async (tx) => {
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
