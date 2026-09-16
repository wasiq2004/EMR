/**
 * Presigned S3 URL generation for INTERNAL (authenticated staff) access.
 *
 * For EXTERNAL sharing with patients or referred consultants, use
 * ShareLinkService instead — a presigned URL cannot be revoked, produces no
 * access audit trail, and exposes the bucket structure. See 04 §6.
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

import { TenantContext } from '../tenancy/tenant-context';

/** Short by design: long enough to open a document, short enough that a leaked URL is stale. */
const READ_URL_TTL_SECONDS = 300; // 5 minutes
const UPLOAD_URL_TTL_SECONDS = 900; // 15 minutes — clinic broadband can be slow

/** Patient-supplied uploads are restricted to formats that can be safely scanned and rendered. */
const ALLOWED_UPLOAD_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
]);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Injectable()
export class SignedUrlService {
  private readonly logger = new Logger(SignedUrlService.name);

  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  /**
   * Builds the canonical object key for a new object.
   *
   * The tenant prefix is structural: the bucket policy denies any request whose
   * key does not begin with `clinics/`, and every presign is validated against
   * the caller's own clinic below. A key leaked from one tenant therefore
   * cannot be edited into another tenant's path and replayed.
   */
  buildKey(args: {
    category: 'documents' | 'prescriptions' | 'exports' | 'imports' | 'branding';
    extension: string;
  }): string {
    const ctx = TenantContext.require();
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');

    return `clinics/${ctx.clinicId}/${args.category}/${yyyy}/${mm}/${randomUUID()}.${args.extension}`;
  }

  /**
   * Presigns a download URL.
   *
   * Call ONLY after RBAC has authorised the read and the document row has been
   * loaded through TenantDb (so RLS has already confirmed ownership). This
   * method re-verifies the key prefix as defence in depth — if the two ever
   * disagree, something upstream is broken and the request must fail.
   */
  async presignRead(objectKey: string): Promise<{ url: string; expiresInSeconds: number }> {
    this.assertKeyBelongsToCurrentTenant(objectKey);

    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { expiresIn: READ_URL_TTL_SECONDS },
    );

    return { url, expiresInSeconds: READ_URL_TTL_SECONDS };
  }

  /**
   * Presigns an upload URL with enforced content type and size limit.
   *
   * ContentType and ContentLength are bound into the signature, so the client
   * cannot upload a different type or an oversized object than the one the
   * server authorised.
   */
  async presignUpload(args: {
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<{ url: string; expiresInSeconds: number }> {
    this.assertKeyBelongsToCurrentTenant(args.objectKey);

    if (!ALLOWED_UPLOAD_MIME.has(args.mimeType)) {
      throw new ForbiddenException(`File type ${args.mimeType} is not accepted.`);
    }
    if (args.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new ForbiddenException(
        `File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`,
      );
    }

    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: args.objectKey,
        ContentType: args.mimeType,
        ContentLength: args.sizeBytes,
        // Server-side encryption with the clinic-data KMS key.
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: process.env.S3_KMS_KEY_ID,
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );

    return { url, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
  }

  /**
   * Structural tenant check on the object key.
   *
   * Reaching the exception means RLS and the key prefix disagree, which should
   * be unreachable — so it is logged at error severity and should page.
   */
  private assertKeyBelongsToCurrentTenant(objectKey: string): void {
    const ctx = TenantContext.require();
    const expectedPrefix = `clinics/${ctx.clinicId}/`;

    if (!objectKey.startsWith(expectedPrefix)) {
      this.logger.error(
        `OBJECT KEY TENANT MISMATCH: key=${objectKey} expected prefix=${expectedPrefix} ` +
          `user=${ctx.userId} request=${ctx.requestId}`,
      );
      throw new ForbiddenException('Document does not belong to the current clinic.');
    }
  }
}
