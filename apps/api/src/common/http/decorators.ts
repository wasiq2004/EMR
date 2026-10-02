
export { Authenticated, Public, RequirePermission } from '../rbac/rbac.guard';
export { Audit, SkipAudit } from '../audit/audit.interceptor';

/*
 * REMOVED: `@Idempotent()`.
 *
 * It read "applied to anything that dispatches a message or takes money, so a
 * retried request cannot send a prescription twice or charge a patient twice" —
 * and it was applied to nothing, and no guard ever read its metadata. Nothing
 * on the server read the `Idempotency-Key` header either.
 *
 * That cost real money. The payment screen sent its key as that header,
 * believing it was protected; `RecordPayment` wanted the key in the BODY, so
 * every payment failed validation with a 422 and the front desk could not take
 * money at all. Nobody noticed, because a decorator named `Idempotent` sitting
 * in this file reads exactly like the protection being in place.
 *
 * Idempotency now lives where it can be enforced: a required `idempotencyKey`
 * in the request body, a column on `payment`, and a partial unique index on
 * (clinic_id, idempotency_key) that the database checks — see migration
 * `0010_payment_idempotency.sql`. A decorator cannot win the race between two
 * concurrent taps on a counter terminal; a unique index can.
 *
 * If a route needs this guarantee in future, add the field to its contract and
 * the index to its table. Do not reintroduce a marker that enforces nothing.
 */
