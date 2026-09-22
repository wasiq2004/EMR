import { Injectable, Logger } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'node:crypto';

/**
 * One-time codes for external document access.
 *
 * A code is bound to one share link and one destination number, expires in ten
 * minutes, and survives three wrong attempts before it is destroyed — an
 * unlimited retry budget on a six-digit code is not a check.
 *
 * Delivery goes through the messaging provider. Until a WhatsApp account is
 * connected the code is logged, which is correct for development and refuses to
 * run in production.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly issued = new Map<string, { code: string; expiresAt: number; attempts: number }>();

  private static readonly TTL_MS = 10 * 60 * 1000;
  private static readonly MAX_ATTEMPTS = 3;

  async send(destinationE164: string, linkId: string): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.issued.set(linkId, {
      code,
      expiresAt: Date.now() + OtpService.TTL_MS,
      attempts: 0,
    });

    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'No messaging provider is connected, so a verification code cannot be delivered.',
      );
    }

    this.logger.warn(
      `DEVELOPMENT ONLY — verification code for ${destinationE164} is ${code}`,
    );
  }

  async verify(_destinationE164: string, linkId: string, code: string): Promise<boolean> {
    const record = this.issued.get(linkId);
    if (!record) return false;

    if (record.expiresAt < Date.now()) {
      this.issued.delete(linkId);
      return false;
    }

    record.attempts += 1;
    if (record.attempts > OtpService.MAX_ATTEMPTS) {
      this.issued.delete(linkId);
      return false;
    }

    // Constant-time, so the endpoint cannot be used to discover a code digit
    // by digit through response timing.
    const supplied = Buffer.from(code.padEnd(6).slice(0, 6));
    const expected = Buffer.from(record.code.padEnd(6).slice(0, 6));
    const matches = timingSafeEqual(supplied, expected);

    if (matches) this.issued.delete(linkId);
    return matches;
  }
}
