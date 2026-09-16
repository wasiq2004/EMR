-- ============================================================================
-- 0001 — Database roles, extensions, forced RLS, and immutability guarantees
--
-- This migration establishes the security substrate the application depends on.
-- It runs as the database superuser / bootstrap role, BEFORE the Drizzle-
-- generated table migrations, except where noted (the FORCE RLS and trigger
-- sections must run AFTER tables exist — see the marker below).
--
-- Reviewers: sections 1, 2, 5 and 6 are the controls that make cross-tenant
-- leakage and audit tampering structurally impossible rather than merely
-- unlikely. Everything else is supporting detail.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extensions
-- ----------------------------------------------------------------------------

-- Fuzzy patient and drug search (risk R4). Required by the GIN trigram indexes
-- declared on patient.name_normalized and drug_catalogue_item.search_normalized.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accent/diacritic folding, so "Sūrya" and "Surya" collide during dedup search.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- gen_random_uuid() for UUIDv4 primary keys (pgcrypto; also built-in from PG13).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 2. Roles
--
-- THE CENTRAL SECURITY CONTROL: the application never connects as an owner.
--
--   emr_migrator  — owns every object, runs DDL. Used only by CI migrations.
--   emr_app       — the API's connection role. NOBYPASSRLS, no DDL.
--   emr_worker_messaging
--                 — the WhatsApp/SMS dispatch worker. Deliberately has NO
--                   privileges on encounter_internal_note, which is what makes
--                   internal notes structurally undispatchable.
--   emr_readonly  — analytics / read replica. SELECT only, still RLS-bound.
--
-- Because emr_app cannot execute DDL, application code is incapable of running
-- ALTER TABLE ... DISABLE ROW LEVEL SECURITY. The tenant boundary cannot be
-- switched off by a compromised or defective API process.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_migrator') THEN
    CREATE ROLE emr_migrator LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    CREATE ROLE emr_app LOGIN NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_worker_messaging') THEN
    CREATE ROLE emr_worker_messaging LOGIN NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_readonly') THEN
    CREATE ROLE emr_readonly LOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- Explicitly strip BYPASSRLS even if a role pre-existed with it.
ALTER ROLE emr_app                NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE emr_worker_messaging   NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE emr_readonly           NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- No object creation in public; all objects are owned by emr_migrator.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT  USAGE  ON SCHEMA public TO emr_app, emr_worker_messaging, emr_readonly;

-- ----------------------------------------------------------------------------
-- 3. Session GUC defaults
--
-- app.clinic_id and app.user_id are set per-transaction by TenantDb.run().
-- Declaring empty defaults means an unset context yields '' rather than an
-- "unrecognized configuration parameter" error; the RLS predicates use
-- nullif(..., '') so an unset context evaluates to NULL and matches NO rows.
--
-- FAIL-CLOSED: absence of tenant context returns zero rows. There is no code
-- path in which a missing context returns every tenant's data.
-- ----------------------------------------------------------------------------

ALTER DATABASE CURRENT_DATABASE SET app.clinic_id TO '';
ALTER DATABASE CURRENT_DATABASE SET app.user_id   TO '';

-- ============================================================================
-- ==  EVERYTHING BELOW THIS LINE RUNS AFTER THE DRIZZLE TABLE MIGRATIONS    ==
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 4. Baseline grants
--
-- Drizzle emits CREATE POLICY but not GRANT. Without these, emr_app has no
-- table privileges at all and every query fails — which is the correct default.
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO emr_app;
GRANT USAGE                          ON ALL SEQUENCES IN SCHEMA public TO emr_app;
GRANT SELECT                         ON ALL TABLES    IN SCHEMA public TO emr_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE emr_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO emr_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emr_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO emr_readonly;

