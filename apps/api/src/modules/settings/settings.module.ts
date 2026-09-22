import {
  Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { InviteStaff, type Clinic, type ServiceItem, type StaffUser } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { PasswordService } from '../../common/auth/password.service';
import { ClinicStatusCache } from '../../common/tenancy/clinic-status.cache';
import { PractitionerCredentialCache } from '../../common/rbac/practitioner-credential.cache';
import { Audit, RequirePermission } from '../../common/http/decorators';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { randomBytes } from 'node:crypto';

@Injectable()
export class SettingsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly clinicStatus: ClinicStatusCache,
    private readonly credentials: PractitionerCredentialCache,
  ) {}

  async clinic(): Promise<Clinic> {
    const ctx = TenantContext.require();
    const row = await this.tenantDb.runReadOnly(async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.clinic)
        .where(eq(schema.clinic.id, ctx.clinicId))
        .limit(1);
      return found;
    });
    if (!row) throw new NotFoundException('Clinic not found.');
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    } as unknown as Clinic;
  }

  /** The name and address here are printed on every prescription letterhead. */
  async updateClinic(patch: Record<string, unknown>): Promise<Clinic> {
    const ctx = TenantContext.require();

    const updated = await this.tenantDb.run(async (tx) => {
      const allowed: Record<string, unknown> = { updatedBy: ctx.userId };
      for (const key of [
        'name', 'registrationNumber', 'gstin', 'addressLine1', 'addressLine2',
        'city', 'state', 'pincode', 'contactPhoneE164', 'contactEmail', 'timezone',
      ]) {
        if (key in patch) allowed[key] = patch[key];
      }

      const [row] = await tx
        .update(schema.clinic)
        .set(allowed)
        .where(eq(schema.clinic.id, ctx.clinicId))
        .returning();
      return row!;
    });

    this.clinicStatus.invalidate(ctx.clinicId);
    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    } as unknown as Clinic;
  }

  async staff(): Promise<StaffUser[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.appUser).orderBy(asc(schema.appUser.fullName)),
    );

    // The password hash is never returned by any response contract.
    return rows.map(({ passwordHash: _hash, mfaSecretEncrypted: _secret, ...user }) => ({
      ...user,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    })) as unknown as StaffUser[];
  }

  /**
   * Invites a staff member.
   *
   * Returns a one-time password rather than emailing one, because no mail
   * provider is connected. Saying so plainly beats pretending an email was
   * sent — an administrator can read it out, and it must be changed on first
   * sign-in.
   */
  async invite(input: Record<string, unknown>): Promise<{ user: StaffUser; temporaryPassword: string }> {
    const ctx = TenantContext.require();
    const temporary = randomBytes(9).toString('base64url');
    const hash = await this.passwords.hash(temporary);

    const user = await this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.appUser)
        .values({
          clinicId: ctx.clinicId,
          fullName: String(input.fullName),
          email: String(input.email).toLowerCase(),
          mobileE164: (input.mobileE164 as string) ?? null,
          passwordHash: hash,
          role: input.role as 'DOCTOR',
          // Without this a doctor cannot sign: it is a legally required element
          // of the prescription and would otherwise print blank.
          medicalRegistrationNumber: (input.medicalRegistrationNumber as string) ?? null,
          medicalCouncil: (input.medicalCouncil as string) ?? null,
          qualifications: (input.qualifications as string) ?? null,
          specialty: (input.specialty as string) ?? null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return created!;
    });

    const { passwordHash: _h, mfaSecretEncrypted: _s, ...safe } = user;
    return {
      user: {
        ...safe,
        lastLoginAt: null,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      } as unknown as StaffUser,
      temporaryPassword: temporary,
    };
  }

  async updateStaff(userId: string, patch: Record<string, unknown>) {
    const ctx = TenantContext.require();

    const updated = await this.tenantDb.run(async (tx) => {
      const allowed: Record<string, unknown> = { updatedBy: ctx.userId };
      for (const key of [
        'fullName', 'mobileE164', 'role', 'medicalRegistrationNumber',
        'medicalCouncil', 'qualifications', 'specialty', 'isActive',
      ]) {
        if (key in patch) allowed[key] = patch[key];
      }

      const [row] = await tx
        .update(schema.appUser)
        .set(allowed)
        .where(eq(schema.appUser.id, userId))
        .returning();
      if (!row) throw new NotFoundException('That staff member could not be found.');
      return row;
    });

    // The signing gate reads this, so a stale cache would refuse a doctor who
    // has just had their number added.
    this.credentials.invalidate(ctx.clinicId, userId);

    const { passwordHash: _h, mfaSecretEncrypted: _s, ...safe } = updated;
    return safe;
  }

  /** No self-service reset exists, so an administrator does it from here. */
  async resetPassword(userId: string): Promise<{ temporaryPassword: string }> {
    const temporary = randomBytes(9).toString('base64url');
    const hash = await this.passwords.hash(temporary);

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.appUser)
        .set({ passwordHash: hash, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(schema.appUser.id, userId)),
    );

    return { temporaryPassword: temporary };
  }

  async services(): Promise<ServiceItem[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.serviceItem)
        .where(eq(schema.serviceItem.isActive, true))
        .orderBy(asc(schema.serviceItem.displayOrder)),
    );
    return rows.map((r) => ({ ...r, defaultFeePaise: Number(r.defaultFeePaise) })) as ServiceItem[];
  }

  async locations() {
    return this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.clinicLocation).orderBy(asc(schema.clinicLocation.name)),
    );
  }

  async consentsFor(patientId: string) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.consent).where(eq(schema.consent.patientId, patientId)),
    );
    return rows.map((r) => ({
      ...r,
      grantedAt: r.grantedAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    }));
  }
}

@Controller()
class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @RequirePermission('clinic:read')
  @Get('clinic')
  clinic() {
    return this.settings.clinic();
  }

  @RequirePermission('clinic:update')
  @Audit('CLINIC_UPDATED', 'clinic')
  @Patch('clinic')
  updateClinic(@Body() body: Record<string, unknown>) {
    return this.settings.updateClinic(body ?? {});
  }

  @RequirePermission('user:read')
  @Get('users')
  async staff() {
    return { items: await this.settings.staff() };
  }

  @RequirePermission('user:create')
  @Audit('STAFF_INVITED', 'user')
  @Post('users')
  invite(@Body() body: unknown) {
    return this.settings.invite(parseBody(InviteStaff, body) as never);
  }

  @RequirePermission('user:update')
  @Audit('STAFF_UPDATED', 'user')
  @Patch('users/:id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.settings.updateStaff(requireUuid(id, 'Staff member'), body ?? {});
  }

  @RequirePermission('user:update')
  @Audit('PASSWORD_RESET', 'user')
  @Post('users/:id/reset-password')
  reset(@Param('id') id: string) {
    return this.settings.resetPassword(requireUuid(id, 'Staff member'));
  }

  @RequirePermission('clinic:read')
  @Get('services')
  async services() {
    return { items: await this.settings.services() };
  }

  @RequirePermission('clinic:read')
  @Get('locations')
  async locations() {
    return { items: await this.settings.locations() };
  }

  @RequirePermission('consent:read')
  @Get('patients/:id/consents')
  consents(@Param('id') id: string) {
    return this.settings.consentsFor(requireUuid(id, 'Patient'));
  }
}

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
