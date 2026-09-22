import { defineConfig } from 'drizzle-kit';

/**
 * Table DDL is generated from the schema; the security substrate is not.
 *
 * Roles, forced RLS, the immutability triggers and the verification assertion
 * live in hand-written SQL under `migrations/`, because they are the controls a
 * reviewer needs to read in one place rather than reconstruct from a diff.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations/generated',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://emr_migrator@localhost:5432/emr',
  },
  verbose: true,
  strict: true,
});
