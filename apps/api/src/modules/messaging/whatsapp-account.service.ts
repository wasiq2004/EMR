import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import * as schema from '@emr/db/schema';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { SecretBoxService } from '../../common/crypto/secret-box.service';
import { AuditWriter } from '../../common/audit/audit.writer';
import {
  WhatsAppClient,
  WhatsAppError,
  countPlaceholders,
  type WhatsAppCredential,
} from './whatsapp.client';

/**
 * Connecting, verifying and disconnecting a clinic's WhatsApp number.
 *
 * VERIFY BEFORE STORE. The credential is checked against the provider before a
 * row is written, so a mistyped token fails in the form with the value still on
 * screen rather than silently at 9am when the first reminder does not go out.
 *
 * THE TOKEN IS NEVER RETURNED. Not to the screen that entered it, not to an
 * administrator, not masked-but-recoverable. It goes in encrypted and comes out
 * only inside this process on the way to the provider. What the interface gets
 * is the last four characters, which is enough to tell two numbers apart and
 * useless to anyone who intercepts it.
 */
@Injectable()
export class WhatsAppAccountService {
  private readonly logger = new Logger(WhatsAppAccountService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly secrets: SecretBoxService,
    private readonly whatsapp: WhatsAppClient,
    private readonly audit: AuditWriter,
  ) {}

  /** The connected number, or null. Never includes the token. */
  async current() {
    const account = await this.tenantDb.runReadOnly((tx) => this.activeAccount(tx));
    if (!account) return null;

    return {
      id: account.id,
      wabaId: account.wabaId,
      phoneNumberId: account.phoneNumberId,
      displayPhoneE164: account.displayPhoneE164,
      verifiedName: account.verifiedName,
      qualityRating: account.qualityRating,
      messagingTier: account.messagingTier,
      localStorageRegion: account.localStorageRegion,
      isActive: account.isActive,
      connectedAt: account.createdAt.toISOString(),
      /*
       * Whether this deployment can actually send.
       *
       * A row can exist with no usable token — the seed writes one so the demo
       * has an inbox — and the difference between "connected" and "will send"
       * is the single most important thing this screen communicates.
       */
      canSend: Boolean(this.secrets.open(account.accessTokenEncrypted)),
      tokenHint: this.tokenHint(account.accessTokenEncrypted),
    };
  }

