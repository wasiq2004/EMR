/**
 * Global audit interceptor.
 *
 * Registered as an APP_INTERCEPTOR in main.ts, so EVERY request is audited
 * without feature code participating. A reviewer can verify complete coverage
 * from one line of main.ts rather than by grepping every controller — which is
 * the entire reason this is an interceptor and not a service call.
 *
 * Captures, per the SoW: actor, action, target resource, outcome, IP address,
 * user agent and timestamp. Rows are append-only; see migration 0001 §6.
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { FastifyRequest } from 'fastify';

import { TenantContext } from '../tenancy/tenant-context';
import { AuditWriter } from './audit.writer';

export const AUDIT_ACTION_KEY = 'audit:action';
export const AUDIT_RESOURCE_KEY = 'audit:resource';
export const AUDIT_SKIP_KEY = 'audit:skip';

/**
 * Names the audited action, e.g. @Audit('ENCOUNTER_FINALIZED', 'encounter').
 * Without it, the interceptor derives a generic action from the HTTP method
 * and route — usable, but far less searchable in an investigation.
 */
export const Audit = (action: string, resourceType: string) =>
  SetMetadata(AUDIT_ACTION_KEY, { action, resourceType });

/**
 * Suppresses auditing for genuinely high-volume, zero-risk reads — health
 * checks and the queue poller, which would otherwise dominate the audit table.
 *
 * Every use is enumerated in the security review checklist. NEVER apply to any
 * route that reads or writes patient data.
 */
export const SkipAudit = () => SetMetadata(AUDIT_SKIP_KEY, true);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly writer: AuditWriter,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      this.reflector.getAllAndOverride<boolean>(AUDIT_SKIP_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const meta = this.reflector.get<{ action: string; resourceType: string } | undefined>(
      AUDIT_ACTION_KEY,
      context.getHandler(),
    );

    const ctx = TenantContext.get();
    if (!ctx) {
      // Unauthenticated routes (login attempts, webhooks) are audited by their
      // own handlers, which have the tenant information the middleware lacked.
      return next.handle();
    }

    const startedAt = Date.now();
    const action =
      meta?.action ?? `${req.method}_${this.routeKey(req)}`.toUpperCase();
    const resourceType = meta?.resourceType ?? this.routeKey(req);
    const resourceId = this.extractResourceId(req);

    return next.handle().pipe(
      tap({
        next: () => {
          void this.write({
            ctx,
            action,
            resourceType,
            resourceId,
            req,
            outcome: 'SUCCESS',
            httpStatus: 200,
            durationMs: Date.now() - startedAt,
          });
        },
        error: (err: unknown) => {
          const status = this.statusOf(err);
          void this.write({
            ctx,
            action,
            resourceType,
            resourceId,
            req,
            // 403 is escalated: an authorisation denial is a security-relevant
            // event, not a routine validation failure.
            outcome: status === 403 ? 'SERIOUS_FAILURE' : 'MINOR_FAILURE',
            outcomeDescription: err instanceof Error ? err.message : String(err),
            httpStatus: status,
            durationMs: Date.now() - startedAt,
          });
        },
      }),
    );
  }

  private async write(args: {
    ctx: NonNullable<ReturnType<typeof TenantContext.get>>;
    action: string;
    resourceType: string;
    resourceId: string | null;
    req: FastifyRequest;
    outcome: 'SUCCESS' | 'MINOR_FAILURE' | 'SERIOUS_FAILURE' | 'MAJOR_FAILURE';
    outcomeDescription?: string;
    httpStatus: number;
    durationMs: number;
  }): Promise<void> {
    const { ctx } = args;

    try {
      await this.writer.append({
        clinicId: ctx.clinicId,
        actorUserId: ctx.systemActor ? null : ctx.userId,
        actorName: ctx.systemActor ?? ctx.userName,
        actorRole: ctx.role,
        actorType: ctx.systemActor ? 'SYSTEM' : 'USER',
        action: args.action,
        outcome: args.outcome,
        outcomeDescription: args.outcomeDescription ?? null,
        resourceType: args.resourceType,
        resourceId: args.resourceId,
        patientId: this.extractPatientId(args.req),
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
        httpMethod: args.req.method,
        httpPath: args.req.url,
        httpStatus: args.httpStatus,
      });
    } catch (err) {
      /**
       * An audit write must never fail the user's request — a doctor cannot be
       * blocked from finalising a consultation because the audit table is
       * momentarily unavailable.
       *
       * But a silently dropped audit record is a compliance gap, so the failure
       * is logged at ERROR and alerts. The writer additionally buffers to a
       * local durable queue and replays, so the loss window is bounded.
       */
      this.logger.error(
        `AUDIT WRITE FAILED action=${args.action} request=${ctx.requestId}: ${String(err)}`,
      );
    }
  }

  /** First path segment after the version prefix, e.g. /v1/patients/:id → "patients". */
  private routeKey(req: FastifyRequest): string {
    return req.url.split('?')[0].split('/').filter(Boolean)[1] ?? 'unknown';
  }

  private extractResourceId(req: FastifyRequest): string | null {
    const params = req.params as Record<string, string> | undefined;
    return params?.id ?? null;
  }

  /**
   * Populates audit_event.patient_id where determinable, which is what makes
   * "who accessed this patient's record?" — the DPDP subject-access query — a
   * single indexed lookup rather than a full-table scan.
   */
  private extractPatientId(req: FastifyRequest): string | null {
    const params = req.params as Record<string, string> | undefined;
    const query = req.query as Record<string, string> | undefined;
    const body = req.body as Record<string, unknown> | undefined;

    return (
      params?.patientId ??
      query?.patientId ??
      (typeof body?.patientId === 'string' ? body.patientId : null)
    );
  }

  private statusOf(err: unknown): number {
    if (
      typeof err === 'object' &&
      err !== null &&
      'getStatus' in err &&
      typeof (err as { getStatus: unknown }).getStatus === 'function'
    ) {
      return (err as { getStatus: () => number }).getStatus();
    }
    return 500;
  }
}
