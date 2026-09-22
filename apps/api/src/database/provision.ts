/**
 * Creates a clinic and its first administrator.
 *
 * This is the only way into a fresh deployment. There is no demo data and no
 * default account, so nothing can be signed into until this has run — which is
 * the point: a system with a known account already in it is a system with a
 * known way in.
 *
 *   pnpm --filter @emr/api provision \
 *     --name "Sunrise Family Clinic" \
 *     --slug sunrise \
 *     --admin-email owner@sunriseclinic.in \
 *     --admin-name "Vikram Rao"
 *
 * It prints a one-time password rather than emailing one, because no mail
 * provider is connected. Saying so plainly beats pretending a mail was sent —
 * the administrator reads it out, and it must be changed on first sign-in.
 *
 * Safe to run more than once for DIFFERENT clinics; it refuses to overwrite one
 * that already exists, because "provision" quietly resetting a live clinic's
 * administrator would be the worst possible behaviour for a command someone
 * runs twice by accident.
 */

import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@emr/db/schema';

interface Options {
  name: string;
  slug: string;
  adminEmail: string;
  adminName: string;
  timezone: string;
  /** Optional, and settable later from Settings → Clinic profile. */
  registrationNumber?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  pincode?: string;
  contactPhoneE164?: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      values.set(key, next);
      i += 1;
    }
  }

  const required = (key: string): string => {
    const value = values.get(key)?.trim();
    if (!value) {
      throw new Error(
        `Missing --${key}. Required: --name, --slug, --admin-email, --admin-name.`,
      );
    }
    return value;
  };

  const slug = required('slug').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    throw new Error(
      'The slug is the clinic subdomain, so it must be lower-case letters, digits and hyphens only.',
    );
  }

  const adminEmail = required('admin-email').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    throw new Error(`--admin-email does not look like an email address: ${adminEmail}`);
  }

  return {
    name: required('name'),
    slug,
    adminEmail,
    adminName: required('admin-name'),
    timezone: values.get('timezone') ?? 'Asia/Kolkata',
    registrationNumber: values.get('registration-number'),
    addressLine1: values.get('address'),
    city: values.get('city'),
    state: values.get('state'),
    pincode: values.get('pincode'),
    contactPhoneE164: values.get('phone'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const url =
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://emr_migrator:emr_migrator@localhost:5432/emr';

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  try {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id FROM clinic WHERE slug = ${options.slug}
    `);

    if (existing.rows.length > 0) {
      throw new Error(
        `A clinic with the slug "${options.slug}" already exists. ` +
          'Provisioning will not modify it — add staff from Settings → Staff and roles.',
      );
    }

    /*
     * A generated password, not one passed on the command line.
     *
     * An argument ends up in the shell history and in the process list, where
     * anyone on the machine can read it. This is printed once, to a terminal,
     * and never stored in plaintext anywhere.
     */
    const temporaryPassword = randomBytes(9).toString('base64url');
    const passwordHash = await argon2.hash(temporaryPassword, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    // One transaction: a clinic with no administrator is unreachable, and an
    // administrator with no clinic is meaningless.
    const client = await pool.connect();
    let clinicId: string;
    try {
      await client.query('BEGIN');

      const clinic = await client.query<{ id: string }>(
        `INSERT INTO clinic (name, slug, timezone, registration_number,
                             address_line1, city, state, pincode, contact_phone_e164)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          options.name,
          options.slug,
          options.timezone,
          options.registrationNumber ?? null,
          options.addressLine1 ?? null,
          options.city ?? null,
          options.state ?? null,
          options.pincode ?? null,
          options.contactPhoneE164 ?? null,
        ],
      );
      clinicId = clinic.rows[0]!.id;

      // password_changed_at stays NULL, which is the record that this password
      // has never been changed from the one issued here.
      await client.query(
        `INSERT INTO app_user (clinic_id, full_name, email, password_hash, role, mfa_enabled)
         VALUES ($1,$2,$3,$4,'OWNER_ADMIN',false)`,
        [clinicId, options.adminName, options.adminEmail, passwordHash],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log('');
    console.log(`  Clinic created: ${options.name}`);
    console.log(`  Slug:           ${options.slug}`);
    console.log(`  Administrator:  ${options.adminName} <${options.adminEmail}>`);
    console.log('');
    console.log(`  One-time password:  ${temporaryPassword}`);
    console.log('');
    console.log('  Read it out rather than sending it, and change it on first sign-in.');
    console.log('  It is not stored anywhere in plaintext and cannot be shown again.');
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
});
