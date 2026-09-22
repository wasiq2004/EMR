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
      .setIssuedAt()
      .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key);
      if (!payload.sub || !payload.clinic_id || !payload.role || !payload.jti) return null;
      return payload as unknown as AccessClaims;
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
