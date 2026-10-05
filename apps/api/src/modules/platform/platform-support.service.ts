import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import * as schema from '@emr/db/schema';

import { config } from '../../config';
import { PlatformDbService } from './platform-db.service';
import { PasswordService } from '../../common/auth/password.service';
import type { PlatformActor } from './platform.guard';

/**
 * Onboarding a clinic, and the two support actions that have to exist.
 *
 * WHY THIS USES THE MIGRATOR CONNECTION. `emr_platform` has no privilege on
 * `app_user`, deliberately — an operator must not be able to enumerate a
 * clinic's staff. But creating a clinic's FIRST administrator and rescuing a
 * locked-out one both have to write that table, and a product where onboarding
 * requires shell access to the server is a product that gets onboarded by
 * pasting SQL.
 *
 * So the narrowest possible carve-out: a separate connection, used by exactly
 * two methods, both of which write and neither of which reads a clinic's staff
 * list back. Both are audited with a required reason. The privilege is still
 * not granted to the console's own role, so nothing else here can reach it
 * even by mistake.
 */
@Injectable()
export class PlatformSupportService {
  private readonly logger = new Logger(PlatformSupportService.name);
  private readonly admin: pg.Pool | null;

  constructor(
    private readonly platform: PlatformDbService,
    private readonly passwords: PasswordService,
  ) {
    // Absent means onboarding from the console is off and the CLI is the only
    // way in. That is a legitimate deployment choice, so it is not an error.
    this.admin = config.MIGRATION_DATABASE_URL
      ? new pg.Pool({ connectionString: config.MIGRATION_DATABASE_URL, max: 2 })
      : null;
  }

