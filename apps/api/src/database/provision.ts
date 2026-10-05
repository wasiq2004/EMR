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
 *     --admin-name "Vikram Rao" \
 *     --all-modules
 *
 * `--all-modules` is for a SELF-HOSTED single-clinic install: it writes a
 * per-clinic override turning every optional module on, so neither a plan nor
 * the operations console is needed. WITHOUT it the clinic has no plan, and
 * `FeatureGuard` resolves every optional module to off — billing, documents,
 * WhatsApp, pharmacy, lab, analytics and import/export. The command now says
 * which of the two happened, rather than leaving it to be discovered by a
 * member of staff being told to contact their administrator.
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
import { FEATURE_KEYS, allFeaturesOn } from '@emr/contracts';

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
  /**
   * Turn every optional module on, as a per-clinic override.
   *
   * For a self-hosted single-clinic install, where there is no price list and no
   * operations console in use. An EXPLICIT choice, never a default: a clinic
   * silently given modules nobody bought is the one direction the feature
   * registry exists to prevent.
   */
  allModules: boolean;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  // Bare flags, which take no value. Collected separately because a flag with
  // nothing after it would otherwise be dropped silently.
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      values.set(key, next);
      i += 1;
    } else {
      flags.add(key);
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
    allModules: flags.has('all-modules'),
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

      /*
       * A SUBSCRIPTION ROW, ALWAYS — and this used to be missing entirely.
       *
       * `FeatureGuard` resolves a clinic with no subscription to every feature
       * flag FALSE. So a clinic created by this command — the command the header
       * above calls "the only way into a fresh deployment" — came up with
       * billing, reports, documents, WhatsApp, broadcasts, pharmacy, lab,
       * analytics and import/export all switched off, and nothing said so. The
       * first person to find out is whichever member of staff lands on a gated
       * screen and is told to contact their administrator.
       *
       * An absent row and a deliberate empty plan were indistinguishable. The
       * row makes the commercial state explicit, and `--all-modules` is how a
       * self-hosted single-clinic install says "there is no price list here,
       * turn everything on" — as an explicit choice rather than a default,
       * because granting modules nobody bought is the one direction the feature
       * registry exists to prevent.
       */
      await client.query(
        `INSERT INTO subscription (clinic_id, plan_id, plan, status,
                                   monthly_price_paise, feature_overrides)
         VALUES ($1, NULL, $2, 'TRIAL', 0, $3::jsonb)`,
        [
          clinicId,
          options.allModules ? 'self-hosted' : 'unassigned',
          JSON.stringify(options.allModules ? allFeaturesOn() : {}),
        ],
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

    /*
     * The module state, said plainly.
     *
     * Printing "clinic created" and stopping is what made the featureless case
     * invisible. Whoever runs this is the only person who can fix it, and this
     * is the only moment they are looking.
     */
    if (options.allModules) {
      console.log(`  Modules:        all ${FEATURE_KEYS.length} on (--all-modules).`);
      console.log('                  Written as a per-clinic override, so no plan is needed.');
    } else {
      console.log('  Modules:        NONE. This clinic has no plan, so billing, documents,');
      console.log('                  WhatsApp, pharmacy, lab, analytics and import/export are');
      console.log('                  all off. Staff reaching those screens will be told to');
      console.log('                  contact their administrator.');
      console.log('');
      console.log('                  Re-run with --all-modules for a self-hosted install, or');
      console.log('                  assign a plan from the operations console.');
    }
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
});
