-- ===========================================================================
-- Lab — the security substrate, and the guards the workflow depends on
-- ===========================================================================
--
-- The generated DDL creates three tables with ENABLE ROW LEVEL SECURITY and
-- their policies, and grants nothing. Without this file `emr_app` has no
-- privilege on any of them, so ordering a test would fail with a permission
-- error.
--
-- A LAB RESULT IS THE MOST SENSITIVE ROW IN THIS SCHEMA. A diagnosis is a
-- clinician's conclusion; a result is a measured fact about somebody's body, and
-- an HIV titre or a beta-hCG leaking across a tenant boundary is not a bug anyone
-- recovers from. So the grants are narrower here than anywhere else: the
-- messaging worker is revoked explicitly, and the read-only reporting role gets
-- the ORDERS but not the RESULTS.
--
-- See 0007 for what FORCE row-level security does and does not buy — it
-- constrains `emr_app`, which every request runs as, and not the superuser that
-- owns the tables.

-- ---------------------------------------------------------------------------
-- 1. Force RLS on everything carrying a clinic_id
-- ---------------------------------------------------------------------------
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
  ON public.lab_order, public.lab_test_catalogue_item
  TO emr_app;

/*
 * No DELETE on `lab_result`, for anybody.
 *
 * A result may be why a patient was started on a drug. Correcting one supersedes
 * the previous row and keeps it — see the table's own comment — and a role that
 * can delete can erase the record of what the doctor actually acted on. The
 * service has no delete path; this makes that a property of the database rather
 * than a promise made in TypeScript.
 */
GRANT SELECT, INSERT, UPDATE ON public.lab_result TO emr_app;

/*
 * The reporting role sees ORDERS but not RESULTS.
 *
 * `emr_readonly` exists for operational reporting — how many tests were ordered,
 * how many are still outstanding — and all of that is answerable from
 * `lab_order`. None of it needs the measured value, so the value is not reachable
 * from that connection at all. The question "how many results are overdue" and
 * the question "what was Mrs Rao's haemoglobin" deserve different privileges.
 */
GRANT SELECT ON public.lab_order, public.lab_test_catalogue_item TO emr_readonly;
REVOKE ALL ON public.lab_result FROM emr_readonly;

-- The messaging worker sends reminders and holds an enumerated grant list. A
-- lab result is not on it, and must not become reachable by a worker whose job
-- is to put text into a WhatsApp message.
REVOKE ALL
  ON public.lab_order, public.lab_result, public.lab_test_catalogue_item
  FROM emr_worker_messaging;

-- ---------------------------------------------------------------------------
-- 3. One live result per order
-- ---------------------------------------------------------------------------
--
-- This is what makes "the result" unambiguous. Without it, two people entering a
-- result on the same morning would leave nobody able to say which was current —
-- and the screens, which read the row where `superseded_at IS NULL`, would pick
-- one arbitrarily.
DO $$
DECLARE
  idx oid;
BEGIN
  SELECT c.oid INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'lab_result_live_uq';

  IF idx IS NULL OR NOT (SELECT indisunique FROM pg_index WHERE indexrelid = idx) THEN
    RAISE EXCEPTION
      'lab_result_live_uq is missing or not unique. Two live results for one '
      'order would leave nobody able to say which is current.';
  END IF;

  IF (SELECT indpred FROM pg_index WHERE indexrelid = idx) IS NULL THEN
    RAISE EXCEPTION
      'lab_result_live_uq is not partial. It must apply only where superseded_at '
      'IS NULL, or a correction could never be recorded.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. A result must have a value
-- ---------------------------------------------------------------------------
--
-- Numeric or text. A row with neither is not a result, and the workflow would
-- show the order as resulted while displaying nothing — which reads as a
-- rendering fault rather than as missing data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'lab_result' AND c.conname = 'lab_result_has_a_value'
  ) THEN
    RAISE EXCEPTION
      'lab_result_has_a_value is missing. An order could be marked resulted with '
      'nothing to show.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. The shared catalogue is readable and not writable
-- ---------------------------------------------------------------------------
--
-- Same pair of failures as the diagnosis catalogue in `0011`, and both silent:
-- shared rows invisible to every clinic, or one clinic able to rewrite a test's
-- reference range for every clinic on the deployment.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'lab_test_catalogue_item'
      AND p.polcmd = 'r'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%00000000-0000-0000-0000-000000000000%'
  ) THEN
    RAISE EXCEPTION
      'lab_test_catalogue_item has no SELECT policy admitting the system tenant. '
      'The shared tests would be invisible to every clinic.';
  END IF;
END
$$;

DO $$
DECLARE
  leaky text;
BEGIN
  SELECT string_agg(p.polname, ', ')
  INTO leaky
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname IN (
      'lab_test_catalogue_item', 'diagnosis_catalogue_item', 'drug_catalogue_item'
    )
    AND p.polcmd <> 'r'
    AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
        LIKE '%00000000-0000-0000-0000-000000000000%';

  IF leaky IS NOT NULL THEN
    RAISE EXCEPTION
      'Write policy/policies % admit the system tenant. One clinic could edit a '
      'shared catalogue for every other clinic on the deployment.',
      leaky;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. The standing tenancy assertion
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

-- ---------------------------------------------------------------------------
-- 7. The operations plane still cannot read a result
-- ---------------------------------------------------------------------------
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
      'emr_platform has privileges on non-platform table(s): %. A platform '
      'operator must never be able to read a lab result.',
      leaked;
  END IF;
END
$$;
