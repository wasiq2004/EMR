import { Injectable } from '@nestjs/common';

/**
 * Revoked access tokens, by their identifier.
 *
 * Checked on EVERY request. A ten-minute access token is short, but "short" is
 * not "immediate", and the gap between dismissing a receptionist and their
 * session dying should be zero.
 *
 * In-process for now. It moves to Redis when the API runs as more than one
 * task, and the interface does not change — which is why it is a service and
 * not a module-level Set.
 */
@Injectable()
export class TokenRevocationCache {
  private readonly revoked = new Map<string, number>();

  revoke(jti: string, expiresAtMs: number): void {
    this.revoked.set(jti, expiresAtMs);
    this.sweep();
  }

  async isRevoked(jti: string): Promise<boolean> {
    const expiry = this.revoked.get(jti);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }

  /** An entry is only useful until the token would have expired anyway. */
  private sweep(): void {
    const now = Date.now();
    for (const [jti, expiry] of this.revoked) {
      if (expiry < now) this.revoked.delete(jti);
    }
  }
}
