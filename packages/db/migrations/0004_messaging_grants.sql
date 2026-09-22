-- ===========================================================================
-- Grants and forced RLS for the messaging tables
-- ===========================================================================
--
-- `0001_roles_and_rls.sql` grants privileges with GRANT ... ON ALL TABLES and
-- forces RLS with a loop over every table carrying a clinic_id. Both are
-- point-in-time: they cover the tables that exist WHEN THEY RUN. On a fresh
-- database the generated DDL comes first and everything is covered, which is
-- exactly why this gap is easy to miss — the problem only appears on a database
-- that already ran 0001, where new tables arrive afterwards with no grants and,
-- far worse, without FORCE ROW LEVEL SECURITY.
--
-- A table with ENABLE but not FORCE looks protected in every policy listing and
-- is not: the owner bypasses it. Migrations, maintenance scripts and any
-- misconfigured connection string run as the owner.
--
-- So this re-runs both, idempotently, over whatever exists now. It is written to
-- be safe to run again, and every later migration that adds a tenant table
-- should end by doing the same rather than listing table names.
-- ===========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO emr_app;
GRANT SELECT                         ON ALL TABLES IN SCHEMA public TO emr_readonly;

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
-- The messaging worker
-- ---------------------------------------------------------------------------
--
-- Sending a broadcast is a background job, so the worker needs to read what to
-- send and write what happened. It gets exactly that and nothing wider.
--
-- It can UPDATE broadcast_recipient because that is where per-message outcome
-- lands, and UPDATE broadcast because the progress counters live there. It
-- CANNOT insert or delete either: composing a broadcast and choosing its
-- audience are decisions a person makes in the application, and a compromised
-- worker must not be able to invent a send.
GRANT SELECT                 ON public.message_template     TO emr_worker_messaging;
GRANT SELECT, UPDATE         ON public.broadcast            TO emr_worker_messaging;
GRANT SELECT, UPDATE         ON public.broadcast_recipient  TO emr_worker_messaging;

-- Still nothing on internal notes. Stated here because a reviewer reading a
-- migration that hands the worker new privileges should be able to see that the
-- one boundary that matters was not quietly widened along with them.
REVOKE ALL ON public.encounter_internal_note FROM emr_worker_messaging;

-- ---------------------------------------------------------------------------
-- Assertion
-- ---------------------------------------------------------------------------
--
-- The same check `0001` ends with. Repeated because the whole point of this file
-- is that the guarantee has to hold AFTER tables are added, not only when the
-- schema was first created.
DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(c.relname, ', ')
  INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND a.attname = 'clinic_id'
    AND NOT a.attisdropped
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'Tenant table(s) without FORCED row-level security: %. Every table with a clinic_id must have both ENABLE and FORCE.',
      unprotected;
  END IF;
END $$;
