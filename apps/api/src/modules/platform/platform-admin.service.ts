import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import * as schema from '@emr/db/schema';
import { FEATURES, allFeaturesOn, resolveFeatures, type FeatureSet } from '@emr/contracts';

import { PlatformDbService } from './platform-db.service';
import { PasswordService } from '../../common/auth/password.service';
import { FeatureGuard } from '../../common/features/feature.guard';
import type { PlatformActor } from './platform.guard';

/**
 * Everything an operator configures.
 *
 * Split from `PlatformService`, which answers "what is happening". This is
 * "change it": the plan catalogue, operator accounts, deployment settings,
 * onboarding a clinic, and the two support actions that genuinely need to exist.
 *
 * ONBOARDING AND PASSWORD RESET USE THE MIGRATOR CONNECTION, not the platform
 * one, and that is not an oversight. `emr_platform` has no privilege on
 * `app_user` — deliberately, so an operator cannot enumerate a clinic's staff.
 * Creating the first administrator and resetting a locked-out one are the only
 * two things that must reach that table, they are narrow, they are audited, and
 * they are the reason the privilege is not simply granted.
 */
@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    private readonly platform: PlatformDbService,
    private readonly passwords: PasswordService,
    private readonly features: FeatureGuard,
  ) {}

  /* ---- The plan catalogue ------------------------------------------------ */

  async plans() {
    const rows = await this.platform.db
      .select()
      .from(schema.plan)
      .orderBy(asc(schema.plan.displayOrder), asc(schema.plan.name));

    // How many clinics are on each, so nobody deletes a plan out from under a
    // paying customer without seeing it first.
    const counts = await this.platform.db
      .select({
        planId: schema.subscription.planId,
        clinics: sql<number>`count(*)::int`,
      })
      .from(schema.subscription)
      .groupBy(schema.subscription.planId);

    const byPlan = new Map(counts.map((row) => [row.planId, row.clinics]));

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      monthlyPricePaise: row.monthlyPricePaise,
      annualPricePaise: row.annualPricePaise,
      maxPractitioners: row.maxPractitioners,
      maxPatients: row.maxPatients,
      maxLocations: row.maxLocations,
      includedMessagesPerMonth: row.includedMessagesPerMonth,
      storageGb: row.storageGb,
      features: resolveFeatures(row.features, null),
      isActive: row.isActive,
      isPrivate: row.isPrivate,
      trialDays: row.trialDays,
      displayOrder: row.displayOrder,
      clinicsOnPlan: byPlan.get(row.id) ?? 0,
      // Counted after resolution, so a plan that switches on `broadcasts`
      // reports the `whatsapp` it implies rather than one fewer module than it
      // actually grants.
      featureCount: Object.values(resolveFeatures(row.features, null)).filter(Boolean).length,
      featureTotal: FEATURES.length,
    }));
  }

  async savePlan(
    actor: PlatformActor,
    input: {
      id?: string;
      code: string;
      name: string;
      description?: string | null;
      monthlyPricePaise: number;
      annualPricePaise?: number | null;
      maxPractitioners?: number | null;
      maxPatients?: number | null;
      maxLocations?: number | null;
      includedMessagesPerMonth?: number | null;
      storageGb?: number | null;
      features: FeatureSet;
      isActive: boolean;
      isPrivate: boolean;
      trialDays: number;
      displayOrder: number;
    },
  ) {
    const values = {
      code: input.code.trim().toLowerCase(),
      name: input.name.trim(),
      description: input.description ?? null,
      monthlyPricePaise: input.monthlyPricePaise,
      annualPricePaise: input.annualPricePaise ?? null,
      maxPractitioners: input.maxPractitioners ?? null,
      maxPatients: input.maxPatients ?? null,
      maxLocations: input.maxLocations ?? null,
      includedMessagesPerMonth: input.includedMessagesPerMonth ?? null,
      storageGb: input.storageGb ?? null,
      // Narrowed to the registry, so a typo cannot create a flag that exists in
      // the database and is checked nowhere.
      features: pickKnownFeatures(input.features),
      isActive: input.isActive,
      isPrivate: input.isPrivate,
      trialDays: input.trialDays,
      displayOrder: input.displayOrder,
    };

    if (input.id) {
      const [existing] = await this.platform.db
        .select()
        .from(schema.plan)
        .where(eq(schema.plan.id, input.id))
        .limit(1);
      if (!existing) throw new NotFoundException('That plan could not be found.');

      await this.platform.db
        .update(schema.plan)
        .set(values)
        .where(eq(schema.plan.id, input.id));

      /*
       * Every clinic on this plan just had its features change.
       *
       * The clinic-side cache is thirty seconds, so it would correct itself —
       * but an operator who turns something on and is told it is on should not
       * then watch it fail for half a minute.
       */
      await this.invalidateClinicsOnPlan(input.id);

      await this.audit(actor, 'PLAN_UPDATED', {
        planId: input.id,
        from: { name: existing.name, features: existing.features, price: existing.monthlyPricePaise },
        to: { name: values.name, features: values.features, price: values.monthlyPricePaise },
      });

      return { id: input.id };
    }

    const duplicate = await this.platform.db
      .select({ id: schema.plan.id })
      .from(schema.plan)
      .where(eq(schema.plan.code, values.code))
      .limit(1);

    if (duplicate.length > 0) {
      throw new ConflictException(`A plan with the code "${values.code}" already exists.`);
    }

    const [created] = await this.platform.db.insert(schema.plan).values(values).returning();
    await this.audit(actor, 'PLAN_CREATED', { planId: created!.id, code: values.code });
    return { id: created!.id };
  }

  /**
   * Retires a plan rather than deleting it.
   *
   * A deleted plan breaks the subscriptions that point at it and erases what a
   * clinic agreed to. Retiring stops it being offered and leaves everyone on it
   * exactly where they are.
   */
  async retirePlan(actor: PlatformActor, planId: string) {
    const [existing] = await this.platform.db
      .select()
      .from(schema.plan)
      .where(eq(schema.plan.id, planId))
      .limit(1);
    if (!existing) throw new NotFoundException('That plan could not be found.');

    await this.platform.db
      .update(schema.plan)
      .set({ isActive: false })
      .where(eq(schema.plan.id, planId));

    await this.audit(actor, 'PLAN_RETIRED', { planId, code: existing.code });
    return { retired: true };
  }

  /* ---- Per-clinic feature overrides -------------------------------------- */

  /**
   * Turns a feature on or off for ONE clinic.
   *
   * Kept apart from the plan so that helping one customer does not silently
   * change what everyone else on that plan gets — which is what editing the
   * plan would do.
   */
  async setFeatureOverrides(
    actor: PlatformActor,
    clinicId: string,
    overrides: FeatureSet,
    reason: string,
  ) {
    const [subscription] = await this.platform.db
      .select()
      .from(schema.subscription)
      .where(eq(schema.subscription.clinicId, clinicId))
      .limit(1);

    if (!subscription) {
      throw new UnprocessableEntityException({
        title: 'This clinic has no plan',
        message: 'Assign a plan before overriding individual features.',
      });
    }

    const clean = pickKnownFeatures(overrides);

    await this.platform.db
      .update(schema.subscription)
      .set({ featureOverrides: clean })
      .where(eq(schema.subscription.id, subscription.id));

    this.features.invalidate(clinicId);

    await this.audit(actor, 'FEATURES_OVERRIDDEN', {
      clinicId,
      from: subscription.featureOverrides,
      to: clean,
      reason,
    });

    return { saved: true };
  }

  /* ---- Operators --------------------------------------------------------- */

  async operators() {
    const rows = await this.platform.db
      .select({
        id: schema.platformUser.id,
        fullName: schema.platformUser.fullName,
        email: schema.platformUser.email,
        role: schema.platformUser.role,
        isActive: schema.platformUser.isActive,
        lastLoginAt: schema.platformUser.lastLoginAt,
        lockedUntil: schema.platformUser.lockedUntil,
        createdAt: schema.platformUser.createdAt,
      })
      .from(schema.platformUser)
      .orderBy(asc(schema.platformUser.fullName));

    return rows.map((row) => ({
      ...row,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      lockedUntil: row.lockedUntil?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createOperator(
    actor: PlatformActor,
    input: { fullName: string; email: string; role: 'SUPPORT' | 'OPERATOR' | 'PLATFORM_ADMIN' },
  ) {
    const email = input.email.trim().toLowerCase();

    const existing = await this.platform.db
      .select({ id: schema.platformUser.id })
      .from(schema.platformUser)
      .where(eq(schema.platformUser.email, email))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictException('An operator with that email already exists.');
    }

    const temporary = randomBytes(12).toString('base64url');
    const hash = await this.passwords.hash(temporary);

    const [created] = await this.platform.db
      .insert(schema.platformUser)
      .values({ fullName: input.fullName.trim(), email, passwordHash: hash, role: input.role })
      .returning({ id: schema.platformUser.id });

    await this.audit(actor, 'OPERATOR_CREATED', {
      operatorId: created!.id,
      email,
      role: input.role,
    });

    // Returned once, shown once. There is no mail provider, and pretending
    // otherwise would leave the new operator waiting for an email.
    return { id: created!.id, temporaryPassword: temporary };
  }

  async updateOperator(
    actor: PlatformActor,
    operatorId: string,
    input: { role?: 'SUPPORT' | 'OPERATOR' | 'PLATFORM_ADMIN'; isActive?: boolean },
  ) {
    const [existing] = await this.platform.db
      .select()
      .from(schema.platformUser)
      .where(eq(schema.platformUser.id, operatorId))
      .limit(1);
    if (!existing) throw new NotFoundException('That operator could not be found.');

    /*
     * Nobody deactivates or demotes themselves.
     *
     * Not paternalism — it is the one mistake with no way back. An admin who
     * removes their own authority cannot restore it from the console, and on a
     * deployment with a single administrator that means a server-side fix.
     */
    if (operatorId === actor.userId) {
      if (input.isActive === false) {
        throw new UnprocessableEntityException(
          'You cannot deactivate your own account. Ask another platform administrator.',
        );
      }
      if (input.role && input.role !== existing.role) {
        throw new UnprocessableEntityException(
          'You cannot change your own role. Ask another platform administrator.',
        );
      }
    }

    // And the last administrator does not stop being one.
    if (existing.role === 'PLATFORM_ADMIN' && (input.role !== 'PLATFORM_ADMIN' || input.isActive === false)) {
      const [remaining] = await this.platform.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.platformUser)
        .where(
          sql`${schema.platformUser.role} = 'PLATFORM_ADMIN' AND ${schema.platformUser.isActive} AND ${schema.platformUser.id} <> ${operatorId}`,
        );

      if ((remaining?.count ?? 0) === 0) {
        throw new UnprocessableEntityException(
          'This is the last active platform administrator. Promote someone else first.',
        );
      }
    }

    await this.platform.db
      .update(schema.platformUser)
      .set({
        ...(input.role ? { role: input.role } : {}),
        ...(input.isActive != null ? { isActive: input.isActive } : {}),
        // An account being reactivated should not arrive still locked out.
        ...(input.isActive === true ? { failedLoginAttempts: 0, lockedUntil: null } : {}),
      })
      .where(eq(schema.platformUser.id, operatorId));

    await this.audit(actor, 'OPERATOR_UPDATED', {
      operatorId,
      email: existing.email,
      from: { role: existing.role, isActive: existing.isActive },
      to: { role: input.role ?? existing.role, isActive: input.isActive ?? existing.isActive },
    });

    return { saved: true };
  }

  async resetOperatorPassword(actor: PlatformActor, operatorId: string) {
    const [existing] = await this.platform.db
      .select()
      .from(schema.platformUser)
      .where(eq(schema.platformUser.id, operatorId))
      .limit(1);
    if (!existing) throw new NotFoundException('That operator could not be found.');

    const temporary = randomBytes(12).toString('base64url');
    const hash = await this.passwords.hash(temporary);

    await this.platform.db
      .update(schema.platformUser)
      .set({
        passwordHash: hash,
        passwordChangedAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(schema.platformUser.id, operatorId));

    await this.audit(actor, 'OPERATOR_PASSWORD_RESET', {
      operatorId,
      email: existing.email,
    });

    return { temporaryPassword: temporary };
  }

  /* ---- Deployment settings ----------------------------------------------- */

  async settings() {
    const rows = await this.platform.db.select().from(schema.platformSetting);
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    // Defaults come from the code so a fresh deployment has a complete screen
    // rather than an empty one that has to be discovered field by field.
    return DEFAULT_SETTINGS.map((setting) => ({
      key: setting.key,
      label: setting.label,
      description: setting.description,
      type: setting.type,
      value: stored.get(setting.key) ?? setting.value,
      isDefault: !stored.has(setting.key),
    }));
  }

  async saveSetting(actor: PlatformActor, key: string, value: unknown) {
    const known = DEFAULT_SETTINGS.find((setting) => setting.key === key);
    if (!known) throw new NotFoundException(`"${key}" is not a setting this deployment has.`);

    const [existing] = await this.platform.db
      .select()
      .from(schema.platformSetting)
      .where(eq(schema.platformSetting.key, key))
      .limit(1);

    await this.platform.db
      .insert(schema.platformSetting)
      .values({
        key,
        value: value as never,
        description: known.description,
        updatedBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: schema.platformSetting.key,
        set: { value: value as never, updatedAt: new Date(), updatedBy: actor.userId },
      });

    await this.audit(actor, 'SETTING_CHANGED', {
      key,
      from: existing?.value ?? known.value,
      to: value,
    });

    return { saved: true };
  }

  /* ---- Internals --------------------------------------------------------- */

  private async invalidateClinicsOnPlan(planId: string) {
    const rows = await this.platform.db
      .select({ clinicId: schema.subscription.clinicId })
      .from(schema.subscription)
      .where(eq(schema.subscription.planId, planId));

    for (const row of rows) this.features.invalidate(row.clinicId);
  }

  private async audit(actor: PlatformActor, action: string, changeSummary: unknown) {
    try {
      await this.platform.db.insert(schema.platformAuditEvent).values({
        actorPlatformUserId: actor.userId,
        actorName: actor.name,
        actorRole: actor.role,
        action,
        outcome: 'SUCCESS',
        changeSummary: changeSummary as never,
      });
    } catch (error) {
      this.logger.error(`PLATFORM AUDIT WRITE FAILED action=${action}: ${String(error)}`);
    }
  }
}

/** Narrows a submitted set to flags that exist in the registry. */
function pickKnownFeatures(input: FeatureSet): FeatureSet {
  const clean: FeatureSet = {};
  for (const feature of FEATURES) {
    if (typeof input[feature.key] === 'boolean') clean[feature.key] = input[feature.key]!;
  }
  return clean;
}

/**
 * The settings this deployment has, with their defaults.
 *
 * Declared in code rather than seeded, so a new setting appears on the screen
 * the moment it is added and an old one disappears — instead of a row lingering
 * in a table that nothing reads.
 */
export const DEFAULT_SETTINGS: {
  key: string;
  label: string;
  description: string;
  type: 'number' | 'text' | 'boolean';
  value: unknown;
}[] = [
  {
    key: 'defaultPlanCode',
    label: 'Default plan for a new clinic',
    description: 'Assigned automatically when a clinic is onboarded from this console.',
    type: 'text',
    value: 'pilot',
  },
  {
    key: 'defaultTrialDays',
    label: 'Trial length (days)',
    description: 'Used when the chosen plan does not set its own.',
    type: 'number',
    value: 30,
  },
  {
    key: 'messagePricePaise',
    label: 'WhatsApp message price (paise)',
    description:
      'What a message costs us, used to estimate a clinic’s bill. Meta bills per message for service and utility conversations.',
    type: 'number',
    value: 16,
  },
  {
    key: 'quietClinicDays',
    label: 'Flag a clinic as quiet after (days)',
    description:
      'A clinic with no recorded activity for this long is highlighted on the overview. It is the earliest warning of a cancellation there is.',
    type: 'number',
    value: 7,
  },
  {
    key: 'allowSelfServiceSignup',
    label: 'Allow clinics to sign themselves up',
    description:
      'Off means every clinic is onboarded by an operator. Turning it on has consequences beyond this console and needs the sign-up flow built first.',
    type: 'boolean',
    value: false,
  },
  {
    key: 'supportEmail',
    label: 'Support email',
    description: 'Shown to clinics when something fails and they need a person.',
    type: 'text',
    value: '',
  },
];

export { allFeaturesOn };
