-- ===========================================================================
-- Pharmacy and governed analytics — the security substrate
-- ===========================================================================
--
-- Drizzle created fifteen tables and gave each one ENABLE ROW LEVEL SECURITY and
-- a tenant policy. That is not enough, and the gap is the one `0001` exists to
-- close: ENABLE does not apply to the table's OWNER, and FORCE makes it apply.
-- `0001` forced RLS on the tables that existed when it ran; this file does the
-- same for the ones that did not.
--
-- CORRECTION, 2026-10-03. This paragraph used to end "so without FORCE every one
-- of these tables is readable across tenants by anything connected as
-- `emr_migrator`", which overstates what FORCE buys. `emr_migrator` is a
-- SUPERUSER on this deployment, and superusers — like any role with BYPASSRLS —
-- bypass row-level security unconditionally, forced or not. It reads across
-- tenants whichever way this flag is set.
--
-- FORCE is still right to set, for two reasons that do not depend on
-- constraining the migrator: the application connects as `emr_app`, which is
-- NOBYPASSRLS and is the role every request runs under; and if ownership is ever
-- moved to a non-superuser — the correct production posture — FORCE is what
-- makes the boundary hold, so setting it now turns that into a one-line ALTER
-- rather than an audit. The protection against a cross-tenant read is the GRANT
-- LIST plus the fact that nothing serving traffic connects as the migrator.
--
-- It also adds the two guarantees specific to this module:
--
--   1. `stock_movement` IS APPEND-ONLY. It is the ledger that `stock_batch`
--      caches a balance from, so a row that can be edited after the fact makes
--      the cached balance unauditable — and the reconciliation that proves the
--      count is right becomes a reconciliation against an editable record, which
--      proves nothing.
--
--   2. THE OPERATIONS CONSOLE STILL SEES NONE OF IT. Pharmacy holds patient
--      names, what they were prescribed and what they collected; the analyst
--      tables hold cohort definitions over clinical data. `emr_platform` gets no
--      privilege on any of them, and the allow-list assertion at the end of this
--      file re-proves that now that fifteen tables have been added to the
--      schema since it last ran.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Force RLS on everything carrying a clinic_id
-- ---------------------------------------------------------------------------
--
-- Generated, not hand-listed, for the same reason as in `0001`: a table added
-- next year must be covered by having a clinic_id, not by someone remembering to
-- add its name here. Re-running over the already-forced tables is a no-op.
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
-- `0001` set ALTER DEFAULT PRIVILEGES for tables created by emr_migrator, so
-- these fifteen already carry emr_app's four privileges and emr_readonly's
-- SELECT. Re-asserted explicitly anyway: default privileges are invisible at a
-- glance and a reviewer should not have to know they exist to believe the module
-- works.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.supplier,
  public.pharmacy_product,
  public.purchase_order,
  public.purchase_order_line,
  public.goods_receipt,
  public.goods_receipt_line,
  public.stock_batch,
  public.stock_movement,
  public.dispense_record,
  public.dispense_line,
  public.rx_clarification,
  public.pharmacy_sale,
  public.pharmacy_sale_line,
  public.analyst_cohort,
  public.analyst_export
TO emr_app;

GRANT SELECT ON
  public.supplier,
  public.pharmacy_product,
  public.purchase_order,
  public.purchase_order_line,
  public.goods_receipt,
  public.goods_receipt_line,
  public.stock_batch,
  public.stock_movement,
  public.dispense_record,
  public.dispense_line,
  public.rx_clarification,
  public.pharmacy_sale,
  public.pharmacy_sale_line,
  public.analyst_cohort,
  public.analyst_export
TO emr_readonly;

-- ---------------------------------------------------------------------------
-- 3. The messaging worker gets nothing here
-- ---------------------------------------------------------------------------
--
-- It holds an explicit, enumerated grant list in `0001` and `0004` and is not on
-- the default-privileges list, so it should already have nothing. Revoked
-- explicitly because "should already" is not an argument that survives a future
-- edit, and a reminder job that could read what a patient collected from the
-- pharmacy counter is a wider blast radius than sending reminders needs.
REVOKE ALL ON
  public.supplier,
  public.pharmacy_product,
  public.purchase_order,
  public.purchase_order_line,
  public.goods_receipt,
  public.goods_receipt_line,
  public.stock_batch,
  public.stock_movement,
  public.dispense_record,
  public.dispense_line,
  public.rx_clarification,
  public.pharmacy_sale,
  public.pharmacy_sale_line,
  public.analyst_cohort,
  public.analyst_export
FROM emr_worker_messaging;

-- ---------------------------------------------------------------------------
-- 4. The stock ledger is append-only
-- ---------------------------------------------------------------------------
--
-- Same construction as `audit_event` and `platform_audit_event`: the grant is
-- withdrawn AND a trigger refuses, because the two failures are different. The
-- revoke stops the application; the trigger stops a maintenance script
-- connected as the owner, which the revoke cannot.
--
-- A correction to stock is an ADJUSTMENT movement with a reason, not an edit to
-- the movement that was wrong. That is the whole point: the count on the shelf
-- and the history of how it got there are both recoverable.
REVOKE UPDATE, DELETE ON public.stock_movement FROM PUBLIC;
REVOKE UPDATE, DELETE ON public.stock_movement FROM emr_app, emr_readonly;

CREATE OR REPLACE FUNCTION stock_movement_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'stock_movement is append-only: % is not permitted. Correct stock with an ADJUSTMENT movement carrying a reason.',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS stock_movement_no_change ON public.stock_movement;
CREATE TRIGGER stock_movement_no_change
  BEFORE UPDATE OR DELETE ON public.stock_movement
  FOR EACH ROW EXECUTE FUNCTION stock_movement_is_append_only();

-- ---------------------------------------------------------------------------
-- 5. A finalised prescription stays finalised
-- ---------------------------------------------------------------------------
--
-- Already enforced. `0001_roles_and_rls.sql` attaches
-- `medication_request_finalized_immutable`, which freezes every column of a
-- prescription on a finalised encounter except its status.
--
-- This file originally added a second, narrower guard for the pharmacy module.
-- That was redundant — the existing one already covers every write path,
-- including the pharmacy's — and narrower, because it listed columns by hand
-- rather than diffing the row. `0008` removes it. The rule lives in one place.
--
-- The pharmacy module additionally holds no `prescription:update` permission and
-- exposes no route that writes `medication_request`, so the database guard is
-- the third line of defence here rather than the first.

-- ---------------------------------------------------------------------------
-- 6. The tenancy assertion, re-run
-- ---------------------------------------------------------------------------
--
-- `0001` ran this and passed against the tables that existed then. Fifteen have
-- been added since, and an assertion that only ever ran before them has proved
-- nothing about them.
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
-- 7. The platform allow-list, re-run
-- ---------------------------------------------------------------------------
--
-- The console must still hold nothing outside the seven platform tables. This is
-- the assertion from `0005`/`0006`, re-run because fifteen tables holding
-- patient names and prescription contents have just appeared in the schema and
-- the previous run could not have known about them.
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

-- ---------------------------------------------------------------------------
-- 8. The stock ledger is append-only, asserted
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = 'stock_movement'
      AND privilege_type IN ('UPDATE', 'DELETE')
      AND grantee IN ('emr_app', 'emr_readonly', 'emr_worker_messaging', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'stock_movement must not be updatable or deletable by an application role.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.stock_movement'::regclass
      AND tgname = 'stock_movement_no_change'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'The append-only trigger on stock_movement is missing.';
  END IF;
END $$;
