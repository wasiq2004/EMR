/**
 * Creates the first platform operator from the environment, at deploy time.
 *
 * WHY THIS EXISTS ALONGSIDE `provision-operator.ts`. That one is the interactive
 * CLI: you pass a name and an email, it generates a password and prints it once.
 * It is the right tool when somebody is sitting at a terminal. It is the wrong
 * tool for a platform-as-a-service deploy — Dokploy, Coolify, a Compose host
 * behind CI — where there is no terminal to print to and no convenient way to
 * run a one-off command. Without this, a fresh deployment comes up with an
 * operations console nobody can sign into.
 *
 * So this reads `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_NAME` and
 * `PLATFORM_ADMIN_PASSWORD`, and runs as the last step of the migrate job.
 *
 * IT IS CREATE-ONLY. If an operator with that email already exists, the password
 * is left exactly as it is and the script exits successfully. That is the whole
 * safety property of running on every deploy:
 *
 *   - A deploy must never silently reset the credentials of an account that can
 *     suspend every clinic on the platform. If it did, changing the password in
 *     the console would be quietly undone by the next `git push`, and the
 *     password in the environment file would be the real one forever.
 *   - A redeploy is not a password rotation. Rotating is a deliberate act: use
 *     the console, or `provision-operator.js` for a second account.
 *
 * IT REFUSES A PLACEHOLDER OR A WEAK PASSWORD, and it refuses LOUDLY — a
 * non-zero exit that fails the deploy. The alternative is the thing this whole
 * codebase avoids on purpose: an account that ships with the software is an
 * account everyone who has read the repository knows about. A deployment that
 * stops with a clear message is recoverable in thirty seconds; a live platform
 * super-admin on a password copied out of `.env.example` is not.
 *
 * It is a NO-OP when the variables are unset, and says so. An existing
 * deployment that provisions its operator by hand must keep working.
 */

import argon2 from 'argon2';
import pg from 'pg';

const ROLES = ['SUPPORT', 'OPERATOR', 'PLATFORM_ADMIN'] as const;
type Role = (typeof ROLES)[number];

/**
 * Stems that must never appear in a working credential.
 *
 * MATCHED AS SUBSTRINGS, after stripping punctuation and case. An exact-match
 * list is what this started as and it was useless: every entry on it was under
 * twelve characters, so the length check below rejected them first and the list
 * never fired. Meanwhile the realistic placeholder is not `changeme` — it is
 * `ChangeMe123456` or `SuperAdmin@123`, long enough to pass a length check and
 * exactly as guessable.
 *
 * The false-positive risk is the other direction: refusing a legitimate random
 * secret that happens to contain one of these. For a 16-character base64url
 * string the chance of containing "password" is about one in 10^12, so it is
 * not a trade worth worrying about — and the error says exactly which stem
 * matched, so the one person who ever hits it can regenerate and move on.
 */
const PLACEHOLDER_STEMS = [
  'changeme',
  'replaceme',
  'password',
  'passwd',
  'letmein',
  'secret',
  'admin123',
  'superadmin',
  'qwerty',
  'iloveyou',
  'welcome',
  'default',
  'example',
  'yourpassword',
  'notsecure',
  'insecure',
  'temporary',
  'placeholder',
];

/**
 * Long enough that it cannot be guessed, and not so long that a human cannot
 * transcribe one. `randomBytes(12).toString('base64url')` — what the other
 * scripts generate — is sixteen characters, so this is comfortably below what
 * the documented command produces.
 */
const MIN_LENGTH = 12;

