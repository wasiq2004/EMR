import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';

import { PlatformDbService } from './platform-db.service';
import { PasswordService } from '../../common/auth/password.service';
import { TokenService } from '../../common/auth/token.service';
import type { PlatformActor } from './platform.guard';

/**
 * What a platform operator can see and do.
 *
 * EVERY NUMBER HERE IS AN AGGREGATE. Nothing in this file reads a patient, an
 * encounter or a message, because the connection it uses has no privilege to.
 * Activity inside a clinic is visible only through `clinic_usage_daily`, which
 * a job writes from inside each tenant's own context — integers and a date.
 *
 * EVERY CHANGE IS RECORDED WITH A REASON. Suspending a clinic stops a doctor
 * mid-consultation, so the API requires a stated reason and writes it to an
 * append-only log the clinic cannot edit. An operator who cannot say why should
 * not be doing it.
 */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private readonly platform: PlatformDbService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  /* ---- Sign-in ---------------------------------------------------------- */

  /**
   * Platform sign-in, entirely separate from a clinic's.
   *
   * Different table, different token audience, different cookie. A clinic
   * session can never be mistaken for a platform one, and a clinic user cannot
   * be escalated by editing a column.
   */
  async signIn(email: string, password: string, ip: string | null, userAgent: string | null) {
    const refuse = () => new UnauthorizedException('That email and password do not match.');

    const [user] = await this.platform.db
      .select()
      .from(schema.platformUser)
      .where(eq(schema.platformUser.email, email.trim().toLowerCase()))
      .limit(1);

    if (!user || !user.isActive) throw refuse();

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException(
        'This account is locked after too many attempts. Try again shortly.',
      );
    }

    const correct = await this.passwords.verify(user.passwordHash, password);

    if (!correct) {
      const attempts = user.failedLoginAttempts + 1;
      await this.platform.db
        .update(schema.platformUser)
        .set({
          failedLoginAttempts: attempts,
          // Five, not eight. A clinic receptionist mistyping a password is
          // routine; five failures against an account that can suspend the
          // whole platform is not.
          lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
        })
        .where(eq(schema.platformUser.id, user.id));

      await this.audit({
        actor: { userId: user.id, name: user.fullName, role: user.role },
        action: 'PLATFORM_SIGN_IN_FAILED',
        outcome: 'SERIOUS_FAILURE',
        ip,
        userAgent,
      });

      throw refuse();
    }

    await this.platform.db
      .update(schema.platformUser)
      .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(schema.platformUser.id, user.id));

    const token = await this.tokens.signPlatformToken({
      sub: user.id,
      name: user.fullName,
      role: user.role,
    });

    await this.audit({
      actor: { userId: user.id, name: user.fullName, role: user.role },
      action: 'PLATFORM_SIGNED_IN',
      outcome: 'SUCCESS',
      ip,
      userAgent,
    });

    return {
      token,
      operator: { id: user.id, fullName: user.fullName, email: user.email, role: user.role },
    };
  }

  async operator(id: string) {
    const [user] = await this.platform.db
      .select({
        id: schema.platformUser.id,
        fullName: schema.platformUser.fullName,
        email: schema.platformUser.email,
        role: schema.platformUser.role,
        isActive: schema.platformUser.isActive,
      })
      .from(schema.platformUser)
      .where(eq(schema.platformUser.id, id))
      .limit(1);

    if (!user || !user.isActive) throw new UnauthorizedException('Sign in again.');
    return user;
  }

  /* ---- The estate ------------------------------------------------------- */

  /** Every clinic, with its plan and the last thing it did. */
  async tenants() {
    const rows = await this.platform.db
      .select({
        id: schema.clinic.id,
        name: schema.clinic.name,
        slug: schema.clinic.slug,
        city: schema.clinic.city,
        state: schema.clinic.state,
        contactEmail: schema.clinic.contactEmail,
        contactPhoneE164: schema.clinic.contactPhoneE164,
        isActive: schema.clinic.isActive,
        suspendedAt: schema.clinic.suspendedAt,
        suspensionReason: schema.clinic.suspensionReason,
        createdAt: schema.clinic.createdAt,
        plan: schema.subscription.plan,
        status: schema.subscription.status,
        monthlyPricePaise: schema.subscription.monthlyPricePaise,
        trialEndsAt: schema.subscription.trialEndsAt,
        maxPatients: schema.subscription.maxPatients,
      })
      .from(schema.clinic)
      .leftJoin(schema.subscription, eq(schema.subscription.clinicId, schema.clinic.id))
      // The reserved tenant that owns the shared drug catalogue is not a
      // customer and should not appear in a list of them.
      .where(sql`${schema.clinic.slug} <> '__system__'`)
      .orderBy(desc(schema.clinic.createdAt));

    const usage = await this.recentUsageByClinic(30);

    return rows.map((row) => ({
      ...row,
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
      trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      usage: usage.get(row.id) ?? emptyUsage(),
    }));
  }

  async tenant(clinicId: string) {
    const [row] = await this.platform.db
      .select()
      .from(schema.clinic)
      .where(eq(schema.clinic.id, clinicId))
      .limit(1);
    if (!row) throw new NotFoundException('That clinic could not be found.');

    const [plan] = await this.platform.db
      .select()
      .from(schema.subscription)
      .where(eq(schema.subscription.clinicId, clinicId))
      .limit(1);

    const daily = await this.platform.db
      .select()
      .from(schema.clinicUsageDaily)
      .where(
        and(
          eq(schema.clinicUsageDaily.clinicId, clinicId),
          gte(schema.clinicUsageDaily.day, isoDay(90)),
        ),
      )
      .orderBy(schema.clinicUsageDaily.day);

    return {
      clinic: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        registrationNumber: row.registrationNumber,
        city: row.city,
        state: row.state,
        contactEmail: row.contactEmail,
        contactPhoneE164: row.contactPhoneE164,
        timezone: row.timezone,
        isActive: row.isActive,
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
        suspensionReason: row.suspensionReason,
        createdAt: row.createdAt.toISOString(),
      },
      subscription: plan
        ? {
            plan: plan.plan,
            status: plan.status,
            monthlyPricePaise: plan.monthlyPricePaise,
            maxPractitioners: plan.maxPractitioners,
            maxPatients: plan.maxPatients,
            includedMessagesPerMonth: plan.includedMessagesPerMonth,
            trialEndsAt: plan.trialEndsAt?.toISOString() ?? null,
            currentPeriodEnd: plan.currentPeriodEnd?.toISOString() ?? null,
            notes: plan.notes,
          }
        : null,
      usage: daily.map((d) => ({
        day: d.day,
        activeUsers: d.activeUsers,
        patientsTotal: d.patientsTotal,
        patientsRegistered: d.patientsRegistered,
        appointments: d.appointments,
        encounters: d.encounters,
        prescriptions: d.prescriptions,
        messagesSent: d.messagesSent,
        messagesFailed: d.messagesFailed,
        storageBytes: d.storageBytes,
      })),
    };
  }

  /** One line per clinic across the estate, for the overview. */
  async overview() {
    const [totals] = await this.platform.db
      .select({
        clinics: sql<number>`count(*)::int`,
        active: sql<number>`count(*) FILTER (WHERE ${schema.clinic.isActive})::int`,
        suspended: sql<number>`count(*) FILTER (WHERE NOT ${schema.clinic.isActive})::int`,
      })
      .from(schema.clinic)
      .where(sql`${schema.clinic.slug} <> '__system__'`);

    const [revenue] = await this.platform.db
      .select({
        mrrPaise: sql<number>`coalesce(sum(${schema.subscription.monthlyPricePaise}) FILTER (WHERE ${schema.subscription.status} = 'ACTIVE'), 0)::int`,
        trials: sql<number>`count(*) FILTER (WHERE ${schema.subscription.status} = 'TRIAL')::int`,
        pastDue: sql<number>`count(*) FILTER (WHERE ${schema.subscription.status} = 'PAST_DUE')::int`,
      })
      .from(schema.subscription);

    const [activity] = await this.platform.db
      .select({
        encounters: sql<number>`coalesce(sum(${schema.clinicUsageDaily.encounters}), 0)::int`,
        prescriptions: sql<number>`coalesce(sum(${schema.clinicUsageDaily.prescriptions}), 0)::int`,
        messagesSent: sql<number>`coalesce(sum(${schema.clinicUsageDaily.messagesSent}), 0)::int`,
        messagesFailed: sql<number>`coalesce(sum(${schema.clinicUsageDaily.messagesFailed}), 0)::int`,
      })
      .from(schema.clinicUsageDaily)
      .where(gte(schema.clinicUsageDaily.day, isoDay(30)));

    return {
      clinics: totals?.clinics ?? 0,
      active: totals?.active ?? 0,
      suspended: totals?.suspended ?? 0,
      mrrPaise: revenue?.mrrPaise ?? 0,
      trials: revenue?.trials ?? 0,
      pastDue: revenue?.pastDue ?? 0,
      last30Days: {
        encounters: activity?.encounters ?? 0,
        prescriptions: activity?.prescriptions ?? 0,
        messagesSent: activity?.messagesSent ?? 0,
        messagesFailed: activity?.messagesFailed ?? 0,
      },
    };
  }

  /* ---- Changes ---------------------------------------------------------- */

  /**
   * Suspends a clinic.
   *
   * This stops a doctor mid-consultation, so it demands a reason and records it
   * against the operator who did it. The clinic-status cache re-reads on every
   * request, so it takes effect within seconds rather than at token expiry.
   */
  async suspend(actor: PlatformActor, clinicId: string, reason: string) {
    const clinic = await this.requireClinic(clinicId);
    if (!clinic.isActive) throw new ConflictException('That clinic is already suspended.');

    await this.platform.db
      .update(schema.clinic)
      .set({ isActive: false, suspendedAt: new Date(), suspensionReason: reason })
      .where(eq(schema.clinic.id, clinicId));

    await this.audit({
      actor,
      action: 'CLINIC_SUSPENDED',
      outcome: 'SUCCESS',
      clinic,
      reason,
    });

    this.logger.warn(`Clinic ${clinic.name} suspended by ${actor.name}: ${reason}`);
    return { suspended: true };
  }

  async restore(actor: PlatformActor, clinicId: string, reason: string) {
    const clinic = await this.requireClinic(clinicId);
    if (clinic.isActive) throw new ConflictException('That clinic is not suspended.');

    await this.platform.db
      .update(schema.clinic)
      .set({ isActive: true, suspendedAt: null, suspensionReason: null })
      .where(eq(schema.clinic.id, clinicId));

    await this.audit({ actor, action: 'CLINIC_RESTORED', outcome: 'SUCCESS', clinic, reason });
    return { restored: true };
  }

  /** Creates or changes a clinic's plan. */
  async setPlan(
    actor: PlatformActor,
    clinicId: string,
    input: {
      plan: string;
      status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';
      monthlyPricePaise: number;
      maxPractitioners?: number | null;
      maxPatients?: number | null;
      includedMessagesPerMonth?: number | null;
      trialEndsAt?: string | null;
      notes?: string | null;
      reason: string;
    },
  ) {
    const clinic = await this.requireClinic(clinicId);

    const [existing] = await this.platform.db
      .select()
      .from(schema.subscription)
      .where(eq(schema.subscription.clinicId, clinicId))
      .limit(1);

    const values = {
      clinicId,
      plan: input.plan,
      status: input.status,
      monthlyPricePaise: input.monthlyPricePaise,
      maxPractitioners: input.maxPractitioners ?? null,
      maxPatients: input.maxPatients ?? null,
      includedMessagesPerMonth: input.includedMessagesPerMonth ?? null,
      trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null,
      notes: input.notes ?? null,
    };

    if (existing) {
      await this.platform.db
        .update(schema.subscription)
        .set(values)
        .where(eq(schema.subscription.id, existing.id));
    } else {
      await this.platform.db.insert(schema.subscription).values(values);
    }

    await this.audit({
      actor,
      action: existing ? 'PLAN_CHANGED' : 'PLAN_CREATED',
      outcome: 'SUCCESS',
      clinic,
      reason: input.reason,
      // Before and after. "Why is this clinic on a different plan than we
      // agreed" is answerable only if the previous value was kept.
      changeSummary: {
        from: existing
          ? { plan: existing.plan, status: existing.status, monthlyPricePaise: existing.monthlyPricePaise }
          : null,
        to: { plan: values.plan, status: values.status, monthlyPricePaise: values.monthlyPricePaise },
      },
    });

    return { saved: true };
  }

  /** What operators have done. Newest first. */
  async auditTrail(clinicId?: string) {
    const rows = await this.platform.db
      .select()
      .from(schema.platformAuditEvent)
      .where(clinicId ? eq(schema.platformAuditEvent.targetClinicId, clinicId) : undefined)
      .orderBy(desc(schema.platformAuditEvent.occurredAt))
      .limit(200);

    return rows.map((row) => ({
      id: row.id,
      actorName: row.actorName,
      actorRole: row.actorRole,
      action: row.action,
      outcome: row.outcome,
      targetClinicId: row.targetClinicId,
      targetClinicName: row.targetClinicName,
      reason: row.reason,
      changeSummary: row.changeSummary,
      occurredAt: row.occurredAt.toISOString(),
    }));
  }

  /* ---- Internals -------------------------------------------------------- */

  private async requireClinic(clinicId: string) {
    const [clinic] = await this.platform.db
      .select()
      .from(schema.clinic)
      .where(eq(schema.clinic.id, clinicId))
      .limit(1);

    if (!clinic || clinic.slug === '__system__') {
      throw new NotFoundException('That clinic could not be found.');
    }
    return clinic;
  }

  /** Usage summed per clinic over the last N days, for the tenant list. */
  private async recentUsageByClinic(days: number) {
    const rows = await this.platform.db
      .select({
        clinicId: schema.clinicUsageDaily.clinicId,
        patientsTotal: sql<number>`max(${schema.clinicUsageDaily.patientsTotal})::int`,
        encounters: sql<number>`coalesce(sum(${schema.clinicUsageDaily.encounters}), 0)::int`,
        messagesSent: sql<number>`coalesce(sum(${schema.clinicUsageDaily.messagesSent}), 0)::int`,
        activeUsers: sql<number>`max(${schema.clinicUsageDaily.activeUsers})::int`,
        lastActiveDay: sql<string | null>`max(${schema.clinicUsageDaily.day})`,
      })
      .from(schema.clinicUsageDaily)
      .where(gte(schema.clinicUsageDaily.day, isoDay(days)))
      .groupBy(schema.clinicUsageDaily.clinicId);

    return new Map(rows.map((row) => [row.clinicId, row]));
  }

  private async audit(entry: {
    actor: PlatformActor;
    action: string;
    outcome: string;
    clinic?: { id: string; name: string };
    reason?: string;
    changeSummary?: unknown;
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  }) {
    try {
      await this.platform.db.insert(schema.platformAuditEvent).values({
        actorPlatformUserId: entry.actor.userId,
        actorName: entry.actor.name,
        actorRole: entry.actor.role,
        action: entry.action,
        outcome: entry.outcome,
        targetClinicId: entry.clinic?.id ?? null,
        targetClinicName: entry.clinic?.name ?? null,
        reason: entry.reason ?? null,
        changeSummary: (entry.changeSummary ?? null) as never,
        ipAddress: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        requestId: entry.requestId ?? null,
      });
    } catch (error) {
      // Never fails the action. An operator restoring a suspended clinic must
      // not be blocked because the log is briefly unavailable — but a dropped
      // entry is a gap, so it is logged at error level to alert.
      this.logger.error(`PLATFORM AUDIT WRITE FAILED action=${entry.action}: ${String(error)}`);
    }
  }
}

function emptyUsage() {
  return {
    clinicId: '',
    patientsTotal: 0,
    encounters: 0,
    messagesSent: 0,
    activeUsers: 0,
    lastActiveDay: null as string | null,
  };
}

/** An ISO date N days ago, for the `date` columns. */
function isoDay(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}
