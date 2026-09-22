/**
 * Creates a platform operator.
 *
 * The operations console has no self-service sign-up and no default account,
 * so this is the only way one comes to exist. Same reasoning as `provision.ts`:
 * an account that ships with the software is an account everyone knows about.
 *
 *   pnpm --filter @emr/api provision-operator \
 *     --email ops@yourcompany.in \
 *     --name "Wasiq" \
 *     --role PLATFORM_ADMIN
 *
 * Roles: SUPPORT reads the estate, OPERATOR can suspend a clinic and change its
 * plan, PLATFORM_ADMIN can also manage operators. Default is SUPPORT, because
 * the least authority that does the job is the right default for an account
 * that reaches every customer.
 */

import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const ROLES = ['SUPPORT', 'OPERATOR', 'PLATFORM_ADMIN'] as const;
type Role = (typeof ROLES)[number];

function arg(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(`--${key}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

async function main() {
  const argv = process.argv.slice(2);

  const email = arg(argv, 'email')?.trim().toLowerCase();
  const name = arg(argv, 'name')?.trim();
  const role = (arg(argv, 'role')?.trim().toUpperCase() ?? 'SUPPORT') as Role;

  if (!email || !name) {
    throw new Error('Required: --email and --name. Optional: --role.');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`--email does not look like an email address: ${email}`);
  }
  if (!ROLES.includes(role)) {
    throw new Error(`--role must be one of ${ROLES.join(', ')}.`);
  }

  const url =
    process.env.MIGRATION_DATABASE_URL ??
    'postgres://emr_migrator:emr_migrator@localhost:5432/emr';

  const pool = new pg.Pool({ connectionString: url });

  try {
    const existing = await pool.query('SELECT id FROM platform_user WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      throw new Error(
        `An operator with that email already exists. This command will not reset a password — ` +
          `resetting the credentials of an account that can suspend every clinic should be deliberate.`,
      );
    }

    // Generated, not passed as an argument: an argument ends up in the shell
    // history and the process list.
    const password = randomBytes(12).toString('base64url');
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    await pool.query(
      `INSERT INTO platform_user (full_name, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
      [name, email, hash, role],
    );

    console.log('');
    console.log(`  Operator created: ${name} <${email}>`);
    console.log(`  Role:             ${role}`);
    console.log('');
    console.log(`  One-time password:  ${password}`);
    console.log('');
    console.log('  Console: /platform');
    console.log('  Not stored in plaintext and cannot be shown again.');
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
});
