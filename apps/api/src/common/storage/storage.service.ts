import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config';
import { TenantContext } from '../tenancy/tenant-context';

/** Patient uploads are limited to formats that can be scanned and rendered. */
const ALLOWED_UPLOAD_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
]);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Object storage.
 *
 * The tenant prefix is structural, not cosmetic: every key begins
 * `clinics/{clinic_id}/`, the check below re-verifies it against the caller's
 * own clinic before any read or write, and reaching that exception means the
 * key prefix and row-level security disagree — which should be unreachable.
 *
 * The local driver writes to disk so the stack runs in a container with no
 * cloud account. The S3 driver replaces this one file.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

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

  async put(objectKey: string, body: Buffer, mimeType: string): Promise<{ sha256: string }> {
    this.assertKeyBelongsToCurrentTenant(objectKey);

    if (!ALLOWED_UPLOAD_MIME.has(mimeType)) {
      throw new ForbiddenException(`Files of type ${mimeType} are not accepted.`);
    }
    if (body.byteLength > MAX_UPLOAD_BYTES) {
      throw new ForbiddenException(
        `That file is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`,
      );
    }

    const target = path.join(config.STORAGE_LOCAL_PATH, objectKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);

    // Recorded at write time. Any later dispute about what a document said is
    // resolvable against this.
    return { sha256: createHash('sha256').update(body).digest('hex') };
  }

  async get(objectKey: string): Promise<Buffer> {
    this.assertKeyBelongsToCurrentTenant(objectKey);
    return readFile(path.join(config.STORAGE_LOCAL_PATH, objectKey));
  }

  /** Used by the share-link resolver, which has already proved the tenant. */
  async getUnchecked(objectKey: string): Promise<Buffer> {
    return readFile(path.join(config.STORAGE_LOCAL_PATH, objectKey));
  }

  private assertKeyBelongsToCurrentTenant(objectKey: string): void {
    const ctx = TenantContext.require();
    const expected = `clinics/${ctx.clinicId}/`;
    if (!objectKey.startsWith(expected)) {
      this.logger.error(
        `OBJECT KEY TENANT MISMATCH: key=${objectKey} expected=${expected} ` +
          `user=${ctx.userId} request=${ctx.requestId}`,
      );
      throw new ForbiddenException('That document belongs to another clinic.');
    }
  }
}
