/**
 * Schema barrel.
 *
 * Drizzle discovers tables, enums, roles and policies through this export, so
 * every new table MUST be re-exported here or it will be silently omitted from
 * generated migrations — including its tenant isolation policy.
 *
 * CI guard: `pnpm db:check-tenancy` asserts that every exported pgTable either
 * carries a tenant policy or appears on the explicit exemption list.
 */

export * from './shared';
export * from './tenancy';
export * from './patient';
export * from './clinical';
export * from './comms';
export * from './messaging';
export * from './ops';
export * from './platform';
