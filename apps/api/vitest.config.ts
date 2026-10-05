import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Unit tests for the parts of the API that are pure functions.
 *
 * Deliberately a small surface. Almost everything in this service is only true
 * against a real Postgres with row-level security on — which is what
 * `scripts/verify/*.sh` is for, and what a mocked database would quietly fail to
 * check. What belongs here is the logic that is wrong in ways a database cannot
 * reveal: text decoding, CSV grammar, arithmetic.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@emr/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
