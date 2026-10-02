-- ===========================================================================
-- Diagnosis catalogue — the security substrate, and the shared-read assertion
-- ===========================================================================
--
-- Same job `0007` did for pharmacy and `0009` for availability: Drizzle gives the
-- new table ENABLE ROW LEVEL SECURITY and its policies, which is not enough on
-- its own.
--
-- WHAT `FORCE` ACTUALLY BUYS, stated accurately, because the obvious claim is
-- wrong and was written down here before it was checked.
--
-- `ENABLE ROW LEVEL SECURITY` does not apply to a table's OWNER. `FORCE` makes
-- it apply. What `FORCE` does NOT do is constrain a SUPERUSER or a role with
-- BYPASSRLS — those bypass row-level security unconditionally, forced or not.
-- On this deployment `emr_migrator` owns every table and is a superuser, so it
-- reads across tenants whatever this setting says. A `psql` session as the
-- migrator sees every clinic, and a verification script that forgets this counts
-- other clinics' rows.
--
-- `FORCE` is still worth setting, for two reasons that do not depend on the
-- migrator being constrained:
--   * the application connects as `emr_app`, which is NOBYPASSRLS, and that is
--     the role every request runs under — the tenant boundary that matters;
--   * if ownership is ever moved to a non-superuser, which is the right
--     production posture, `FORCE` is what makes the boundary hold. Setting it
--     now means that change is a one-line `ALTER` rather than an audit.
--
-- The protection against cross-tenant reads is therefore the GRANT LIST and the
-- fact that nothing serving traffic connects as the migrator — not this flag.
--
-- This one carries an extra assertion the others do not need, because it is
-- SHARED REFERENCE DATA and that is a harder thing to get right than a private
-- table. Two opposite failures are possible and both are silent:
--
--   * the shared rows are NOT readable, and the typeahead returns nothing for
--     every clinic while the seed reports success; or
--   * a clinic can WRITE to the system tenant, and one clinic's edit to a
--     diagnosis code changes what every other clinic on the deployment sees.
--
-- The second is the serious one. A clinic renaming "Acute pharyngitis" to its
-- own shorthand would rewrite it for every clinic in the country.

-- ---------------------------------------------------------------------------
-- 1. Force RLS on everything carrying a clinic_id
-- ---------------------------------------------------------------------------
--
-- Generated rather than hand-listed, so a table added next year is covered by
-- having a clinic_id rather than by somebody remembering to add its name here.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'clinic_id'
      AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', t.relname);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.diagnosis_catalogue_item
  TO emr_app;

GRANT SELECT ON public.diagnosis_catalogue_item TO emr_readonly;

-- The messaging worker sends reminders and has an enumerated grant list. A
-- diagnosis code list is not on it.
REVOKE ALL ON public.diagnosis_catalogue_item FROM emr_worker_messaging;

-- ---------------------------------------------------------------------------
-- 3. The shared-reference assertions
-- ---------------------------------------------------------------------------

-- The system tenant must exist, or every clinic's typeahead is empty and the
-- seed has nowhere to put its rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.clinic WHERE id = '00000000-0000-0000-0000-000000000000'::uuid
  ) THEN
    RAISE NOTICE
      'The system tenant does not exist yet; seed.ts creates it. Shared reference rows have nowhere to live until it does.';
  END IF;
END
$$;

-- A SELECT policy that admits the system tenant, so shared rows are readable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'diagnosis_catalogue_item'
      AND p.polcmd = 'r'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%00000000-0000-0000-0000-000000000000%'
  ) THEN
    RAISE EXCEPTION
      'diagnosis_catalogue_item has no SELECT policy admitting the system tenant. '
      'The shared codes would be invisible to every clinic while the seed reports success.';
  END IF;
END
$$;

-- And NO write policy that admits it. This is the one that matters: a clinic
-- able to write to the system tenant would rewrite a diagnosis code for every
-- other clinic on the deployment.
DO $$
DECLARE
  leaky text;
BEGIN
  SELECT string_agg(p.polname, ', ')
  INTO leaky
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname IN ('diagnosis_catalogue_item', 'drug_catalogue_item')
    AND p.polcmd <> 'r'
    AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
        LIKE '%00000000-0000-0000-0000-000000000000%';

  IF leaky IS NOT NULL THEN
    RAISE EXCEPTION
      'Write policy/policies % admit the system tenant. One clinic could edit the '
      'shared catalogue for every other clinic on the deployment.',
      leaky;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. The standing tenancy assertion
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  unprotected text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'clinic_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND (
      NOT c.relrowsecurity
      OR NOT c.relforcerowsecurity
      OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
    );

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'TENANCY VIOLATION — tables with clinic_id lacking forced RLS or a policy: %',
      array_to_string(unprotected, ', ');
  END IF;
END
$$;
