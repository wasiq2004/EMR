import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { TenantDb } from '../tenancy/tenant-db.service';
import { TenantContext, runAsSystem } from '../tenancy/tenant-context';
import { AuditWriter } from '../audit/audit.writer';
import { OtpService } from '../auth/otp.service';
import { StorageService } from './storage.service';
import { config } from '../../config';

const DEFAULT_TTL_HOURS = 72;
const MAX_TTL_HOURS = 168;
const DEFAULT_MAX_ACCESS = 10;

/** Types a patient may open without a code, because they are expecting them. */
const OTP_EXEMPT_TYPES = new Set(['PRESCRIPTION', 'INVOICE']);

/**
 * Time-limited, authenticated, auditable external document sharing.
 *
 * WHY NOT A PLAIN SIGNED URL. It is the obvious implementation and the wrong
 * one for a clinical document: once issued it cannot be revoked, it produces no
 * record of who opened it, it works for anyone the link is forwarded to, and it
 * discloses the storage structure. For a patient's lab report all four are
 * unacceptable.
 *
 * Instead: an opaque 256-bit token whose SHA-256 alone is stored, a hard expiry,
 * an access cap, an optional code to the patient's registered mobile, immediate
 * revocation, and an audit row on every access. The file is streamed through the
 * API; the storage location is never exposed.
 */