  /**
   * Connects a number, replacing whatever was connected before.
   *
   * One active number per clinic, deliberately. A clinic in this segment has one
   * published number; supporting several would mean every send, every
   * conversation and every broadcast has to carry which number it belongs to,
   * and the cost of that lands on screens used by receptionists.
   */
  async connect(input: {
    wabaId: string;
    phoneNumberId: string;
    accessToken: string;
  }) {
    const ctx = TenantContext.require();

    const credential: WhatsAppCredential = {
      wabaId: input.wabaId.trim(),
      phoneNumberId: input.phoneNumberId.trim(),
      accessToken: input.accessToken.trim(),
    };

    if (!credential.accessToken) {
      throw new BadRequestException('Enter the access token.');
    }

    // Fails here, in the form, rather than at the first send.
    let verified;
    try {
      verified = await this.whatsapp.verify(credential);
    } catch (error) {
      await this.audit.append({
        clinicId: ctx.clinicId,
        actorUserId: ctx.userId,
        actorName: ctx.userName,
        actorRole: ctx.role,
        actorType: 'USER',
        action: 'WHATSAPP_CONNECT_FAILED',
        outcome: 'MINOR_FAILURE',
        outcomeDescription:
          error instanceof WhatsAppError ? error.message : 'Verification failed.',
        requestId: ctx.requestId,
      });

      throw new UnprocessableEntityException({
        title: 'That number could not be verified',
        message:
          error instanceof WhatsAppError
            ? error.message
            : 'WhatsApp did not accept those details.',
      });
    }

    const sealed = this.secrets.seal(credential.accessToken);

    const account = await this.tenantDb.run(async (tx) => {
      // Retire the previous one rather than deleting it: its conversations and
      // messages reference it, and the history of which number a clinic used is
      // part of the record.
      await tx
        .update(schema.whatsappAccount)
        .set({ isActive: false, updatedBy: ctx.userId })
        .where(eq(schema.whatsappAccount.isActive, true));

      const [row] = await tx
        .insert(schema.whatsappAccount)
        .values({
          clinicId: ctx.clinicId,
          wabaId: credential.wabaId,
          phoneNumberId: credential.phoneNumberId,
          displayPhoneE164: verified.displayPhoneE164,
          verifiedName: verified.verifiedName,
          accessTokenEncrypted: sealed,
          qualityRating: verified.qualityRating,
          messagingTier: verified.messagingTier,
          localStorageRegion: 'India',
          isActive: true,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return row!;
    });

    await this.audit.append({
      clinicId: ctx.clinicId,
      actorUserId: ctx.userId,
      actorName: ctx.userName,
      actorRole: ctx.role,
      actorType: 'USER',
      action: 'WHATSAPP_CONNECTED',
      outcome: 'SUCCESS',
      resourceType: 'whatsapp_account',
      resourceId: account.id,
      resourceLabel: verified.displayPhoneE164,
      requestId: ctx.requestId,
    });

    // Templates are what makes the number useful. Pulling them now means the
    // administrator lands on a screen that already knows what can be sent.
    const templates = await this.syncTemplates().catch((error) => {
      this.logger.warn(`Template sync after connect failed: ${String(error)}`);
      return { synced: 0, approved: 0 };
    });

    return { account: await this.current(), templates };
  }

  /**
   * Disconnects the number.
   *
   * Deactivates and DESTROYS THE TOKEN, rather than deleting the row. The
   * conversations and messages sent through it are clinical record and must
   * survive; the credential must not. Overwriting it means a later database
   * leak cannot recover a token that was disconnected months earlier.
   */
  async disconnect() {
    const ctx = TenantContext.require();

    const account = await this.tenantDb.run(async (tx) => {
      const existing = await this.activeAccount(tx);
      if (!existing) throw new NotFoundException('No WhatsApp number is connected.');

      await tx
        .update(schema.whatsappAccount)
        .set({
          isActive: false,
          accessTokenEncrypted: '',
          suspendedAt: new Date(),
          updatedBy: ctx.userId,
        })
        .where(eq(schema.whatsappAccount.id, existing.id));

      return existing;
    });

    await this.audit.append({
      clinicId: ctx.clinicId,
      actorUserId: ctx.userId,
      actorName: ctx.userName,
      actorRole: ctx.role,
      actorType: 'USER',
      action: 'WHATSAPP_DISCONNECTED',
      outcome: 'SUCCESS',
      resourceType: 'whatsapp_account',
      resourceId: account.id,
      resourceLabel: account.displayPhoneE164,
      requestId: ctx.requestId,
    });

    return { disconnected: true };
  }

  /**
   * Re-reads the provider's template list.
   *
   * A template's approval can be withdrawn retroactively and without notice, so
   * the stored status is a mirror rather than a record. Anything the provider no
   * longer lists is marked DISABLED instead of deleted — a broadcast sent last
   * month references it, and that history has to stay readable.
   */
  async syncTemplates(): Promise<{ synced: number; approved: number }> {
    const ctx = TenantContext.require();
    const credential = await this.credential();

    if (!credential) {
      throw new UnprocessableEntityException({
        title: 'No WhatsApp number is connected',
        message: 'Connect a number in Settings before syncing templates.',
      });
    }

    const provider = await this.whatsapp.listTemplates(credential);
    const seen = new Set(provider.map((t) => `${t.name}::${t.language}`));

    await this.tenantDb.run(async (tx) => {
      for (const template of provider) {
        const variables = Array.from({ length: countPlaceholders(template.body) }, (_, i) => ({
          index: i + 1,
          label: `Value ${i + 1}`,
        }));

        await tx
          .insert(schema.messageTemplate)
          .values({
            clinicId: ctx.clinicId,
            name: template.name,
            language: template.language,
            category: template.category,
            status: normaliseStatus(template.status),
            body: template.body,
            headerText: template.headerText,
            footerText: template.footerText,
            buttons: template.buttons,
            variables,
            purpose: template.category?.toUpperCase() === 'MARKETING' ? 'MARKETING' : 'CLINICAL',
            lastSyncedAt: new Date(),
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          })
          .onConflictDoUpdate({
            target: [
              schema.messageTemplate.clinicId,
              schema.messageTemplate.name,
              schema.messageTemplate.language,
            ],
            set: {
              status: normaliseStatus(template.status),
              body: template.body,
              headerText: template.headerText,
              footerText: template.footerText,
              buttons: template.buttons,
              variables,
              category: template.category,
              lastSyncedAt: new Date(),
              updatedBy: ctx.userId,
            },
          });
      }

      // Gone from the provider. Marked, not removed — a broadcast sent last
      // month points at it and that record has to stay readable.
      const stored = await tx.select().from(schema.messageTemplate);
      for (const row of stored) {
        if (seen.has(`${row.name}::${row.language}`)) continue;
        if (row.status === 'DISABLED') continue;

        await tx
          .update(schema.messageTemplate)
          .set({
            status: 'DISABLED',
            statusReason: 'No longer listed by WhatsApp.',
            updatedBy: ctx.userId,
          })
          .where(eq(schema.messageTemplate.id, row.id));
      }
    });

    return {
      synced: provider.length,
      approved: provider.filter((t) => normaliseStatus(t.status) === 'APPROVED').length,
    };
  }

  /** Templates this clinic can use, newest approval state first. */
  async templates(onlyApproved = false) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.messageTemplate),
    );

