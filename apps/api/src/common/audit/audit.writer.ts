import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../tenancy/tenant-db.service';

export interface AuditRecord {
  clinicId: string;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  actorType: 'USER' | 'SYSTEM' | 'EXTERNAL';
  action: string;
  outcome: 'SUCCESS' | 'MINOR_FAILURE' | 'SERIOUS_FAILURE' | 'MAJOR_FAILURE';
  outcomeDescription?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceLabel?: string | null;
  patientId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  httpMethod?: string | null;
  httpPath?: string | null;
  httpStatus?: number | null;
  changeSummary?: unknown;
}

/**
 * Writes the immutable audit trail.
 *
 * Two properties are load-bearing:
 *
 *   - An audit write NEVER fails the user's request. A doctor cannot be blocked
 *     from finalising a consultation because this table is briefly unavailable.
 *   - A dropped row is still a compliance gap, so a failure is buffered and
 *     replayed rather than swallowed. The loss window is bounded instead of
 *     open-ended, and the failure is logged at error level so it alerts.
 *
 * The insert deliberately does NOT go through TenantDb. TenantDb reads the
 * clinic from the ambient request context, and this row must be written with the
 * clinic of the ACTION — which still exists when the request that triggered it
 * is being rolled back, or when there is no request at all because a scheduled
 * job is the actor.
 *
 * It still sets `app.clinic_id`, in its own transaction on its own pooled
 * connection, because audit_event is under the same forced RLS as every other
 * table. Writing without it does not fail loudly; the INSERT is simply refused
 * by the policy, which is the one outcome an audit trail must never have.
 */
@Injectable()
export class AuditWriter {
  private readonly logger = new Logger(AuditWriter.name);
  private readonly buffer: AuditRecord[] = [];
  private draining = false;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async append(record: AuditRecord): Promise<void> {
    try {
      await this.insert(record);
    } catch (error) {
      this.logger.error(
        `AUDIT WRITE FAILED action=${record.action} request=${record.requestId}: ${String(error)}`,
      );
      this.buffer.push(record);
      void this.drain();
    }
  }

  private async insert(record: AuditRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.clinic_id', ${record.clinicId}, true)`,
      );
      await tx.execute(
        sql`SELECT set_config('app.user_id', ${record.actorUserId ?? ''}, true)`,
      );

      await tx.execute(sql`
      INSERT INTO audit_event (
        clinic_id, actor_user_id, actor_name, actor_role, actor_type,
        action, outcome, outcome_description,
        resource_type, resource_id, resource_label, patient_id,
        ip_address, user_agent, request_id,
        http_method, http_path, http_status, change_summary
      ) VALUES (
        ${record.clinicId}, ${record.actorUserId}, ${record.actorName},
        ${record.actorRole}, ${record.actorType},
        ${record.action}, ${record.outcome}, ${record.outcomeDescription ?? null},
        ${record.resourceType ?? null}, ${record.resourceId ?? null},
        ${record.resourceLabel ?? null}, ${record.patientId ?? null},
        ${record.ipAddress ?? null}, ${record.userAgent ?? null}, ${record.requestId ?? null},
        ${record.httpMethod ?? null}, ${record.httpPath ?? null}, ${record.httpStatus ?? null},
        ${record.changeSummary ? JSON.stringify(record.changeSummary) : null}::jsonb
      )
    `);
    });
  }

  /** Replays buffered rows, oldest first, and stops at the first that still fails. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.buffer.length > 0) {
        const record = this.buffer[0]!;
        try {
          await this.insert(record);
          this.buffer.shift();
        } catch {
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
