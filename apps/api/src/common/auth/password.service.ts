import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Password hashing.
 *
 * Argon2id at the current OWASP parameters. The hash is PHC-format, so the
 * algorithm, its cost parameters and the salt travel with the value — there is
 * no separate salt column, and a parameter change does not invalidate existing
 * hashes.
 *
 * A stored hash is never returned by any response contract.
 */
@Injectable()
export class PasswordService {
  private readonly options = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed stored hash must read as "wrong password", never as an
      // error the caller could distinguish from a wrong one.
      return false;
    }
  }
}
