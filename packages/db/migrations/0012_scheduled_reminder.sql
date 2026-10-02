-- ===========================================================================
-- Scheduled reminders — the security substrate, and the claim it depends on
-- ===========================================================================
--
-- The generated DDL creates the table with `ENABLE ROW LEVEL SECURITY` and a
-- tenant policy, and grants NOTHING. Without this file `emr_app` has no
-- privilege on `scheduled_reminder` at all, so signing a consultation would fail
-- with a permission error.
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
-- A reminder row is patient data: a name is not in it, but a patient id, a
-- phone-reachable intention and a clinical follow-up date are. It is treated
-- exactly like the rest.

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
--
-- The reminder runner is an endpoint inside the API, so it connects as
-- `emr_app` like every other request and needs the full set: INSERT to schedule,
-- UPDATE to claim and to record an outcome, SELECT to read the log.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.scheduled_reminder
  TO emr_app;

GRANT SELECT ON public.scheduled_reminder TO emr_readonly;

/*
 * `emr_worker_messaging` gets SELECT and UPDATE, and deliberately NOT INSERT.
 *
 * Nothing connects as this role today — the runner is in the API. The grant is
 * here because that role's whole purpose is sending messages, and if the runner
 * ever moves out of the API process it will need to claim rows (UPDATE) and read
 * them (SELECT) and nothing else. Withholding INSERT follows the rule migration
 * `0004` set for broadcasts: a compromised messaging worker must not be able to
 * invent something to send.
 *
 * DELETE is withheld for the same reason. A reminder's history is the answer to
 * "why did my patient get that message", and a worker that can erase it can
 * erase the evidence of its own misbehaviour.
 */
GRANT SELECT, UPDATE ON public.scheduled_reminder TO emr_worker_messaging;

-- ---------------------------------------------------------------------------
-- 3. The claim has to be able to work
-- ---------------------------------------------------------------------------
--
-- `run-due` claims rows with `UPDATE ... WHERE status = 'PENDING' ... FOR UPDATE
-- SKIP LOCKED`, and that is the single mechanism stopping two overlapping cron
-- runs from sending the same patient the same message twice. Two things it needs
-- are asserted here rather than assumed, because both are easy to lose in a
-- later hand-edit and neither failure is visible until it has already happened.

-- The partial index the claim scans. Without it, a clinic with fifty thousand
-- SENT rows does a sequential scan every five minutes.
DO $$
DECLARE
  idx oid;
BEGIN
  SELECT c.oid INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'scheduled_reminder_due_idx';

  IF idx IS NULL THEN
    RAISE EXCEPTION
      'scheduled_reminder_due_idx is missing. The claim would sequentially scan '
      'the whole table on every scheduler run.';
  END IF;

  IF (SELECT indpred FROM pg_index WHERE indexrelid = idx) IS NULL THEN
    RAISE EXCEPTION
      'scheduled_reminder_due_idx is not partial. It is meant to cover PENDING '
      'rows only; the table is otherwise almost entirely history.';
  END IF;
END
$$;

-- The one-live-reminder-per-encounter guard. This is what stops the SCHEDULING
-- side creating a duplicate — signing, then amending, then signing again.
DO $$
DECLARE
  idx oid;
BEGIN
  SELECT c.oid INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'scheduled_reminder_encounter_uq';

  IF idx IS NULL OR NOT (SELECT indisunique FROM pg_index WHERE indexrelid = idx) THEN
    RAISE EXCEPTION
      'scheduled_reminder_encounter_uq is missing or not unique. One consultation '
      'could schedule two reminders and the patient would be messaged twice.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. And the idempotency key under it
-- ---------------------------------------------------------------------------
--
-- The claim is the first layer; the second is that the send writes a
-- `communication` row keyed `reminder-<id>`, so even a claim that somehow raced
-- cannot produce two messages. That index is asserted in `0010` for payments and
-- re-asserted here because the reminder path is now its second user and a
-- migration that dropped it would otherwise break this silently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'communication_idempotency_uq'
  ) THEN
    RAISE EXCEPTION
      'communication_idempotency_uq is missing. It is the layer under the reminder '
      'claim: without it a retried send can message a patient twice.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. The standing tenancy assertion
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
-- 6. The operations plane still cannot read a patient
-- ---------------------------------------------------------------------------
--
-- `ClinicDirectoryService` gives the reminder runner a clinic list through the
-- platform connection, which is BYPASSRLS. This re-asserts that the connection
-- holds privileges on platform tables and nothing else — so an attempt to read
-- `scheduled_reminder` through it is a permission error rather than a leak. That
-- property is what makes the enumeration safe, so it is checked where the
-- enumeration was introduced.
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
      'emr_platform has privileges on non-platform table(s): %. The reminder '
      'runner enumerates clinics through that connection and must not be able to '
      'read anything else.',
      leaked;
  END IF;
END
$$;
