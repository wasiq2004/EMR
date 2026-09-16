import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  {
    rules: {
      /*
       * Unused code is caught by the compiler (noUnusedLocals), so the lint
       * rule would only duplicate it — and with a worse message.
       */
      '@typescript-eslint/no-unused-vars': 'off',

      /*
       * The mock API deals in loosely-typed request bodies before they are
       * narrowed, and a few Radix generics need a cast. Flagged rather than
       * banned, so each one stays a deliberate choice.
       */
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