async function main() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const name = process.env.PLATFORM_ADMIN_NAME?.trim() || 'Platform Administrator';
  const role = (process.env.PLATFORM_ADMIN_ROLE?.trim().toUpperCase() ||
    'PLATFORM_ADMIN') as Role;

  /*
   * Unset is a supported configuration, not an error.
   *
   * Said out loud rather than passed over in silence, because "the console has
   * no account" is indistinguishable from "the console is broken" to whoever
   * tries to sign in, and this log line is the only place it gets explained.
   */
  if (!email && !password) {
    console.log('');
    console.log('  Operations console: no operator created.');
    console.log('    PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are not set, so');
    console.log('    nothing can sign in at /platform. That is a valid setup — create one');
    console.log('    by hand when you need it:');
    console.log('');
    console.log('      docker compose run --rm migrate node dist/database/provision-operator.js \\');
    console.log('        --email ops@example.in --name "Your Name" --role PLATFORM_ADMIN');
    console.log('');
    return;
  }

  // One set and not the other is a half-finished configuration. Guessing which
  // half was meant is worse than stopping.
  if (!email || !password) {
    throw new Error(
      'Set both PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD, or neither. ' +
        `Currently ${email ? 'the password' : 'the email'} is missing.`,
    );
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`PLATFORM_ADMIN_EMAIL does not look like an email address: ${email}`);
  }
  if (!ROLES.includes(role)) {
    throw new Error(`PLATFORM_ADMIN_ROLE must be one of ${ROLES.join(', ')}.`);
  }

  /* ---- The password has to be real ------------------------------------- */

  /*
   * The placeholder check runs FIRST, before the length check.
   *
   * Order matters for the error message rather than the outcome. `ChangeMe1`
   * fails both, and being told "that is a placeholder" tells you what to do;
   * being told "that is 9 characters" invites you to pad it to `ChangeMe123456`,
   * which passes a length check and is no better.
   */
  const normalised = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  const stem = PLACEHOLDER_STEMS.find((candidate) => normalised.includes(candidate));
  if (stem) {
    throw new Error(
      `PLATFORM_ADMIN_PASSWORD contains "${stem}", so it is a placeholder rather ` +
        'than a secret. This account can suspend every clinic on the platform, and ' +
        'a password anybody could guess from reading the example file is not ' +
        'accepted — padding it to length does not help.\n' +
        '      Generate one with:\n' +
        `      node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"`,
    );
  }

  if (password.length < MIN_LENGTH) {
    throw new Error(
      `PLATFORM_ADMIN_PASSWORD is ${password.length} characters; at least ${MIN_LENGTH} are required. ` +
        'Generate one with:\n' +
        `      node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"`,
    );
  }

  /*
   * A single repeated character, or only two distinct ones, defeats the length
   * check without being any harder to guess. Not a strength meter — just a
   * floor under the obvious ways to satisfy a minimum length.
   */
  if (new Set(password).size < 6) {
    throw new Error(
      `PLATFORM_ADMIN_PASSWORD uses only ${new Set(password).size} distinct characters. ` +
        'Generate one properly rather than padding it to length.',
    );
  }

  const url =
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://emr_migrator:emr_migrator@localhost:5432/emr';

  const pool = new pg.Pool({ connectionString: url });

  try {
    const existing = await pool.query<{ id: string; role: string; is_active: boolean }>(
      'SELECT id, role, is_active FROM platform_user WHERE email = $1',
      [email],
    );

    if (existing.rows.length > 0) {
      const found = existing.rows[0]!;
      /*
       * Nothing is written. See the header: a deploy that reset this password
       * would silently undo a rotation done in the console, and would make the
       * value in the environment file permanently authoritative.
       */
      console.log('');
      console.log(`  Operations console: ${email} already exists — left untouched.`);
      console.log(`    Role ${found.role}${found.is_active ? '' : ', DEACTIVATED'}.`);
      console.log('    The password in the environment is NOT applied to an existing');
      console.log('    account. To rotate it, use the console, or deactivate this one and');
      console.log('    create another with provision-operator.js.');
      console.log('');
      return;
    }

    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    /*
     * `password_changed_at` stays NULL — the record that this password has never
     * been changed from the one it was created with. The same convention as
     * every other issued credential in this system, and what a
     * force-change-on-first-sign-in gate would read.
     *
     * ON CONFLICT DO NOTHING rather than a plain insert: two API tasks starting
     * at once both find no row and both insert, and the unique index on email
     * would fail one of them — which would fail a deploy for the most benign
     * reason imaginable.
     */
    const inserted = await pool.query(
      `INSERT INTO platform_user (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [name, email, hash, role],
    );

    console.log('');
    if (inserted.rows.length === 0) {
      console.log(`  Operations console: ${email} was created by a concurrent task.`);
    } else {
      console.log(`  Operations console: created ${name} <${email}> as ${role}.`);
      console.log('    Sign in at /platform with the password from PLATFORM_ADMIN_PASSWORD.');
      console.log('    Change it after the first sign-in, and the value in the environment');
      console.log('    file stops being a live credential.');
    }
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\n  Operator bootstrap failed: ${error.message}\n`);
  process.exit(1);
});
