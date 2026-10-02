-- ===========================================================================
-- Availability — the security substrate for the two scheduling tables
-- ===========================================================================
--
-- Same shape as `0007` did for pharmacy, and for the same reason: Drizzle gives
-- each new table ENABLE ROW LEVEL SECURITY and a tenant policy, which is not
-- enough on its own.
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
-- A doctor's working week is not clinical data, but it is a customer's data: who
-- works where, when a clinic is closed, when somebody is on leave. A competitor
-- with that for every clinic on the deployment knows more about each of them than
-- they would choose to share.

-- ---------------------------------------------------------------------------
-- 1. Force RLS on everything carrying a clinic_id
-- ---------------------------------------------------------------------------
--
-- Generated rather than hand-listed, so a table added next year is covered by
-- having a clinic_id rather than by somebody remembering to add its name here.
-- Re-running over already-forced tables is a no-op.
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
--
-- `0001` set ALTER DEFAULT PRIVILEGES for tables created by emr_migrator, so both
-- already carry these. Re-asserted because default privileges are invisible at a
-- glance and a reviewer should not need to know they exist to believe this works.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.practitioner_schedule, public.schedule_exception
  TO emr_app;

GRANT SELECT
  ON public.practitioner_schedule, public.schedule_exception
  TO emr_readonly;

-- The messaging worker sends reminders. It has no business knowing which doctor
-- is on leave, and holds an enumerated grant list that does not include these.
REVOKE ALL
  ON public.practitioner_schedule, public.schedule_exception
  FROM emr_worker_messaging;

-- ---------------------------------------------------------------------------
-- 3. The assertions
-- ---------------------------------------------------------------------------
--
-- Re-run because two tables have joined the schema since they last did, and an
-- assertion that only ever ran before them has proved nothing about them.

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

DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(DISTINCT table_name, ', ')
  INTO leaked
  FROM information_schema.table_privileges
  WHERE grantee = 'emr_platform'
    AND table_schema = 'public'
    AND table_name NOT IN (
      'clinic',
      'subscription',
      'clinic_usage_daily',
      'platform_user',
      'platform_audit_event',
      'plan',
      'platform_setting'
    );

  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      'emr_platform has privileges on non-platform table(s): %. A platform operator must not be able to read clinic data.',
      leaked;
  END IF;
END $$;
