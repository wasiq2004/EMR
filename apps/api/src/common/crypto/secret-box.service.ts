import { Injectable, Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../../config';

/**
 * Encryption for secrets this system holds on someone else's behalf.
 *
 * Right now that is one thing: the WhatsApp Business access token. It is not a
 * password — we cannot hash it, because we have to present it to Meta on every
 * send — so it has to be reversible, which makes it the most dangerous kind of
 * stored secret. A clinic's token lets the holder send messages as that clinic,
 * to that clinic's patients, and read every conversation.
 *
 * The column has always been called `access_token_encrypted`. Nothing encrypted
 * it. This is that.
 *
 * AES-256-GCM, authenticated, with a random nonce per encryption. GCM rather
 * than CBC because the ciphertext must not be malleable: without the auth tag,
 * anyone with write access to the row could flip bits in a token and learn
 * things from how the API failed.
 *
 * ONE KEY, DERIVED, NOT REUSED. The key comes from ENCRYPTION_KEY through HKDF
 * with a purpose label, so the same master secret can later derive other keys
 * that cannot decrypt each other's data. It deliberately does NOT fall back to
 * JWT_SECRET: rotating the signing secret signs everyone out, which is a routine
 * thing to do, and it must not also render every clinic's WhatsApp token
 * permanently unreadable.
 *
 * WHAT THIS IS NOT. Envelope encryption with a KMS is the right answer for a
 * larger deployment, and this is deliberately shaped so the swap is contained:
 * every caller goes through seal() and open(), and the version prefix means old
 * ciphertext stays readable after the scheme changes.
 */
@Injectable()
export class SecretBoxService {
  private readonly logger = new Logger(SecretBoxService.name);

  /** Bumped when the scheme changes, so old rows can still be read. */
  private static readonly VERSION = 'v1';
  private static readonly NONCE_BYTES = 12;
  private static readonly TAG_BYTES = 16;

  private readonly key: Buffer;

  constructor() {
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(config.ENCRYPTION_KEY, 'utf8'),
        // A fixed salt is acceptable here because the input is already a
        // high-entropy secret rather than a password; HKDF is being used to
        // separate purposes, not to slow an attacker down.
        Buffer.from('emr.secret-box.v1'),
        Buffer.from('whatsapp-access-token'),
        32,
      ),
    );
  }

  /**
   * Encrypts a secret for storage.
   *
   * Output is `v1.<nonce>.<tag>.<ciphertext>`, all base64url. Self-describing so
   * a row can be read without knowing which scheme wrote it.
   */
  seal(plaintext: string): string {
    const nonce = randomBytes(SecretBoxService.NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    return [
      SecretBoxService.VERSION,
      nonce.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * Decrypts a stored secret, or returns null.
   *
   * Null rather than throwing, because every failure mode here means the same
   * operational thing — this token cannot be used — and the caller's job is to
   * tell the clinic to reconnect, not to distinguish a truncated row from a
   * rotated key. The reason is logged, never returned.
   */
  open(sealed: string | null | undefined): string | null {
    if (!sealed) return null;

    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== SecretBoxService.VERSION) {
      this.logger.error('Stored secret is not in a recognised format.');
      return null;
    }

    try {
      const nonce = Buffer.from(parts[1]!, 'base64url');
      const tag = Buffer.from(parts[2]!, 'base64url');
      const ciphertext = Buffer.from(parts[3]!, 'base64url');

      if (
        nonce.length !== SecretBoxService.NONCE_BYTES ||
        tag.length !== SecretBoxService.TAG_BYTES
      ) {
        this.logger.error('Stored secret has the wrong nonce or tag length.');
        return null;
      }

      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);

      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key, tampered ciphertext, or a truncated row. All of them mean
      // the same thing to the caller and none of them should say which.
      this.logger.error(
        'A stored secret failed to decrypt. The encryption key may have changed, ' +
          'or the row may have been altered. The affected account must be reconnected.',
      );
      return null;
    }
  }

  /**
   * The last four characters of a token, for showing which one is connected.
   *
   * Clinics have more than one number and the tokens are otherwise
   * indistinguishable; an administrator needs to tell them apart without the
   * interface ever displaying one in full.
   */
  hint(plaintext: string): string {
    return plaintext.length <= 4 ? '••••' : `••••${plaintext.slice(-4)}`;
  }

  /** Constant-time compare, for webhook signature verification. */
  static safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    // timingSafeEqual throws on a length mismatch, which would itself leak the
    // length. Compare against a same-length buffer and let the result carry it.
    if (left.length !== right.length) {
      timingSafeEqual(left, left);
      return false;
    }
    return timingSafeEqual(left, right);
  }
}