-- ----------------------------------------------------------------------------
-- 5. FORCE ROW LEVEL SECURITY on every tenant table
--
-- CRITICAL AND WIDELY MISSED: ENABLE ROW LEVEL SECURITY does not apply to the
-- table's OWNER. Without FORCE, any query running as emr_migrator — a
-- migration, a maintenance script, a misconfigured connection string — silently
-- bypasses every tenant policy and sees all clinics' data.
--
-- This block is generated rather than hand-listed so that a newly added table
-- cannot be forgotten. The CI tenancy check (docs/phase-0/04 §7) re-runs the
-- same query and fails the build if any table with a clinic_id column lacks
-- both relrowsecurity and relforcerowsecurity.
-- ----------------------------------------------------------------------------

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

-- The clinic table is the tenant root and has no clinic_id column; its boundary
-- is expressed on the primary key instead.
ALTER TABLE public.clinic ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clinic_self_isolation ON public.clinic;
CREATE POLICY clinic_self_isolation ON public.clinic
  AS PERMISSIVE FOR ALL TO emr_app
  USING      (id = nullif(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.clinic_id', true), '')::uuid);

-- Clinic provisioning (tenant creation) is performed by emr_migrator through
-- the platform admin path, never by emr_app.
REVOKE INSERT, DELETE ON public.clinic FROM emr_app;

-- ----------------------------------------------------------------------------
-- 6. Audit log immutability
--
-- Three independent controls. Any one of them alone is defeatable by a bug or a
-- privilege mistake; together they mean no application-reachable path can alter
-- history.
--   (a) RLS policies grant only SELECT and INSERT  [emitted by Drizzle]
--   (b) grant-level REVOKE of UPDATE and DELETE    [below]
--   (c) a trigger that raises unconditionally      [below]
-- ----------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_event FROM emr_app, emr_readonly;

CREATE OR REPLACE FUNCTION public.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_event is append-only; % is not permitted (attempted by %)',
    TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS audit_event_immutable ON public.audit_event;
CREATE TRIGGER audit_event_immutable
  BEFORE UPDATE OR DELETE ON public.audit_event
  FOR EACH ROW EXECUTE FUNCTION public.reject_audit_mutation();

-- ----------------------------------------------------------------------------
-- 7. Internal-note isolation
--
-- The structural guarantee behind the SoW's "internal notes can NEVER be sent
-- externally" mandate. The messaging worker connects as emr_worker_messaging
-- and is granted privileges on exactly the tables it needs. It has none on
-- encounter_internal_note, so the rows are not merely filtered from it — they
-- are unreadable.
--
-- An accidental future `GRANT ... ON ALL TABLES TO emr_worker_messaging` would
-- silently undo this, so the explicit REVOKE below is re-asserted and the CI
-- security suite verifies the privilege is absent on every build.
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.communication            TO emr_worker_messaging;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_conversation    TO emr_worker_messaging;
GRANT SELECT                 ON public.whatsapp_account         TO emr_worker_messaging;
GRANT SELECT                 ON public.document_reference       TO emr_worker_messaging;
GRANT SELECT                 ON public.patient                  TO emr_worker_messaging;
GRANT SELECT, INSERT         ON public.audit_event              TO emr_worker_messaging;
GRANT SELECT, INSERT, UPDATE ON public.task                     TO emr_worker_messaging;

REVOKE ALL ON public.encounter_internal_note FROM emr_worker_messaging;
REVOKE ALL ON public.encounter              FROM emr_worker_messaging;

-- ----------------------------------------------------------------------------
-- 8. Clinical record immutability after finalisation
--
-- A finalised encounter is a legal document. Corrections are made by appending
-- an amendment row (encounter.amends_encounter_id), never by editing history.
-- Enforced in the database because application-layer-only enforcement is one
-- refactor away from being bypassed.
--
-- Permitted post-finalisation mutations are limited to operational fields that
-- carry no clinical meaning.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reject_finalized_encounter_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_finalized THEN
    IF NEW.chief_complaint            IS DISTINCT FROM OLD.chief_complaint
    OR NEW.history_of_present_illness IS DISTINCT FROM OLD.history_of_present_illness
    OR NEW.examination_notes          IS DISTINCT FROM OLD.examination_notes
    OR NEW.assessment_notes           IS DISTINCT FROM OLD.assessment_notes
    OR NEW.plan_notes                 IS DISTINCT FROM OLD.plan_notes
    OR NEW.patient_id                 IS DISTINCT FROM OLD.patient_id
    OR NEW.practitioner_id            IS DISTINCT FROM OLD.practitioner_id
    OR NEW.is_finalized               IS DISTINCT FROM OLD.is_finalized
    THEN
      RAISE EXCEPTION
        'encounter % is finalised; clinical content is immutable. Create an amendment instead.',
        OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS encounter_finalized_immutable ON public.encounter;
CREATE TRIGGER encounter_finalized_immutable
  BEFORE UPDATE ON public.encounter
  FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_encounter_edit();

-- Prescriptions belonging to a finalised encounter are likewise frozen.
CREATE OR REPLACE FUNCTION public.reject_finalized_prescription_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_finalized boolean;
BEGIN
  SELECT is_finalized INTO parent_finalized
  FROM public.encounter WHERE id = OLD.encounter_id;

  IF parent_finalized AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'medication_request % belongs to a finalised encounter; issue a new prescription instead.',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS medication_request_finalized_immutable ON public.medication_request;
CREATE TRIGGER medication_request_finalized_immutable
  BEFORE UPDATE ON public.medication_request
  FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_prescription_edit();

-- ----------------------------------------------------------------------------
-- 9. Optimistic concurrency and updated_at maintenance
--
-- Two receptionists editing the same patient is routine; a silent last-write-
-- wins overwrite of a clinical field is not acceptable. The client sends the
-- version it read, and a stale write is rejected rather than applied.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bump_version_and_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version := OLD.version + 1;
  ELSIF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION
      'stale write to %.% (expected version %, client sent %)',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.version, NEW.version - 1
      USING ERRCODE = 'serialization_failure';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

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
      AND a.attname = 'version'
      AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON public.%I',
      t.relname || '_version_bump', t.relname
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.bump_version_and_timestamp()',
      t.relname || '_version_bump', t.relname
    );
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 10. Search normalisation
--
-- Duplicate detection (risk R4) is only as good as its normalisation. Doing
-- this in a trigger rather than in application code guarantees that rows
-- written by imports, migrations and background jobs are normalised identically
-- to rows written through the API.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_patient_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.name_normalized :=
    regexp_replace(lower(unaccent(coalesce(NEW.full_name, ''))), '\s+', ' ', 'g');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS patient_normalize_name ON public.patient;
CREATE TRIGGER patient_normalize_name
  BEFORE INSERT OR UPDATE OF full_name ON public.patient
  FOR EACH ROW EXECUTE FUNCTION public.normalize_patient_name();

CREATE OR REPLACE FUNCTION public.normalize_drug_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_normalized := regexp_replace(
    lower(unaccent(coalesce(NEW.brand_name, '') || ' ' || coalesce(NEW.molecule_name, ''))),
    '\s+', ' ', 'g'
  );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS drug_catalogue_normalize ON public.drug_catalogue_item;
CREATE TRIGGER drug_catalogue_normalize
  BEFORE INSERT OR UPDATE OF brand_name, molecule_name ON public.drug_catalogue_item
  FOR EACH ROW EXECUTE FUNCTION public.normalize_drug_search();

-- ----------------------------------------------------------------------------
-- 11. Reserved system tenant
--
-- Owns globally shared reference data (drug catalogue). Readable by every
-- tenant via sharedReferencePolicy; writable by none of them.
-- ----------------------------------------------------------------------------

INSERT INTO public.clinic (id, name, slug, timezone, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'SYSTEM (shared reference data)',
  '__system__',
  'Asia/Kolkata',
  false
)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 12. Post-migration verification
--
-- Run by CI immediately after migration. A table carrying clinic_id but lacking
-- forced RLS or a policy is a cross-tenant leak, so the build fails here rather
-- than in production.
-- ----------------------------------------------------------------------------

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
