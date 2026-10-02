import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { Session, UserRole } from '@emr/contracts';
import { config } from '../../config';
import { PasswordService } from '../../common/auth/password.service';
import { TokenService } from '../../common/auth/token.service';
import { TokenRevocationCache } from '../../common/auth/token-revocation.cache';
import { AuditWriter } from '../../common/audit/audit.writer';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { randomUUID } from 'node:crypto';

export interface SignedInUser {
  accessToken: string;
  refreshToken: string;
  refreshTtlSeconds: number;
  mfaRequired: boolean;
  session: Session;
}

/**
 * Sign-in, sessions and revocation.
 *
 * NOTE ON TENANT RESOLUTION AT SIGN-IN. Email is unique per clinic, not
 * globally — a doctor practising at two clinics has two accounts, deliberately.
 * At sign-in there is no token yet, so the clinic has to come from the request:
 * the subdomain, matched against `clinic.slug`. That is the one documented
 * exception to "the clinic is read from the verified token and nowhere else",
 * and it is narrow: the value is only ever used to look up a clinic row, never
 * trusted as an identity.
 *
 * Where no subdomain is present — a single-clinic deployment, or local
 * development — the lookup falls back to matching the email across clinics and
 * refuses if it is ambiguous, rather than guessing.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly revocation: TokenRevocationCache,
    private readonly audit: AuditWriter,
  ) {}

  async signIn(args: {
    email: string;
    password: string;
    clinicSlug: string | null;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<SignedInUser> {
    const { user, clinic } = await this.findAccount(args.email, args.clinicSlug);

    /*
     * One message for every failure. Saying "no such account" would let anyone
     * enumerate which clinicians work here, and saying "wrong password" would
     * confirm the account exists.
     */
    const refuse = () =>
      new UnauthorizedException('That email and password do not match.');

    if (!user || !clinic) throw refuse();
    if (!user.isActive) throw refuse();
    if (!clinic.isActive) {
      throw new ForbiddenException('This clinic account is suspended.');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException(
        'This account is locked after too many attempts. Try again shortly, or ask an administrator to reset it.',
      );
    }

    const correct = await this.passwords.verify(user.passwordHash, args.password);

    if (!correct) {
      await this.recordFailedAttempt(user.id, user.clinicId, user.failedLoginAttempts);
      await this.audit.append({
        clinicId: user.clinicId,
        actorUserId: user.id,
        actorName: user.fullName,
        actorRole: user.role,
        actorType: 'USER',
        action: 'SIGN_IN_FAILED',
        outcome: 'SERIOUS_FAILURE',
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      });
      throw refuse();
    }

    return this.issueSession(user, clinic, args.ipAddress, args.userAgent);
  }

  /**
   * Builds a session and its tokens.
   *
   * Two-factor is mandatory for the roles that can finalise a clinical record.
   * The session is still issued — the frontend routes to the code screen — but
   * `mfaRequired` says the sign-in is not complete.
   */
  private async issueSession(
    user: typeof schema.appUser.$inferSelect,
    clinic: typeof schema.clinic.$inferSelect,
    ipAddress: string | null,
    userAgent: string | null,
  ): Promise<SignedInUser> {
    const jti = randomUUID();
    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      name: user.fullName,
      clinic_id: user.clinicId,
      role: user.role,
      jti,
    });

    const { token: refreshToken, hash } = this.tokens.issueRefreshToken();
    const ttl = this.tokens.refreshTtlSecondsFor(user.role);

    await this.tenantDb.runAs(user.clinicId, user.id, async (tx) => {
      await tx.insert(schema.refreshSession).values({
        clinicId: user.clinicId,
        userId: user.id,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + ttl * 1000),
        ipAddress,
        userAgent,
        createdBy: user.id,
      });

      await tx
        .update(schema.appUser)
        .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(schema.appUser.id, user.id));
    });

    await this.audit.append({
      clinicId: user.clinicId,
      actorUserId: user.id,
      actorName: user.fullName,
      actorRole: user.role,
      actorType: 'USER',
      action: 'SIGNED_IN',
      outcome: 'SUCCESS',
      ipAddress,
      userAgent,
    });

    return {
      accessToken,
      refreshToken,
      refreshTtlSeconds: ttl,
      /*
       * ALWAYS FALSE TODAY, and deliberately so — owner decision, 2026-09-28.
       *
       * Enrolment was never built, so `mfaEnabled` is false on every account and
       * both branches of this expression evaluate to false. The frontend's
       * redirect to `/login/mfa` is therefore unreachable, which is what we want
       * while there is no way to enrol: sending someone to a code screen they
       * cannot satisfy would lock them out of their own clinic.
       *
       * The expression is left intact rather than hardcoded to `false` because
       * it is already correct — once enrolment exists and accounts start setting
       * `mfaEnabled`, this begins returning true on its own with no edit here.
       */
      mfaRequired: mfaIsMandatoryFor(user.role) && !user.mfaEnabled ? false : user.mfaEnabled,
      session: toSession(user, clinic),
    };
  }

  async refresh(refreshToken: string): Promise<SignedInUser> {
    const hash = this.tokens.hashRefreshToken(refreshToken);

    const [resolved] = await this.tenantDb.resolveAcrossTenants<{
      session_id: string;
      user_id: string;
      clinic_id: string;
    }>(
      'a refresh token, which is what establishes the tenant',
      sql`SELECT * FROM auth_resolve_refresh_session(${hash})`,
    );

    const expired = new UnauthorizedException('Your session has expired. Sign in again.');
    if (!resolved) throw new UnauthorizedException('Please sign in again.');

    /*
     * From here everything is inside the tenant, under RLS. Resolution gave us
     * three identifiers and nothing else; the rows themselves are read the same
     * way every other row in the system is read.
     *
     * Rotation happens in the SAME transaction as the read. The presented token
     * is consumed atomically, so two requests racing with one stolen token
     * cannot both succeed.
     */
    const found = await this.tenantDb.runAs(
      resolved.clinic_id,
      resolved.user_id,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.refreshSession)
          .where(
            and(
              eq(schema.refreshSession.id, resolved.session_id),
              isNull(schema.refreshSession.revokedAt),
            ),
          )
          .limit(1);
        if (!row) return null;
        if (row.expiresAt.getTime() < Date.now()) throw expired;

        const [user] = await tx
          .select()
          .from(schema.appUser)
          .where(eq(schema.appUser.id, row.userId))
          .limit(1);
        const [clinic] = await tx
          .select()
          .from(schema.clinic)
          .where(eq(schema.clinic.id, row.clinicId))
          .limit(1);
        if (!user || !clinic) return null;

        await tx
          .update(schema.refreshSession)
          .set({ revokedAt: new Date(), revokedReason: 'ROTATED' })
          .where(eq(schema.refreshSession.id, row.id));

        return { row, user, clinic };
      },
    );

    if (!found) throw new UnauthorizedException('Please sign in again.');

    return this.issueSession(
      found.user,
      found.clinic,
      found.row.ipAddress,
      found.row.userAgent,
    );
  }

  async signOut(jti: string, refreshToken: string | undefined): Promise<void> {
    this.revocation.revoke(jti, Date.now() + config.ACCESS_TOKEN_TTL_SECONDS * 1000);

    if (!refreshToken) return;
    const hash = this.tokens.hashRefreshToken(refreshToken);

    // Signing out is an authenticated action, so context already exists and RLS
    // confines the update to the caller's own clinic — which is exactly right:
    // a token belonging to another clinic is not this caller's to revoke.
    await this.tenantDb.run(async (tx) => {
      await tx
        .update(schema.refreshSession)
        .set({ revokedAt: new Date(), revokedReason: 'SIGNED_OUT' })
        .where(eq(schema.refreshSession.tokenHash, hash));
    });
  }

  async sessionFor(clinicId: string, userId: string): Promise<Session> {
    const result = await this.tenantDb.runAs(clinicId, userId, async (tx) => {
      const [user] = await tx
        .select()
        .from(schema.appUser)
        .where(eq(schema.appUser.id, userId))
        .limit(1);
      const [clinic] = await tx
        .select()
        .from(schema.clinic)
        .where(eq(schema.clinic.id, clinicId))
        .limit(1);
      return user && clinic ? { user, clinic } : null;
    });

    if (!result) throw new UnauthorizedException('Please sign in again.');
    return toSession(result.user, result.clinic);
  }

  /**
   * Resolves an email address to one account.
   *
   * Two steps, and the split is the point. The first crosses tenants and can
   * only learn a pair of identifiers. The second reads the actual rows inside
   * that tenant, under RLS, like every other read in the system.
   */
  private async findAccount(email: string, clinicSlug: string | null) {
    const matches = await this.tenantDb.resolveAcrossTenants<{
      user_id: string;
      clinic_id: string;
    }>(
      'an email address at sign-in, before any tenant context exists',
      sql`SELECT * FROM auth_resolve_account(${email}, ${clinicSlug})`,
    );

    // No subdomain and the address exists at more than one clinic. Refuse
    // rather than pick one: signing someone into the wrong clinic is worse than
    // asking them which one they meant.
    if (matches.length !== 1) return { user: null, clinic: null };

    const [match] = matches;
    return this.tenantDb.runAs(match!.clinic_id, match!.user_id, async (tx) => {
      const [user] = await tx
        .select()
        .from(schema.appUser)
        .where(eq(schema.appUser.id, match!.user_id))
        .limit(1);
      const [clinic] = await tx
        .select()
        .from(schema.clinic)
        .where(eq(schema.clinic.id, match!.clinic_id))
        .limit(1);

      return { user: user ?? null, clinic: clinic ?? null };
    });
  }

  /** Lockout after repeated failures, to make credential stuffing expensive. */
  private async recordFailedAttempt(
    userId: string,
    clinicId: string,
    current: number,
  ): Promise<void> {
    const attempts = current + 1;
    const lockedUntil = attempts >= 8 ? new Date(Date.now() + 15 * 60 * 1000) : null;

    await this.tenantDb.runAs(clinicId, userId, async (tx) => {
      await tx
        .update(schema.appUser)
        .set({ failedLoginAttempts: attempts, lockedUntil })
        .where(eq(schema.appUser.id, userId));
    });
  }
}

