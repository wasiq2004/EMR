import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a payload against the shared contract.
 *
 * The schema is imported verbatim from `@emr/contracts`, the same object the
 * frontend builds its form from — so a field rename breaks the build rather
 * than production.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw result.error;
  return result.data;
}

/** For query strings, where everything arrives as a string. */
export function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query ?? {});
  if (!result.success) throw result.error;
  return result.data;
}

export function requireUuid(value: string | undefined, what: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!value || !uuid.test(value)) {
    throw new BadRequestException(`${what} is not a valid identifier.`);
  }
  return value;
}
