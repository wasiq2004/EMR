import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { config } from '../../config';
import type { UserRole } from '@emr/contracts';

export interface AccessClaims {
  sub: string;
  name: string;
  clinic_id: string;
  role: UserRole;
  jti: string;
}

export interface PlatformClaims {
  sub: string;
  name: string;
  role: 'SUPPORT' | 'OPERATOR' | 'PLATFORM_ADMIN';
}

/**
 * Audiences.
 *
 * A clinic token and a platform token are signed with the same secret, so the
 * audience is what keeps them apart. Without it, a clinic session would verify
 * against the platform guard: it has a `sub` and a `role`, and `OWNER_ADMIN`
 * would simply fail an authorisation check rather than being rejected as the
 * wrong KIND of credential. Distinguishing them by shape is the sort of thing
 * that holds until someone adds a field.
 */
const CLINIC_AUDIENCE = 'emr:clinic';
const PLATFORM_AUDIENCE = 'emr:platform';

/**
 * Tokens.
 *
 * The access token is short-lived and self-contained. The refresh token is
 * opaque and stored server-side, which is what makes revocation IMMEDIATE — a
 * dismissed employee's session dies when it is revoked, not when their token
 * happens to expire. Only the SHA-256 of a refresh token is stored, so a
 * database disclosure yields no usable session.
 */
@Injectable()
export class TokenService {
  private readonly key = new TextEncoder().encode(config.JWT_SECRET);

  async signAccessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(CLINIC_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { audience: CLINIC_AUDIENCE });
      if (!payload.sub || !payload.clinic_id || !payload.role || !payload.jti) return null;
      return payload as unknown as AccessClaims;
    } catch {
      return null;
    }
  }

  /**
   * A platform operator's token.
   *
   * Deliberately carries NO clinic_id — there is no clinic it belongs to, and
   * anything that tried to open a tenant transaction with it would find nothing
   * to set `app.clinic_id` to.
   *
   * Shorter-lived than a clinic session. A receptionist's machine sits logged in
   * all day because the alternative is a queue that stops moving; an account
   * that can suspend every clinic on the deployment does not get that.
   */
  async signPlatformToken(claims: PlatformClaims): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(PLATFORM_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('60m')
      .sign(this.key);
  }

  async verifyPlatformToken(token: string): Promise<PlatformClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { audience: PLATFORM_AUDIENCE });
      if (!payload.sub || !payload.role) return null;
      // A clinic token must never satisfy this, even if the audience check were
      // ever relaxed: a platform operator has no clinic.
      if (payload.clinic_id) return null;
      return payload as unknown as PlatformClaims;
    } catch {
      return null;
    }
  }

  /** 256 bits, not derived from any resource identifier. */
  issueRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
  }

  hashRefreshToken(token: string): string {
    return hashToken(token);
  }

  /** Reception machines are shared; their sessions are deliberately shorter. */
  refreshTtlSecondsFor(role: UserRole): number {
    return role === 'RECEPTIONIST'
      ? config.RECEPTION_REFRESH_TTL_SECONDS
      : config.REFRESH_TOKEN_TTL_SECONDS;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
