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
 * Larger than a document, because it is text rather than a scan.
 *
 * 50,000 patient rows of name, number, date of birth and address is comfortably
 * under 20 MB as CSV. The limit is here to stop a mistake, not to be reached.
 */
const MAX_IMPORT_BYTES = 40 * 1024 * 1024;

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

  /**
   * Stores a CSV this system produced or is about to parse.
   *
   * SEPARATE FROM `put`, which exists for files a person attaches to a patient's
   * record. That one enforces an allowlist of formats that can be virus-scanned
   * and rendered in a browser, and a CSV is deliberately not on it: a
   * spreadsheet handed to a clinician is a file that opens in Excel and runs
   * whatever a formula cell says. Widening the allowlist to let an import
   * through would also let somebody attach one to a patient's documents, where
   * it would be offered to a share-link recipient for download.
   *
   * So the two paths carry different risk and get different rules. This one
   * takes an import the clinic uploaded and the problem report written back to
   * them — never anything served from a share link, never anything a patient
   * supplied.
   */
  async putImport(objectKey: string, body: Buffer): Promise<{ sha256: string }> {
    this.assertKeyBelongsToCurrentTenant(objectKey);

    if (!objectKey.includes('/imports/')) {
      // A caller reaching for this to store something that is not an import is
      // reaching past the allowlist, which is the control it would be evading.
      throw new ForbiddenException('That is not an import key.');
    }
    if (body.byteLength > MAX_IMPORT_BYTES) {
      throw new ForbiddenException(
        `That file is larger than the ${MAX_IMPORT_BYTES / 1024 / 1024} MB limit.`,
      );
    }

    const target = path.join(config.STORAGE_LOCAL_PATH, objectKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);

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
