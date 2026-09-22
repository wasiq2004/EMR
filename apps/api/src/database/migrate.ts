/**
 * Migration runner.
 *
 * Runs as the OWNER role, because it needs DDL. The application never does.
 *
 * Order matters and is not incidental:
 *   1. `0000_prelude.sql` — extensions and roles, which the tables depend on
 *   2. the generated table DDL and its policies
 *   3. `0001_roles_and_rls.sql` — grants, forced RLS, the immutability
 *      triggers, and the assertion that fails the migration if any tenant
 *      table is unprotected
 *
 * Step 3 has to come last because it inspects the tables created in step 2.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Migrations live with the schema, not with the API.
 *
 * Resolved from the installed package so the path is the same whether this runs
 * from source in development or from dist inside the container.
 */
const MIGRATIONS = path.join(
  path.dirname(require.resolve('@emr/db/package.json')),
  'migrations',
);

async function sqlFilesIn(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function run() {
  const url =
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/emr';

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map(
        (r) => r.name,
      ),
    );

    const prelude = await sqlFilesIn(MIGRATIONS);
    const generated = (await sqlFilesIn(path.join(MIGRATIONS, 'generated'))).map(
      (f) => path.join('generated', f),
    );

    // Prelude first, then tables, then the security substrate.
    const ordered = [
      ...prelude.filter((f) => f.startsWith('0000')),
      ...generated,
      ...prelude.filter((f) => !f.startsWith('0000')),
    ];

    for (const name of ordered) {
      if (applied.has(name)) {
        console.log(`  skip  ${name}`);
        continue;
      }

      const sql = await readFile(path.join(MIGRATIONS, name), 'utf8');
      console.log(`  run   ${name}`);

      // Each migration is one transaction: it lands whole or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
      }
    }

    await setRolePasswords(client);

    console.log('Migrations complete.');
  } finally {
    await client.end();
  }
}

/**
 * Rotates the login roles' passwords to whatever the environment supplies.
 *
 * The prelude creates each role with a literal password, because a migration
 * has to be runnable by hand against an empty database and cannot read a
 * secret manager. Those literals are fine for local development and are not
 * fine anywhere else, so this runs straight after and replaces them.
 *
 * Silent when the variables are unset — that is the local case, and failing
 * there would make `docker compose up` require a secret store.
 */
async function setRolePasswords(client: pg.Client): Promise<void> {
  const roles: [string, string | undefined][] = [
    ['emr_app', process.env.APP_DB_PASSWORD],
    ['emr_worker_messaging', process.env.WORKER_DB_PASSWORD],
    ['emr_readonly', process.env.READONLY_DB_PASSWORD],
  ];

  for (const [role, password] of roles) {
    if (!password) continue;

    // ALTER ROLE accepts no bind parameters, so the password has to be inlined.
    // The role names come from the fixed list above and never from input; the
    // password is escaped by doubling quotes, which is the whole of SQL string
    // escaping when standard_conforming_strings is on — and it is, by default,
    // and the prelude does not change it.
    const literal = `'${password.replace(/'/g, "''")}'`;
    await client.query(`ALTER ROLE ${role} PASSWORD ${literal}`);

    console.log(`  password set for ${role}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
