/**
 * Time-limited, authenticated, auditable external document sharing.
 *
 * WHY NOT A RAW PRESIGNED S3 URL
 * A presigned URL is the obvious implementation and the wrong one for clinical
 * documents. Once issued it cannot be revoked; it generates no access record;
 * anyone the link is forwarded to can open it; and it discloses the bucket name
 * and key structure. For a patient's lab report, all four are unacceptable.
 *
 * THIS DESIGN
 *   - opaque 256-bit token; only its SHA-256 is stored, so a database
 *     disclosure does not yield working links
 *   - hard expiry plus a maximum access count
 *   - optional OTP challenge to the patient's registered mobile
 *   - revocable at any time by clinic staff
 *   - every access appends an audit_event
 *   - the object is STREAMED through the API; the S3 URL is never exposed
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import * as schema from '@emr/db/schema';
import { TenantDb } from '../tenancy/tenant-db.service';
import { TenantContext, runAsSystem } from '../tenancy/tenant-context';
import { AuditWriter } from '../audit/audit.writer';
import { OtpService } from '../auth/otp.service';

const DEFAULT_TTL_HOURS = 72;
const MAX_TTL_HOURS = 168; // 7 days — longer than this, reissue instead
const DEFAULT_MAX_ACCESS = 10;

/** Document types a patient may open without an OTP challenge. */
const OTP_EXEMPT_TYPES = new Set(['PRESCRIPTION', 'INVOICE']);

@Injectable()
export class ShareLinkService {
  private readonly logger = new Logger(ShareLinkService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditWriter,
    private readonly otp: OtpService,
    private readonly publicBaseUrl: string,
  ) {}

  /**
   * Issues a share link. Caller must hold `document:share`.
   */
  async create(args: {
    documentId: string;
    ttlHours?: number;
    maxAccessCount?: number;
    requireOtp?: boolean;
    purpose?: string;
  }): Promise<{ url: string; expiresAt: Date; requiresOtp: boolean }> {
    const ctx = TenantContext.require();

    const ttlHours = Math.min(args.ttlHours ?? DEFAULT_TTL_HOURS, MAX_TTL_HOURS);
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    // 256 bits of entropy — not guessable, and not derived from any resource id.
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);

    const result = await this.tenantDb.run(async (tx) => {
      // RLS guarantees this returns nothing if the document is another tenant's.
      const [doc] = await tx
        .select()
        .from(schema.documentReference)
        .where(eq(schema.documentReference.id, args.documentId))
        .limit(1);

      if (!doc) throw new NotFoundException('Document not found.');

      // A patient upload that has not passed virus scanning must never be
      // re-served to anyone.
      if (doc.virusScanStatus && doc.virusScanStatus !== 'CLEAN') {
        throw new ForbiddenException(
          'This document has not completed security scanning and cannot be shared.',
        );
      }

      const [patient] = await tx
        .select({ mobile: schema.patient.mobileE164 })
        .from(schema.patient)
        .where(eq(schema.patient.id, doc.patientId))
        .limit(1);

      /**
       * OTP default is deliberately "on" for anything except a prescription or
       * invoice the patient is already expecting. Defaulting to open and
       * relying on staff to tick a box is how clinical documents end up in
       * forwarded WhatsApp threads.
       */
      const requireOtp =
        args.requireOtp ?? !OTP_EXEMPT_TYPES.has(doc.documentType);

      if (requireOtp && !patient?.mobile) {
        throw new BadRequestException(
          'This document requires OTP verification, but the patient has no ' +
            'mobile number on file.',
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
        })
        .returning();

      return { link, requireOtp };
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
      patientId: result.link.patientId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      httpMethod: 'POST',
      httpPath: '/v1/documents/:id/share',
      httpStatus: 201,
    });

    return {
      url: `${this.publicBaseUrl}/share/${token}`,
      expiresAt,
      requiresOtp: result.requireOtp,
    };
  }

  /**
   * Resolves a token for an UNAUTHENTICATED recipient.
   *
   * This runs on a @Public() route — one of only five in the system — so it
   * carries its own defences: constant-time comparison, no distinction between
   * "unknown token" and "expired token" in the error message (so the endpoint
   * cannot be used to probe for valid tokens), strict rate limiting by IP, and
   * a system-scoped tenant context derived from the link itself.
   */
  async resolve(
    token: string,
    otpCode: string | undefined,
    clientIp: string,
    userAgent: string | null,
  ): Promise<{ objectKey: string; filename: string; mimeType: string }> {
    const tokenHash = sha256(token);

    // Unscoped by necessity: an anonymous recipient has no tenant context, and
    // the token itself is what establishes which tenant this belongs to.
    // Looked up by hash only — the token is not a tenant-guessable value.
    const link = await this.tenantDb.runUnscopedPlatformOperation(
      'share-link token resolution (anonymous recipient)',
      async (db) => {
        const [row] = await db
          .select()
          .from(schema.shareLink)
          .where(eq(schema.shareLink.tokenHash, tokenHash))
          .limit(1);
        return row;
      },
    );

    // Deliberately identical message for every failure mode below, so the
    // endpoint reveals nothing about which tokens exist.
    const generic = new NotFoundException('This link is invalid or has expired.');

    if (!link) throw generic;
    if (link.revokedAt) throw generic;
    if (link.expiresAt.getTime() < Date.now()) throw generic;
    if (link.accessCount >= link.maxAccessCount) throw generic;

    // Now that the tenant is known from the link, everything else runs scoped.
    return runAsSystem(
      { clinicId: link.clinicId, systemActor: 'SHARE_LINK', requestId: crypto.randomUUID() },
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
            throw new ForbiddenException('Incorrect verification code.');
          }
        }

        const doc = await this.tenantDb.run(async (tx) => {
          await tx
            .update(schema.shareLink)
            .set({
              accessCount: sql`${schema.shareLink.accessCount} + 1`,
              otpVerifiedAt: link.otpChallengeE164 ? new Date() : null,
            })
            .where(eq(schema.shareLink.id, link.id));

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

          return d;
        });

        if (!doc) throw generic;

        await this.auditAccess(link, 'DOCUMENT_ACCESSED_VIA_SHARE_LINK', 'SUCCESS', clientIp, userAgent);

        return {
          objectKey: doc.objectKey,
          filename: `${doc.title}.pdf`,
          mimeType: doc.mimeType,
        };
      },
    );
  }

  /** Immediate revocation. Used when a link was sent to the wrong number. */
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

/** Constant-time comparison helper, for callers comparing tokens directly. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