@Injectable()
export class ShareLinkService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditWriter,
    private readonly otp: OtpService,
    private readonly storage: StorageService,
  ) {}

  async create(args: {
    documentId: string;
    ttlHours?: number;
    maxAccessCount?: number;
    requireOtp?: boolean;
    purpose?: string | null;
  }) {
    const ctx = TenantContext.require();
    const ttlHours = Math.min(args.ttlHours ?? DEFAULT_TTL_HOURS, MAX_TTL_HOURS);
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    // 256 bits, not derived from any resource identifier.
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);

    const result = await this.tenantDb.run(async (tx) => {
      const [doc] = await tx
        .select()
        .from(schema.documentReference)
        .where(eq(schema.documentReference.id, args.documentId))
        .limit(1);
      if (!doc) throw new NotFoundException('That document could not be found.');

      // Fails CLOSED. A patient upload that has not been confirmed clean is not
      // re-served to anyone — including when the scan status is missing.
      if (doc.documentType === 'PATIENT_UPLOAD' && doc.virusScanStatus !== 'CLEAN') {
        throw new ForbiddenException(
          'This file has not completed security scanning, so it cannot be shared yet.',
        );
      }
      if (doc.virusScanStatus && doc.virusScanStatus !== 'CLEAN') {
        throw new ForbiddenException(
          'This file did not pass security scanning and cannot be shared.',
        );
      }

      const [patient] = await tx
        .select({ mobile: schema.patient.mobileE164 })
        .from(schema.patient)
        .where(eq(schema.patient.id, doc.patientId))
        .limit(1);

      /*
       * The code defaults to ON for everything except a document the patient is
       * already expecting. Defaulting to open and relying on staff to tick a box
       * is how clinical documents end up in forwarded chat threads.
       */
      const requireOtp = args.requireOtp ?? !OTP_EXEMPT_TYPES.has(doc.documentType);

      if (requireOtp && !patient?.mobile) {
        throw new BadRequestException(
          'This document needs a verification code, but the patient has no mobile number on file.',
        );
      }

      const [link] = await tx
        .insert(schema.shareLink)
        .values({
          clinicId: ctx.clinicId,
          documentId: doc.id,
          patientId: doc.patientId,
          tokenHash,
          otpChallengeE164: requireOtp ? patient!.mobile : null,
          expiresAt,
          maxAccessCount: args.maxAccessCount ?? DEFAULT_MAX_ACCESS,
          createdByUserId: ctx.userId,
          purpose: args.purpose ?? null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return { link: link!, requireOtp, patientId: doc.patientId };
    });

    await this.audit.append({
      clinicId: ctx.clinicId,
      actorUserId: ctx.userId,
      actorName: ctx.userName,
      actorRole: ctx.role,
      actorType: 'USER',
      action: 'DOCUMENT_SHARE_LINK_CREATED',
      outcome: 'SUCCESS',
      resourceType: 'document',
      resourceId: args.documentId,
      patientId: result.patientId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return {
      /*
       * The id, so the caller can revoke it.
       *
       * It was not returned before, which is why the share dialog could promise
       * "it can be revoked at any time" and offer no way to do it:
       * `POST /share-links/:id/revoke` existed and the screen had no id to call
       * it with. Returning it is not a leak — the recipient never sees this
       * response, and the token, which is the sensitive part, is already in the
       * URL below.
       */
      id: result.link.id,
      url: `${config.PUBLIC_BASE_URL}/share/${token}`,
      expiresAt: expiresAt.toISOString(),
      requiresOtp: result.requireOtp,
    };
  }

  /**
   * Resolves a token for an UNAUTHENTICATED recipient.
   *
   * One of a handful of public routes, so it carries its own defences: every
   * failure returns an identical message, because distinguishing "expired" from
   * "unknown" would confirm that a link once existed and turn this into a way to
   * probe for valid ones.
   */
  async resolve(
    token: string,
    otpCode: string | undefined,
    clientIp: string,
    userAgent: string | null,
  ): Promise<{ title: string; mimeType: string; body: Buffer }> {
    const tokenHash = sha256(token);

    /*
     * Unscoped by necessity: an anonymous recipient has no tenant context, and
     * the token is what establishes which tenant this belongs to. The lookup is
     * by hash alone and returns one row, so it is not a general escape hatch.
     */
    const [resolved] = await this.tenantDb.resolveAcrossTenants<{
      link_id: string;
      clinic_id: string;
    }>(
      'a share-link token presented by an anonymous recipient',
      sql`SELECT * FROM share_link_resolve(${tokenHash})`,
    );

    const link = resolved
      ? await this.tenantDb.runAs(resolved.clinic_id, null, async (tx) => {
          const [row] = await tx
            .select()
            .from(schema.shareLink)
            .where(eq(schema.shareLink.id, resolved.link_id))
            .limit(1);
          return row ?? null;
        })
      : null;

    const generic = new NotFoundException('This link is not valid.');

    if (!link) throw generic;
    if (link.revokedAt) throw generic;
    if (link.expiresAt.getTime() < Date.now()) throw generic;
    if (link.accessCount >= link.maxAccessCount) throw generic;

    return runAsSystem(
      { clinicId: link.clinicId, systemActor: 'SHARE_LINK', requestId: randomUUID() },
      async () => {
        if (link.otpChallengeE164 && !link.otpVerifiedAt) {
          if (!otpCode) {
            await this.otp.send(link.otpChallengeE164, link.id);
            throw new ForbiddenException({
              code: 'OTP_REQUIRED',
              message: `A verification code has been sent to the number ending ${link.otpChallengeE164.slice(-4)}.`,
            });
          }

          const valid = await this.otp.verify(link.otpChallengeE164, link.id, otpCode);
          if (!valid) {
            await this.auditAccess(link, 'SHARE_LINK_OTP_FAILED', 'SERIOUS_FAILURE', clientIp, userAgent);
            throw new ForbiddenException('That code is not correct.');
          }
        }

        const doc = await this.tenantDb.run(async (tx) => {
          /*
           * The cap is enforced in the WHERE clause, not by the earlier read.
           * Checking a value fetched outside the transaction would let
           * concurrent requests all pass and exceed the limit together.
           */
          const [claimed] = await tx
            .update(schema.shareLink)
            .set({
              accessCount: sql`${schema.shareLink.accessCount} + 1`,
              otpVerifiedAt: link.otpChallengeE164 ? new Date() : null,
            })
            .where(
              and(
                eq(schema.shareLink.id, link.id),
                sql`${schema.shareLink.accessCount} < ${schema.shareLink.maxAccessCount}`,
              ),
            )
            .returning();

          if (!claimed) return null;

          const [d] = await tx
            .select()
            .from(schema.documentReference)
            .where(
              and(
                eq(schema.documentReference.id, link.documentId),
                eq(schema.documentReference.status, 'CURRENT'),
              ),
            )
            .limit(1);
          return d ?? null;
        });

        if (!doc) throw generic;

        await this.auditAccess(link, 'DOCUMENT_ACCESSED_VIA_SHARE_LINK', 'SUCCESS', clientIp, userAgent);

        return {
          title: doc.title,
          mimeType: doc.mimeType,
          body: await this.storage.getUnchecked(doc.objectKey),
        };
      },
    );
  }

  /** Immediate revocation, for a link sent to the wrong number. */
  async revoke(shareLinkId: string): Promise<void> {
    const ctx = TenantContext.require();
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.shareLink)
        .set({ revokedAt: new Date(), revokedBy: ctx.userId })
        .where(eq(schema.shareLink.id, shareLinkId)),
    );
  }

  private async auditAccess(
    link: typeof schema.shareLink.$inferSelect,
    action: string,
    outcome: 'SUCCESS' | 'SERIOUS_FAILURE',
    ip: string,
    userAgent: string | null,
  ): Promise<void> {
    await this.audit.append({
      clinicId: link.clinicId,
      actorUserId: null,
      actorName: 'External recipient',
      actorRole: 'EXTERNAL',
      actorType: 'EXTERNAL',
      action,
      outcome,
      resourceType: 'document',
      resourceId: link.documentId,
      patientId: link.patientId,
      ipAddress: ip,
      userAgent,
      requestId: link.id,
      httpMethod: 'GET',
      httpPath: '/share/:token',
      httpStatus: outcome === 'SUCCESS' ? 200 : 403,
    });
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison, for callers comparing tokens directly. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
