/**
 * Configuration, read once at boot and validated.
 *
 * A missing secret fails the process at startup rather than at the first
 * request that needs it. An API that boots and then refuses every login is
 * harder to diagnose than one that refuses to boot.
 */

import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),

  /** The API's own connection. This role is NOBYPASSRLS and holds no DDL. */
  DATABASE_URL: z.string().min(1),
  /** Owner role, used only by the migration runner. */
  MIGRATION_DATABASE_URL: z.string().optional(),

  /**
   * Signing key for the short-lived access token.
   *
   * Required in production. In development it falls back to a fixed value so
   * the stack comes up with no setup, and the value is obviously not a secret.
   */
  JWT_SECRET: z.string().min(16).default('development-only-not-a-secret-key'),

  /**
   * Encrypts secrets held on a clinic's behalf — today, its WhatsApp access
   * token. SEPARATE FROM JWT_SECRET on purpose: rotating the signing secret
   * signs everyone out, which is a routine thing to do, and must not also make
   * every clinic's stored token permanently unreadable.
   */
  ENCRYPTION_KEY: z.string().min(32).default('development-only-encryption-key-not-a-secret'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(10 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().default(30 * 24 * 60 * 60),

  /**
   * Per-role session length. A thirty-day session is wrong for a reception
   * machine that three people share across a shift.
   */
  RECEPTION_REFRESH_TTL_SECONDS: z.coerce.number().int().default(12 * 60 * 60),

  /** Days a new clinician may work before two-factor is enforced. */
  MFA_GRACE_DAYS: z.coerce.number().int().default(7),

  /** Where uploaded and generated files live. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('/var/lib/emr/objects'),

  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Configuration is not valid:\n${problems}`);
}

export const config = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
};

if (config.isProduction && config.JWT_SECRET.startsWith('development-only')) {
  throw new Error('JWT_SECRET must be set to a real secret in production.');
}

if (config.isProduction && config.ENCRYPTION_KEY.startsWith('development-only')) {
  throw new Error(
    'ENCRYPTION_KEY must be set to a real secret in production. ' +
      'It encrypts the WhatsApp access token each clinic holds; changing it ' +
      'later makes every stored token unreadable and every clinic has to ' +
      'reconnect.',
  );
}