    return rows
      .filter((row) => (onlyApproved ? row.status === 'APPROVED' : true))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({
        id: row.id,
        name: row.name,
        language: row.language,
        category: row.category,
        status: row.status,
        statusReason: row.statusReason,
        body: row.body,
        headerText: row.headerText,
        footerText: row.footerText,
        buttons: row.buttons,
        variables: row.variables ?? [],
        purpose: row.purpose,
        lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      }));
  }

  /**
   * The decrypted credential, for the send path.
   *
   * Internal only. An account row with no usable token yields a credential with
   * an empty `accessToken`, which is what puts the client into simulated mode —
   * so a half-configured deployment degrades to "recorded but not sent" rather
   * than throwing on every message.
   */
  async credential(): Promise<WhatsAppCredential | null> {
    const account = await this.tenantDb.runReadOnly((tx) => this.activeAccount(tx));
    if (!account) return null;

    return {
      wabaId: account.wabaId,
      phoneNumberId: account.phoneNumberId,
      accessToken: this.secrets.open(account.accessTokenEncrypted) ?? '',
    };
  }

  private async activeAccount(tx: TenantTx) {
    const [row] = await tx
      .select()
      .from(schema.whatsappAccount)
      .where(and(eq(schema.whatsappAccount.isActive, true)))
      .limit(1);
    return row ?? null;
  }

  private tokenHint(sealed: string | null): string | null {
    const token = this.secrets.open(sealed);
    return token ? this.secrets.hint(token) : null;
  }
}

/** The provider's status vocabulary, narrowed to ours. */
function normaliseStatus(
  status: string,
): 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' {
  switch (status.toUpperCase()) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    case 'PAUSED':
    case 'FLAGGED':
      return 'PAUSED';
    case 'DISABLED':
      return 'DISABLED';
    // PENDING, IN_APPEAL, PENDING_DELETION and anything they add later. Treated
    // as not-yet-usable, which is the safe reading of an unknown status.
    default:
      return 'PENDING';
  }
}
