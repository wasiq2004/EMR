/**
 * Request-scoped tenant context, carried in AsyncLocalStorage.
 *
 * WHY AsyncLocalStorage rather than passing a context object down the call
 * stack: it makes it impossible to *forget* to pass the tenant. Any code that
 * reaches the database goes through TenantDb, which reads the context here and
 * throws if it is absent. There is no signature a developer can satisfy while
 * omitting the tenant.
 *
 * SECURITY INVARIANT: `require()` throws rather than returning a default. A
 * missing tenant context must fail the request, never fall back to "no filter".
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { InternalServerErrorException } from '@nestjs/common';

export type UserRole =
  | 'OWNER_ADMIN'
  | 'DOCTOR'
  | 'RECEPTIONIST'
  | 'NURSE_ASSISTANT'
  | 'AUDITOR';

export interface TenantContextData {
  /** The tenant boundary. Sourced from the verified JWT, never from user input. */
  readonly clinicId: string;
  readonly userId: string;
  readonly userName: string;
  readonly role: UserRole;

  /** JWT id — used to check the token has not been revoked. */
  readonly jti: string;

  /** Correlates log lines, OpenTelemetry spans and audit_event rows. */
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;

  /**
   * Set for background jobs instead of a real user. Audit rows written under a
   * system context record the job name as the actor, so automated actions are
   * distinguishable from human ones in the trail.
   */
  readonly systemActor?: string;
}

const storage = new AsyncLocalStorage<TenantContextData>();

export const TenantContext = {
  /** Runs `fn` with `data` bound for the entire async call tree. */
  run<T>(data: TenantContextData, fn: () => T): T {
    return storage.run(data, fn);
  },

  /** Returns the context, or undefined outside a request/job. */
  get(): TenantContextData | undefined {
    return storage.getStore();
  },

  /**
   * Returns the context or throws.
   *
   * Prefer this everywhere. Failing loudly on a missing tenant is correct: the
   * alternative — proceeding without a tenant filter — is the exact condition
   * that turns a bug into a cross-tenant breach.
   */
  require(): TenantContextData {
    const ctx = storage.getStore();
    if (!ctx) {
      throw new InternalServerErrorException(
        'Tenant context is not established. Database access is not permitted ' +
          'outside a request or an explicitly scoped background job.',
      );
    }
    return ctx;
  },
};

/**
 * Establishes a tenant context for background work (BullMQ consumers, cron).
 *
 * Workers have no JWT, so the tenant comes from the job payload. The caller is
 * responsible for having validated that payload against the record it loads —
 * see TenantDb.assertRowTenant().
 */
export function runAsSystem<T>(
  args: {
    clinicId: string;
    systemActor: string;
    requestId: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  return TenantContext.run(
    {
      clinicId: args.clinicId,
      userId: '00000000-0000-0000-0000-000000000000',
      userName: args.systemActor,
      role: 'OWNER_ADMIN',
      jti: 'system',
      requestId: args.requestId,
      ipAddress: null,
      userAgent: null,
      systemActor: args.systemActor,
    },
    fn,
  );
}
