-- ===========================================================================
-- Pharmacy and governed analytics — the security substrate
-- ===========================================================================
--
-- Drizzle created fifteen tables and gave each one ENABLE ROW LEVEL SECURITY and
-- a tenant policy. That is not enough, and the gap is the one `0001` exists to
-- close: ENABLE does not apply to the table's OWNER, so without FORCE every one
-- of these tables is readable across tenants by anything connected as
-- `emr_migrator`. `0001` forced RLS on the tables that existed when it ran; this
-- file does the same for the ones that did not.
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
-- The pharmacy reads `medication_request` and must never write it. That is
-- enforced in the API by the permission matrix — PHARMACIST holds
-- `prescription:read` and not `:update` — and the matrix is the real control.
--
-- This is the second line: the pharmacist's connection is the same `emr_app`
-- role as everyone else's, so a defect in a pharmacy handler could in principle
-- issue the UPDATE that the permission matrix intended to prevent. A trigger
-- cannot distinguish which HTTP route it was called from, so the narrow, honest
-- version of the guarantee is what can actually be asserted: once an encounter
-- is FINISHED, the clinical fields of its prescriptions are immutable for
-- everyone, and the amendment flow already creates a new version rather than
-- editing the old one.
CREATE OR REPLACE FUNCTION medication_request_finalised_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status encounter_status;
BEGIN
  SELECT status INTO parent_status FROM encounter WHERE id = OLD.encounter_id;

  IF parent_status IS DISTINCT FROM 'FINISHED' THEN
    RETURN NEW;
  END IF;

  -- The clinical substance of the order. Deliberately NOT every column: `status`
  -- moves legitimately after finalisation (a course is STOPPED or COMPLETED),
  -- and the audit columns move on every write.
  IF NEW.drug_display_name  IS DISTINCT FROM OLD.drug_display_name
     OR NEW.molecule_name    IS DISTINCT FROM OLD.molecule_name
     OR NEW.strength         IS DISTINCT FROM OLD.strength
     OR NEW.dosage_form      IS DISTINCT FROM OLD.dosage_form
     OR NEW.route            IS DISTINCT FROM OLD.route
     OR NEW.frequency        IS DISTINCT FROM OLD.frequency
     OR NEW.duration_days    IS DISTINCT FROM OLD.duration_days
     OR NEW.quantity         IS DISTINCT FROM OLD.quantity
     OR NEW.instructions     IS DISTINCT FROM OLD.instructions
     OR NEW.catalogue_item_id IS DISTINCT FROM OLD.catalogue_item_id
  THEN
    RAISE EXCEPTION
      'A prescription on a finalised encounter cannot be altered. Amend the encounter, which creates a new version, or raise a clarification.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS medication_request_finalised_immutable ON public.medication_request;
CREATE TRIGGER medication_request_finalised_immutable
  BEFORE UPDATE ON public.medication_request
  FOR EACH ROW EXECUTE FUNCTION medication_request_finalised_is_immutable();

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