/** The roles that can finalise a clinical record must use two-factor. */
export function mfaIsMandatoryFor(role: UserRole): boolean {
  return role === 'OWNER_ADMIN' || role === 'DOCTOR';
}

function toSession(
  user: typeof schema.appUser.$inferSelect,
  clinic: typeof schema.clinic.$inferSelect,
): Session {
  const graceRemaining = mfaIsMandatoryFor(user.role) && !user.mfaEnabled
    ? Math.max(
        0,
        config.MFA_GRACE_DAYS -
          Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000),
      )
    : null;

  return {
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    clinicId: clinic.id,
    clinicName: clinic.name,
    clinicSlug: clinic.slug,
    // Holding DOCTOR is not enough to sign; the registration number is a legal
    // element of the prescription and would otherwise print blank.
    hasMedicalRegistration: Boolean(user.medicalRegistrationNumber),
    // Travels so the signature block prints the SIGNING doctor's number. It was
    // hardcoded in the print view, which meant every prescription from every
    // clinic carried one seeded doctor's registration.
    medicalRegistrationNumber: user.medicalRegistrationNumber ?? null,
    medicalCouncil: user.medicalCouncil ?? null,
    qualifications: user.qualifications ?? null,
    mfaEnabled: user.mfaEnabled,
    mfaGraceDaysRemaining: graceRemaining,
  };
}
