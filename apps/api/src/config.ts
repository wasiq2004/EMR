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
  /**
   * Owner role. Used by the migration runner, and by exactly two console
   * actions — onboarding a clinic and rescuing a locked-out administrator.
   *
   * Those two need it because `emr_platform` has no privilege on `app_user`,
   * deliberately: an operator must not be able to enumerate a clinic's staff.
   * Absent means both are CLI-only, which is a legitimate choice rather than
   * an error.
   */
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

  /**
   * The operations console's own connection, as `emr_platform`.
   *
   * A SEPARATE ROLE, not a separate schema. That role has privileges on five
   * platform tables and on `clinic`, and none at all on `patient`, `encounter`,
   * `communication` or `app_user` — so a bug in a console endpoint cannot read
   * clinical data, because the database refuses rather than a policy filtering.
   *
   * Absent means the console is not served. A deployment that does not want one
   * simply does not set this.
   */
  PLATFORM_DATABASE_URL: z.string().optional(),

  /**
   * Fans real-time events out across API replicas.
   *
   * Optional. With one instance the event bus is in-process and correct; this
   * is what makes a second instance's browsers see the first instance's
   * messages. Its absence degrades real-time updates, never correctness.
   */
  REDIS_URL: z.string().optional(),

  /** Where uploaded and generated files live. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('/var/lib/emr/objects'),

  /**
   * Shared secret for `POST /jobs/run-due`.
   *
   * The reminder scheduler is a cron line, which has no user session and
   * therefore cannot hold a clinic scope. A bearer secret is the right shape
   * for that and the wrong shape for anything else — so this authenticates
   * exactly one endpoint, which takes no parameters and returns nothing but
   * counts. It cannot read a patient, and the work it triggers runs per clinic
   * under ordinary RLS.
   *
   * Empty by default, and an empty value DISABLES the endpoint rather than
   * leaving it open. A deployment that has not set this has no reminder
   * scheduler, which is a visible absence; an endpoint that accepts an empty
   * secret is an invisible hole.
   */
  JOBS_SECRET: z.string().default(''),

  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /**
   * Extra hostnames that are the app rather than a clinic subdomain.
   *
   * Comma-separated. Usually unnecessary — PUBLIC_BASE_URL and CORS_ORIGINS
   * already name the host the browser uses, and both are read for this.
   */
  APP_HOSTS: z.string().default(''),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Configuration is not valid:\n${problems}`);
}

/**
 * The hostname out of a URL, or null if it is not one.
 *
 * Tolerant on purpose: these values are typed into an environment file by hand,
 * and a bare `emr.example.com` with no scheme is a reasonable thing to write.
 * Returning null for junk is correct — the caller treats "not a known app host"
 * as "this might be a clinic subdomain", which is the pre-existing behaviour.
 */
function hostOf(value: string): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export const config = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()),

  /**
   * Hostnames that are THIS APPLICATION rather than a clinic's subdomain.
   *
   * Sign-in reads the clinic from the first label of the host, because the
   * product is addressed as `{clinic-slug}.yourdomain.com`. That is right for a
   * multi-tenant estate and WRONG for the commonest deployment of all — one
   * clinic on one domain, `emr.example.com` — where the first label is the
   * app's own name and matches no clinic. The resolver then filters on a slug
   * that does not exist, finds nobody, and sign-in reports "that email and
   * password do not match", which sends whoever is holding a correct password
   * looking for a problem with the password.
   *
   * Derived from PUBLIC_BASE_URL and APP_HOSTS rather than being a new setting
   * nobody knows to set: the deployment has already had to say where the
   * browser reaches it, and that is the same fact. APP_HOSTS exists for the
   * cases that answer does not cover — a second domain, an internal name, a
   * health-check host.
   */
  appHosts: [
    ...parsed.data.APP_HOSTS.split(',').map((host) => host.trim().toLowerCase()),
    hostOf(parsed.data.PUBLIC_BASE_URL),
    ...parsed.data.CORS_ORIGINS.split(',').map((origin) => hostOf(origin.trim())),
  ].filter((host): host is string => Boolean(host)),
};

if (config.isProduction && config.JWT_SECRET.startsWith('development-only')) {
  throw new Error('JWT_SECRET must be set to a real secret in production.');
}

/*
 * PUBLIC_BASE_URL left at its development default, in production.
 *
 * WARNED, NOT THROWN. It is wrong in every production deployment, but refusing
 * to boot over it would take a running clinic down on an upgrade for something
 * that is not a security property — and the default is what somebody who copied
 * `.env.example` and changed only the secrets will have.
 *
 * It breaks two things, neither of which announces itself:
 *
 *   - SIGN-IN, because `appHosts` is derived from this. The real host is then
 *     not recognised as the application's own, its first label is read as a
 *     clinic slug, the resolver matches no clinic, and the user is told "that
 *     email and password do not match" while holding a correct password.
 *   - SHARE LINKS, which are built from it, so every OTP link a clinic sends a
 *     patient points at the recipient's own machine.
 */
if (
  config.isProduction &&
  /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(config.PUBLIC_BASE_URL)
) {
  console.error(
    [
      `  PUBLIC_BASE_URL is still ${config.PUBLIC_BASE_URL} in production.`,
      "    Sign-in will refuse correct passwords: the real hostname is not",
      "    recognised as this application's, so its first label is read as a",
      "    clinic slug, matches no clinic, and the user is told their email and",
      "    password do not match while holding a correct one.",
      "    Share links will also point at the recipient's own machine.",
      "    Set PUBLIC_BASE_URL and CORS_ORIGINS to the address the browser uses,",
      "    for example https://emr.example.com",
    ].join('\n'),
  );
}

/*
 * No warning if JOBS_SECRET is unset, and that is deliberate.
 *
 * A deployment with no reminder scheduler is a legitimate configuration — most
 * clinics on this product have not connected WhatsApp at all. What must never
 * happen is the endpoint accepting a request because the secret is empty, and
 * that is enforced at the guard rather than here, where it would only be a log
 * line somebody has to read.
 */
if (config.isProduction && config.ENCRYPTION_KEY.startsWith('development-only')) {
  throw new Error(
    'ENCRYPTION_KEY must be set to a real secret in production. ' +
      'It encrypts the WhatsApp access token each clinic holds; changing it ' +
      'later makes every stored token unreadable and every clinic has to ' +
      'reconnect.',
  );
}
