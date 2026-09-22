-- ============================================================================
-- 0000 — Extensions and roles
--
-- Runs BEFORE the generated table DDL, because the tables reference these
-- roles in their policies and use these extensions in their indexes.
-- ============================================================================

-- Fuzzy patient and drug search. Required by the GIN trigram indexes on
-- patient.name_normalized and drug_catalogue_item.search_normalized.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accent folding, so "Sūrya" and "Surya" collide during duplicate detection.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- gen_random_uuid() for primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- btree_gin lets a trigram index lead with clinic_id. Every index must, because
-- the RLS predicate filters on clinic_id on every query: an index that does not
-- lead with it cannot serve the filter, and the planner falls back to a scan
-- that RLS then discards. The symptom only appears once a second tenant exists.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- ----------------------------------------------------------------------------
-- Roles
--
-- THE CENTRAL CONTROL: the application never connects as an owner.
--
--   emr_migrator          owns every object and runs DDL. CI migrations only.
--   emr_app               the API. NOBYPASSRLS, no DDL.
--   emr_worker_messaging  message dispatch. NO privilege whatsoever on
--                         encounter_internal_note, which is what makes an
--                         internal note structurally undispatchable.
--   emr_readonly          analytics and the read replica. SELECT, still
--                         tenant-bound.
--
-- Because emr_app cannot execute DDL, application code is incapable of running
-- ALTER TABLE ... DISABLE ROW LEVEL SECURITY.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    CREATE ROLE emr_app LOGIN PASSWORD 'emr_app' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_worker_messaging') THEN
    CREATE ROLE emr_worker_messaging LOGIN PASSWORD 'emr_worker' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_readonly') THEN
    CREATE ROLE emr_readonly LOGIN PASSWORD 'emr_readonly' NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE emr_app              NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE emr_worker_messaging NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE emr_readonly         NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT  USAGE  ON SCHEMA public TO emr_app, emr_worker_messaging, emr_readonly;

-- ----------------------------------------------------------------------------
-- Session settings
--
-- app.clinic_id is set per transaction by TenantDb.run(). Declaring empty
-- defaults means an unset context yields '' rather than an "unrecognized
-- configuration parameter" error, and the policies use nullif(..., '') so an
-- unset context evaluates to NULL and matches NO rows.
--
-- FAIL-CLOSED: absence of tenant context returns zero rows. There is no code
-- path in which a missing context returns every tenant's data.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET app.clinic_id TO %L', current_database(), '');
  EXECUTE format('ALTER DATABASE %I SET app.user_id   TO %L', current_database(), '');
END
$$;
