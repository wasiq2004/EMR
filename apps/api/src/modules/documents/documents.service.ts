import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { ClinicalDocument } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { StorageService } from '../../common/storage/storage.service';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly storage: StorageService,
  ) {}

  async list(filter: { patientId?: string; q?: string }): Promise<ClinicalDocument[]> {
    const rows = await this.tenantDb.runReadOnly((tx) => {
      const conditions = [];
      if (filter.patientId) {
        conditions.push(eq(schema.documentReference.patientId, filter.patientId));
      }
      if (filter.q) {
        conditions.push(
          or(
            sql`${schema.documentReference.title} ILIKE ${'%' + filter.q + '%'}`,
            sql`${schema.patient.fullName} ILIKE ${'%' + filter.q + '%'}`,
          )!,
        );
      }

      return tx
        .select({ doc: schema.documentReference, patientName: schema.patient.fullName, signer: schema.appUser.fullName })
        .from(schema.documentReference)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.documentReference.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.documentReference.signedBy))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(schema.documentReference.createdAt))
        .limit(200);
    });

    return rows.map(({ doc, patientName, signer }) => serialise(doc, patientName, signer));
  }

  async byId(id: string): Promise<ClinicalDocument> {
    const row = await this.tenantDb.runReadOnly(async (tx) => {
      const [found] = await tx
        .select({ doc: schema.documentReference, patientName: schema.patient.fullName, signer: schema.appUser.fullName })
        .from(schema.documentReference)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.documentReference.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.documentReference.signedBy))
        .where(eq(schema.documentReference.id, id))
        .limit(1);
      return found;
    });

    if (!row) throw new NotFoundException('That document could not be found.');
    return serialise(row.doc, row.patientName, row.signer);
  }

  /**
   * Stores an upload.
   *
   * A patient-supplied file starts PENDING and is not viewable or shareable
   * until a scan confirms it is clean. The status is never null for an upload:
   * a nullable scan status fails open, which is the one thing this control must
   * not do.
   */
  async upload(input: {
    patientId: string;
    encounterId?: string | null;
    documentType: string;
    title: string;
    mimeType: string;
    body: Buffer;
  }): Promise<ClinicalDocument> {
    const ctx = TenantContext.require();
    const extension = input.mimeType.split('/')[1] ?? 'bin';
    const objectKey = this.storage.buildKey({ category: 'documents', extension });
    const { sha256 } = await this.storage.put(objectKey, input.body, input.mimeType);

    return this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.documentReference)
        .values({
          clinicId: ctx.clinicId,
          patientId: input.patientId,
          encounterId: input.encounterId ?? null,
          documentType: input.documentType as 'LAB_REPORT',
          title: input.title,
          objectKey,
          mimeType: input.mimeType,
          sizeBytes: input.body.byteLength,
          contentSha256: sha256,
          virusScanStatus: input.documentType === 'PATIENT_UPLOAD' ? 'PENDING' : null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      const [patient] = await tx
        .select({ name: schema.patient.fullName })
        .from(schema.patient)
        .where(eq(schema.patient.id, input.patientId))
        .limit(1);

      return serialise(created!, patient?.name ?? 'Unknown', null);
    });
  }

  async download(id: string): Promise<{ body: Buffer; mimeType: string; title: string }> {
    const doc = await this.tenantDb.runReadOnly(async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.documentReference)
        .where(eq(schema.documentReference.id, id))
        .limit(1);
      return found;
    });

    if (!doc) throw new NotFoundException('That document could not be found.');
    if (doc.documentType === 'PATIENT_UPLOAD' && doc.virusScanStatus !== 'CLEAN') {
      throw new NotFoundException('That file has not completed security scanning.');
    }

    return {
      body: await this.storage.get(doc.objectKey),
      mimeType: doc.mimeType,
      title: doc.title,
    };
  }
}

function serialise(
  doc: typeof schema.documentReference.$inferSelect,
  patientName: string,
  signer: string | null,
): ClinicalDocument {
  return {
    id: doc.id,
    patientId: doc.patientId,
    patientName,
    encounterId: doc.encounterId,
    documentType: doc.documentType,
    title: doc.title,
    description: doc.description,
    mimeType: doc.mimeType,
    sizeBytes: Number(doc.sizeBytes),
    virusScanStatus: doc.virusScanStatus as never,
    signedByName: signer,
    signedAt: doc.signedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
  };
}
