import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import {
  InviteStaff,
  SaveLocation,
  SaveServiceItem,
  type Clinic,
  type ServiceItem,
  type StaffUser,
} from '@emr/contracts';
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
   * The bookable practitioners.
   *
   * Separate from `staff()` and deliberately narrower. Reception has to choose
   * which doctor an appointment is with, and the walk-in dialog has to offer
   * the same list — but neither needs the staff directory, which carries email
   * addresses, roles, lockout state and last-sign-in times. Granting `user:read`
   * to the front desk to make a dropdown work would hand over all of it.
   *
   * Gated on `appointment:read` instead: whoever can see the diary can see who
   * the appointments are with. Four fields leave, and the registration flag is
   * one of them so the interface can say why a doctor cannot sign rather than
   * failing at the last step.
   */
  async practitioners(): Promise<
    { id: string; fullName: string; qualifications: string | null; hasMedicalRegistration: boolean }[]
  > {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          id: schema.appUser.id,
          fullName: schema.appUser.fullName,
          qualifications: schema.appUser.qualifications,
          registration: schema.appUser.medicalRegistrationNumber,
          role: schema.appUser.role,
          isActive: schema.appUser.isActive,
        })
        .from(schema.appUser)
        .orderBy(asc(schema.appUser.fullName)),
    );

    return rows
      .filter((row) => row.isActive && row.role === 'DOCTOR')
      .map((row) => ({
        id: row.id,
        fullName: row.fullName,
        qualifications: row.qualifications,
        hasMedicalRegistration: Boolean(row.registration),
      }));
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
      /*
       * A duplicate email is a CONFLICT, not a server error.
       *
       * Without this the unique index raised straight out of the handler and the
       * administrator saw "Something went wrong at our end" — which is both untrue
       * and unactionable. The email already being in use is something they can
       * fix in five seconds, once they are told.
       */
      const [clash] = await tx
        .select({ id: schema.appUser.id, isActive: schema.appUser.isActive })
        .from(schema.appUser)
        .where(eq(schema.appUser.email, String(input.email).toLowerCase()))
        .limit(1);

      if (clash) {
        throw new ConflictException(
          clash.isActive
            ? 'Somebody at this clinic already uses that email address.'
            : 'A deactivated account already uses that email address. Reactivate it from the staff list rather than creating a second.',
        );
      }

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

  /**
   * Creates or updates a billable service.
   *
   * RETIRED, NEVER DELETED. Invoices raised last year reference these rows by id
   * and have to keep resolving to a name — a deleted service turns a historical
   * invoice into a line that says nothing.
   */
  async saveService(input: Record<string, unknown>) {
    const ctx = TenantContext.require();

    const values = {
      name: String(input.name).trim(),
      code: (input.code as string) || null,
      description: (input.description as string) || null,
      defaultFeePaise: Number(input.defaultFeePaise ?? 0),
      hsnSacCode: (input.hsnSacCode as string) || null,
      taxRateBps: Number(input.taxRateBps ?? 0),
      defaultDurationMinutes: input.defaultDurationMinutes
        ? Number(input.defaultDurationMinutes)
        : null,
      practitionerId: (input.practitionerId as string) || null,
      isActive: input.isActive !== false,
      displayOrder: Number(input.displayOrder ?? 0),
      updatedBy: ctx.userId,
    };

    const row = await this.tenantDb.run(async (tx) => {
      if (input.id) {
        const [updated] = await tx
          .update(schema.serviceItem)
          .set(values)
          .where(eq(schema.serviceItem.id, String(input.id)))
          .returning();
        if (!updated) throw new NotFoundException('That service could not be found.');
        return updated;
      }
      const [created] = await tx
        .insert(schema.serviceItem)
        .values({ ...values, clinicId: ctx.clinicId, createdBy: ctx.userId })
        .returning();
      return created!;
    });

    return { ...row, defaultFeePaise: Number(row.defaultFeePaise) };
  }

  async locations() {
    return this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.clinicLocation).orderBy(asc(schema.clinicLocation.name)),
    );
  }

  /**
   * Creates or updates a location.
   *
   * Exactly one location is primary. Promoting one demotes the rest in the same
   * transaction, because two primaries is a state nothing downstream knows how to
   * read and it appears the moment someone ticks the box twice.
   */
  async saveLocation(input: Record<string, unknown>) {
    const ctx = TenantContext.require();

    /*
     * Name, city, state, pincode and the two flags — that is the whole table.
     * A location does not carry a street address or a phone of its own; those
     * live on `clinic`, and duplicating them here would give a clinic two
     * addresses that could disagree.
     */
    const values = {
      name: String(input.name).trim(),
      city: (input.city as string) || null,
      state: (input.state as string) || null,
      pincode: (input.pincode as string) || null,
      isPrimary: input.isPrimary === true,
      isActive: input.isActive !== false,
      updatedBy: ctx.userId,
    };

    return this.tenantDb.run(async (tx) => {
      if (values.isPrimary) {
        await tx
          .update(schema.clinicLocation)
          .set({ isPrimary: false, updatedBy: ctx.userId })
          .where(eq(schema.clinicLocation.isPrimary, true));
      }

      if (input.id) {
        const [updated] = await tx
          .update(schema.clinicLocation)
          .set(values)
          .where(eq(schema.clinicLocation.id, String(input.id)))
          .returning();
        if (!updated) throw new NotFoundException('That location could not be found.');
        return updated;
      }

      const [created] = await tx
        .insert(schema.clinicLocation)
        .values({ ...values, clinicId: ctx.clinicId, createdBy: ctx.userId })
        .returning();
      return created!;
    });
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

  /** The practitioner picker. See `practitioners()` for why it is not `/users`. */
  @RequirePermission('appointment:read')
  @Get('practitioners')
  async practitioners() {
    return { items: await this.settings.practitioners() };
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

  @RequirePermission('clinic:update')
  @Audit('SERVICE_SAVED', 'clinic')
  @Post('services')
  saveService(@Body() body: unknown) {
    const input = parseBody(SaveServiceItem, body);
    return this.settings.saveService(input as never);
  }

  @RequirePermission('clinic:update')
  @Audit('LOCATION_SAVED', 'clinic')
  @Post('locations')
  saveLocation(@Body() body: unknown) {
    const input = parseBody(SaveLocation, body);
    return this.settings.saveLocation(input as never);
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
