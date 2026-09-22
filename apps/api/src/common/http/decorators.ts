import { SetMetadata } from '@nestjs/common';

export { Authenticated, Public, RequirePermission } from '../rbac/rbac.guard';
export { Audit, SkipAudit } from '../audit/audit.interceptor';

/**
 * Marks a route as requiring an `Idempotency-Key`.
 *
 * Applied to anything that dispatches a message or takes money, so a retried
 * request cannot send a prescription twice or charge a patient twice.
 */
export const REQUIRES_IDEMPOTENCY_KEY = 'http:idempotent';
export const Idempotent = () => SetMetadata(REQUIRES_IDEMPOTENCY_KEY, true);
