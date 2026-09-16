/**
 * Primitives shared by every contract: identifiers, money, phone numbers,
 * pagination and the error envelope.
 */

import { z } from 'zod';

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

export const IsoDateTime = z.string().datetime({ offset: true });
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/**
 * Money is always an integer count of paise, never a float. Binary
 * floating-point currency arithmetic produces reconciliation errors that are
 * tedious to locate and embarrassing to explain to a clinic.
 */
export const Paise = z.number().int();
export type Paise = z.infer<typeof Paise>;

/**
 * E.164, normalised at write time so that "98765 43210", "09876543210" and
 * "+91 98765 43210" collide correctly. Without this, duplicate detection
 * silently fails — which is risk R4 materialising.
 */
export const PhoneE164 = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Expected an international number, e.g. +919876543210');

/** Accepts whatever the receptionist types; normalisation happens on submit. */
export const PhoneInput = z.string().trim().min(1, 'Enter a mobile number');

export function normalisePhone(raw: string, defaultCountry = '91'): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (raw.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) {
    return `+${defaultCountry}${digits.slice(1)}`;
  }
  if (digits.length > 10) return `+${digits}`;
  return null;
}

/* ------------------------------------------------------------------------- *
 * Pagination — keyset, never OFFSET
 * ------------------------------------------------------------------------- */

export const PageQuery = z.object({
  after: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof PageQuery>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** Present only where a count is cheap. Absent is not zero. */
  total?: number;
}

/* ------------------------------------------------------------------------- *
 * Errors — RFC 9457 Problem Details
 * ------------------------------------------------------------------------- */

export const Problem = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Field-level validation failures, keyed by form field path. */
  errors: z.record(z.string(), z.array(z.string())).optional(),
  /** Correlates this failure with the server log and the audit row. */
  requestId: z.string().optional(),
});
export type Problem = z.infer<typeof Problem>;

/**
 * Optimistic concurrency. Every mutation sends the version it read; the
 * database rejects a stale write rather than applying last-write-wins. Two
 * receptionists editing one patient is routine, so this is not an edge case.
 */
export const VersionedRef = z.object({
  id: Uuid,
  version: z.number().int().min(1),
});
export type VersionedRef = z.infer<typeof VersionedRef>;

export const AuditFields = z.object({
  createdAt: IsoDateTime,
  createdBy: Uuid.nullable(),
  updatedAt: IsoDateTime,
  updatedBy: Uuid.nullable(),
  version: z.number().int(),
});
