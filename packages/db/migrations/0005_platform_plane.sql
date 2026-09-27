-- ===========================================================================
-- The platform plane
-- ===========================================================================
--
-- A super admin operates ACROSS clinics. Every other part of this system is
-- built to make that impossible, so this file has to say exactly how the
-- exception works and exactly how far it reaches.
--
-- THE RULE. A platform operator sees no patient data. Not redacted, not
-- access-logged, not behind a confirmation — absent. That is a product decision
-- and it is also the only defensible version: a clinic hands over its patients'
-- records on the understanding that the vendor is not a party to them.
--
-- HOW IT IS ENFORCED. Not by a policy predicate. `emr_platform` is granted
-- privileges on four platform tables and on `clinic`, and on nothing else. It
-- cannot read `patient` because it has no SELECT on `patient` — the same shape
-- as the messaging worker's inability to read internal notes.
--
-- WHY IT STILL HAS BYPASSRLS. It has to aggregate across tenants on the tables
-- it IS allowed to read, and those carry clinic_id under forced RLS. BYPASSRLS
-- without a grant is useless: it removes the row filter on tables the role
-- cannot open in the first place. The GRANT LIST is the boundary, and the
-- assertion at the end of this file proves it holds.
--
-- WHAT A PLATFORM OPERATOR ACTUALLY SEES about activity inside a clinic is
-- `clinic_usage_daily` — integers and a date, written by a job that runs inside
-- each tenant's own context. The panel reads counts. It never reads rows.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_platform') THEN
    CREATE ROLE emr_platform LOGIN PASSWORD 'emr_platform';
  END IF;
END $$;

ALTER ROLE emr_platform BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Start from nothing. Re-running this file must not silently accumulate
-- privileges granted by an earlier version of it.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM emr_platform;
GRANT USAGE ON SCHEMA public TO emr_platform;

-- ---------------------------------------------------------------------------
-- The whole grant list. This is the security boundary; read it as one thing.
-- ---------------------------------------------------------------------------

-- The tenant root. Name, slug, contact details, suspension state — the record
-- of a customer, carrying no patient data.
GRANT SELECT, UPDATE ON public.clinic TO emr_platform;

-- Commercial state and aggregate usage.
GRANT SELECT, INSERT, UPDATE ON public.subscription         TO emr_platform;
GRANT SELECT                 ON public.clinic_usage_daily   TO emr_platform;

-- Its own users and its own audit trail.
GRANT SELECT, INSERT, UPDATE ON public.platform_user        TO emr_platform;
GRANT SELECT, INSERT         ON public.platform_audit_event TO emr_platform;

-- Deliberately NOT granted, and each for its own reason:
--
--   app_user   — a platform operator does not read clinic staff accounts. It
--                can suspend a CLINIC; it cannot enumerate the people in it.
--   audit_event — a clinic's own record of what its staff did. The vendor's
--                actions are recorded separately, in platform_audit_event, in a
--                log the clinic cannot write to.
--   everything clinical — patient, encounter, observation, condition,
--                allergy_intolerance, medication_request, document_reference,
--                communication, invoice, task, consent, and the rest.

-- ---------------------------------------------------------------------------
-- The application role must not read the platform plane either
-- ---------------------------------------------------------------------------
--
-- platform_user holds password hashes for accounts that can suspend every
-- clinic on the deployment. A compromised clinic session must not be able to
-- read them, and RLS does not help here because these tables have no clinic_id
-- to filter on — so the privilege is simply withheld.
REVOKE ALL ON public.platform_user        FROM emr_app, emr_readonly, emr_worker_messaging;
REVOKE ALL ON public.platform_audit_event FROM emr_app, emr_readonly, emr_worker_messaging;

-- The clinic DOES read its own subscription and usage, under the tenant policy
-- already on those tables.
GRANT SELECT ON public.subscription       TO emr_app, emr_readonly;
GRANT SELECT ON public.clinic_usage_daily TO emr_app, emr_readonly;

-- The aggregation job writes usage rows while inside a tenant context.
GRANT INSERT, UPDATE ON public.clinic_usage_daily TO emr_app;

-- ---------------------------------------------------------------------------
-- Platform audit is append-only
-- ---------------------------------------------------------------------------
--
-- The record of what the vendor did to a clinic is exactly what that clinic
-- may later dispute. An operator who can edit it can rewrite the history of
-- their own mistake.
REVOKE UPDATE, DELETE ON public.platform_audit_event FROM PUBLIC;
REVOKE UPDATE, DELETE ON public.platform_audit_event FROM emr_platform;

CREATE OR REPLACE FUNCTION platform_audit_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_event is append-only: % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS platform_audit_no_change ON public.platform_audit_event;
CREATE TRIGGER platform_audit_no_change
  BEFORE UPDATE OR DELETE ON public.platform_audit_event
  FOR EACH ROW EXECUTE FUNCTION platform_audit_is_append_only();

-- ---------------------------------------------------------------------------
-- The assertion
-- ---------------------------------------------------------------------------
--
-- The comments above are a claim. This is the proof, and it runs on every
-- migration: if anyone ever grants emr_platform a privilege on a table holding
-- patient data, the deployment fails here rather than shipping a console that
-- can read medical records.
--
-- Written as an allow-list. A new clinical table added next year is covered
-- automatically, because it will not be on this list.
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
      -- Added by 0006, which grants them and restates this whole assertion.
      -- Listed here too so this file stays readable as the boundary in one
      -- place; it runs before those grants exist, so it is a no-op here.
      'plan',
      'platform_setting'
    );

  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      'emr_platform has privileges on non-platform table(s): %. A platform operator must not be able to read clinic data.',
      leaked;
  END IF;
END $$;

-- And the converse: the application must not be able to read the platform's
-- own users or audit trail.
DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(DISTINCT grantee || ' on ' || table_name, ', ')
  INTO leaked
  FROM information_schema.table_privileges
  WHERE grantee IN ('emr_app', 'emr_readonly', 'emr_worker_messaging')
    AND table_schema = 'public'
    AND table_name IN ('platform_user', 'platform_audit_event');

  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      'A clinic-facing role has privileges on the platform plane: %.',
      leaked;
  END IF;
END $$;