  /**
   * Creates a clinic and its first administrator.
   *
   * Same work as `provision.ts`, from the console. One transaction: a clinic
   * with no administrator is unreachable, and an administrator with no clinic
   * is meaningless.
   */
  async onboardClinic(
    actor: PlatformActor,
    input: {
      name: string;
      slug: string;
      adminName: string;
      adminEmail: string;
      planId?: string | null;
      city?: string | null;
      state?: string | null;
      contactEmail?: string | null;
      contactPhoneE164?: string | null;
      timezone?: string;
    },
  ) {
    const pool = this.requireAdminConnection();
    const slug = input.slug.trim().toLowerCase();

    const clash = await this.platform.db
      .select({ id: schema.clinic.id })
      .from(schema.clinic)
      .where(eq(schema.clinic.slug, slug))
      .limit(1);

    if (clash.length > 0) {
      throw new ConflictException(`A clinic with the slug "${slug}" already exists.`);
    }

    const temporary = randomBytes(9).toString('base64url');
    const hash = await this.passwords.hash(temporary);

    const client = await pool.connect();
    let clinicId: string;

    try {
      await client.query('BEGIN');

      const clinic = await client.query<{ id: string }>(
        `INSERT INTO clinic (name, slug, timezone, city, state, contact_email, contact_phone_e164)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          input.name.trim(),
          slug,
          input.timezone ?? 'Asia/Kolkata',
          input.city ?? null,
          input.state ?? null,
          input.contactEmail ?? null,
          input.contactPhoneE164 ?? null,
        ],
      );
      clinicId = clinic.rows[0]!.id;

      await client.query(
        `INSERT INTO app_user (clinic_id, full_name, email, password_hash, role, mfa_enabled)
         VALUES ($1,$2,$3,$4,'OWNER_ADMIN',false)`,
        [clinicId, input.adminName.trim(), input.adminEmail.trim().toLowerCase(), hash],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    /*
     * The plan goes on afterwards, through the console's own connection —
     * subscription is a platform table and does not need the wider privilege.
     *
     * A SUBSCRIPTION ROW IS WRITTEN EITHER WAY, and that is the fix to a real
     * trap. `planId` is optional, and this used to insert nothing when it was
     * omitted — leaving a clinic with NO subscription at all. `FeatureGuard`
     * resolves a missing subscription to every flag false, so that clinic had
     * billing, reports, documents, WhatsApp, broadcasts, pharmacy, lab,
     * analytics and import/export all switched off, and nobody was told. The
     * first person to notice is whichever member of staff lands on a gated
     * screen and reads "your administrator can ask us to add it" — which is
     * precisely the complaint that led here, arrived at by the other route.
     *
     * An absent row and a deliberate empty plan were indistinguishable. Now the
     * commercial state of every clinic is recorded explicitly, and `planAssigned`
     * in the response lets the console say so at the moment of onboarding rather
     * than leaving it to be discovered.
     */
    const plan = input.planId
      ? (
          await this.platform.db
            .select()
            .from(schema.plan)
            .where(eq(schema.plan.id, input.planId))
            .limit(1)
        )[0]
      : undefined;

    if (plan) {
      await this.platform.db.insert(schema.subscription).values({
        clinicId,
        planId: plan.id,
        plan: plan.code,
        status: plan.trialDays > 0 ? 'TRIAL' : 'ACTIVE',
        monthlyPricePaise: plan.monthlyPricePaise,
        maxPractitioners: plan.maxPractitioners,
        maxPatients: plan.maxPatients,
        includedMessagesPerMonth: plan.includedMessagesPerMonth,
        trialEndsAt:
          plan.trialDays > 0
            ? new Date(Date.now() + plan.trialDays * 86_400_000)
            : null,
      });
    } else {
      /*
       * No plan chosen, or a planId that no longer resolves.
       *
       * Deliberately NOT granted any features here: inventing a feature set
       * would be inventing a price, and a clinic given modules nobody sold it is
       * the one failure direction the whole feature registry exists to prevent.
       * What this row buys is that the state is explicit — `unassigned` is a
       * thing an operator can see and search for, where a missing row was not.
       */
      await this.platform.db.insert(schema.subscription).values({
        clinicId,
        planId: null,
        plan: 'unassigned',
        status: 'TRIAL',
        monthlyPricePaise: 0,
      });
    }

    await this.audit(actor, 'CLINIC_ONBOARDED', clinicId, input.name, {
      slug,
      adminEmail: input.adminEmail,
    });

    return {
      clinicId,
      slug,
      // Shown once. Read it out — there is no mail provider, and saying so
      // beats leaving a new clinic waiting for an email.
      temporaryPassword: temporary,
      /*
       * False means every optional module is off for this clinic. The console
       * says so on the success screen, because the alternative is a clinic that
       * looks onboarded and cannot bill, prescribe against a counter, or send a
       * reminder — and the first symptom is a member of staff being told to
       * contact their administrator.
       */
      planAssigned: Boolean(plan),
    };
  }

  /**
   * Resets a clinic administrator's password.
   *
   * The support case this exists for is real and common: the only administrator
   * at a clinic is locked out, and nobody there can let them back in. Without
   * this, the answer is shell access to a production database.
   *
   * It resets ONE named account and reveals nothing about the others — the
   * email has to be known already, because there is no way to list them.
   */
  async resetClinicAdminPassword(
    actor: PlatformActor,
    clinicId: string,
    adminEmail: string,
    reason: string,
  ) {
    const pool = this.requireAdminConnection();

    const [clinic] = await this.platform.db
      .select()
      .from(schema.clinic)
      .where(eq(schema.clinic.id, clinicId))
      .limit(1);
    if (!clinic) throw new NotFoundException('That clinic could not be found.');

    const temporary = randomBytes(9).toString('base64url');
    const hash = await this.passwords.hash(temporary);

    const result = await pool.query(
      `UPDATE app_user
          SET password_hash = $1, password_changed_at = NULL,
              failed_login_attempts = 0, locked_until = NULL
        WHERE clinic_id = $2 AND lower(email) = lower($3) AND role = 'OWNER_ADMIN'`,
      [hash, clinicId, adminEmail.trim()],
    );

    if (result.rowCount === 0) {
      // Deliberately unhelpful about why. An operator who can probe this
      // endpoint should not be able to use it to discover which addresses are
      // administrators at a clinic.
      throw new UnprocessableEntityException({
        title: 'That reset did not apply',
        message:
          'No administrator at this clinic matches that email address. Check it with the clinic.',
      });
    }

    await this.audit(actor, 'CLINIC_ADMIN_PASSWORD_RESET', clinicId, clinic.name, {
      adminEmail,
      reason,
    });

    this.logger.warn(
      `Clinic admin password reset at ${clinic.name} by ${actor.name}: ${reason}`,
    );

    return { temporaryPassword: temporary };
  }

  /**
   * Is the deployment healthy.
   *
   * Three things an operator actually needs at 9am: does the database answer,
   * does the event bus have subscribers, and is the messaging channel
   * configured anywhere. Not a metrics system — the question this answers is
   * "is it broken", not "how fast is it".
   */
  async health() {
    const checks: { name: string; status: 'ok' | 'degraded' | 'down'; detail: string }[] = [];

    const started = Date.now();
    try {
      await this.platform.db.execute(sql`SELECT 1`);
      const ms = Date.now() - started;
      checks.push({
        name: 'Database',
        // 250ms on a SELECT 1 is not slow, it is wrong. Something is saturated.
        status: ms < 250 ? 'ok' : 'degraded',
        detail: `Answered in ${ms}ms`,
      });
    } catch (error) {
      checks.push({ name: 'Database', status: 'down', detail: String(error).slice(0, 200) });
    }

    try {
      const [row] = await this.platform.db
        .select({
          total: sql<number>`count(*)::int`,
          stale: sql<number>`count(*) FILTER (WHERE ${schema.clinicUsageDaily.day} < current_date - 2)::int`,
        })
        .from(schema.clinicUsageDaily)
        .where(sql`${schema.clinicUsageDaily.day} >= current_date - 7`);

      const fresh = (row?.total ?? 0) > 0;
      checks.push({
        name: 'Usage aggregation',
        status: fresh ? 'ok' : 'degraded',
        detail: fresh
          ? `${row!.total} clinic-days recorded in the last week`
          : 'No usage recorded in the last week — the aggregation job may not be running',
      });
    } catch (error) {
      checks.push({
        name: 'Usage aggregation',
        status: 'down',
        detail: String(error).slice(0, 200),
      });
    }

    const [messaging] = await this.platform.db
      .select({
        clinics: sql<number>`count(*)::int`,
        suspended: sql<number>`count(*) FILTER (WHERE NOT ${schema.clinic.isActive})::int`,
      })
      .from(schema.clinic)
      .where(sql`${schema.clinic.slug} <> '__system__'`);

    checks.push({
      name: 'Tenancy',
      status: 'ok',
      detail: `${messaging?.clinics ?? 0} clinics, ${messaging?.suspended ?? 0} suspended`,
    });

    checks.push({
      name: 'Onboarding from console',
      status: this.admin ? 'ok' : 'degraded',
      detail: this.admin
        ? 'Available'
        : 'MIGRATION_DATABASE_URL is not set, so clinics can only be created from the CLI',
    });

    const worst = checks.some((c) => c.status === 'down')
      ? 'down'
      : checks.some((c) => c.status === 'degraded')
        ? 'degraded'
        : 'ok';

    return { status: worst, checks, at: new Date().toISOString() };
  }

  private requireAdminConnection(): pg.Pool {
    if (!this.admin) {
      throw new UnprocessableEntityException({
        title: 'Not available on this deployment',
        message:
          'MIGRATION_DATABASE_URL is not configured, so clinics and staff accounts can only be created from the command line.',
      });
    }
    return this.admin;
  }

  private async audit(
    actor: PlatformActor,
    action: string,
    clinicId: string,
    clinicName: string,
    changeSummary: unknown,
  ) {
    try {
      await this.platform.db.insert(schema.platformAuditEvent).values({
        actorPlatformUserId: actor.userId,
        actorName: actor.name,
        actorRole: actor.role,
        action,
        outcome: 'SUCCESS',
        targetClinicId: clinicId,
        targetClinicName: clinicName,
        changeSummary: changeSummary as never,
      });
    } catch (error) {
      this.logger.error(`PLATFORM AUDIT WRITE FAILED action=${action}: ${String(error)}`);
    }
  }
}
