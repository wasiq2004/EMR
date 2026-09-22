import tseslint from 'typescript-eslint';

/**
 * The API's lint rules.
 *
 * There is one rule here that matters, and it is the reason this file exists:
 * nothing outside the tenancy module may import the raw Drizzle client.
 *
 * `TenantDb` is the only sanctioned path to the database because it is the only
 * thing that sets `app.clinic_id` inside the transaction that pins the
 * connection. A service that reaches past it to `DRIZZLE` gets a working query
 * that silently ignores row-level security — under a policy that fails closed
 * it returns nothing, and "no rows" looks like "no data" rather than like a
 * bug. That exact failure cost three separate debugging sessions during this
 * build, in sign-in, in the clinic-status check and in every audit write.
 *
 * The security core has always SAID this rule existed. It did not. Now it does.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Caught by the compiler with noUnusedLocals, and with a better message.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Drizzle's query builders are thenable; awaiting them is correct.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    // Everything EXCEPT the files that legitimately hold the client.
    ignores: [
      'src/common/tenancy/**',
      'src/database/**',
      // These three set app.clinic_id themselves and explain why in place: they
      // run before a tenant context can exist, or must outlive the request that
      // triggered them.
      'src/common/audit/audit.writer.ts',
      'src/common/rbac/practitioner-credential.cache.ts',
      'src/modules/health/health.module.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'drizzle-orm/node-postgres',
              message:
                'Go through TenantDb. It is the only thing that sets app.clinic_id ' +
                'inside the transaction that pins the connection; a query that skips ' +
                'it returns zero rows under RLS, which looks like empty data rather ' +
                'than like a bug.',
            },
          ],
          patterns: [
            {
              group: ['**/tenant-db.service'],
              importNames: ['DRIZZLE'],
              message:
                'DRIZZLE is the raw client. Inject TenantDb and use run(), ' +
                'runReadOnly() or runAs() so the tenant setting is applied.',
            },
          ],
        },
      ],
    },
  },
);
