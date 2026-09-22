-- ===========================================================================
-- Pre-tenant resolvers
-- ===========================================================================
--
-- THE PROBLEM. Three operations have to find a row before any tenant context
-- exists, because the thing they are looking up is what establishes the tenant:
--
--   1. sign-in            — an email address, before we know which clinic
--   2. refresh            — a refresh token, presented by a browser with no
--                           usable access token left
--   3. share-link redeem  — a token held by an anonymous recipient, typically a
--                           patient's relative with no account at all
--
-- Every one of these runs as `emr_app`, which is NOBYPASSRLS. Under forced RLS
-- with a predicate that fails closed, all three read zero rows. The failure is
-- silent and total: sign-in simply reports that the password is wrong.
--
-- THE WRONG FIXES, and why.
--
--   Run them as the migrator. That role owns the schema and can run DDL, so a
--   flaw anywhere in the sign-in path would be a flaw with DDL rights.
--
--   Add an RLS policy permitting these reads. A policy broad enough to let
--   sign-in find any user by email is broad enough to let an authenticated
--   caller enumerate every user in every clinic.
--
--   Give `emr_app` BYPASSRLS. That deletes the property the entire design rests
--   on, to fix three queries.
--
-- WHAT THIS DOES INSTEAD. A role that cannot log in owns three functions that
-- can each answer exactly one question, and each answer is a pair of
-- identifiers — never a password hash, never a patient, never a row. The role
-- holds BYPASSRLS because it has to, and holds it behind NOLOGIN and a SELECT
-- grant on four tables, so the only way to reach it at all is by calling one of
-- these three functions. Every crossing of a tenant boundary in this system is
-- therefore one of the three bodies below, in full, on one screen.
--
-- Having resolved the identifiers, the caller re-enters through the ordinary
-- scoped path and reads the row under RLS like everything else.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_auth_resolver') THEN
    CREATE ROLE emr_auth_resolver NOLOGIN;
  END IF;
END $$;

-- BYPASSRLS is the point of the role. NOLOGIN is what makes it safe: there is
-- no connection string that reaches these privileges.
ALTER ROLE emr_auth_resolver BYPASSRLS NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO emr_auth_resolver;
GRANT SELECT ON public.app_user        TO emr_auth_resolver;
GRANT SELECT ON public.clinic          TO emr_auth_resolver;
GRANT SELECT ON public.refresh_session TO emr_auth_resolver;
GRANT SELECT ON public.share_link      TO emr_auth_resolver;

-- ---------------------------------------------------------------------------
-- 1. Sign-in
-- ---------------------------------------------------------------------------
--
-- Returns up to TWO rows on purpose. Email is unique per clinic, not globally —
-- a doctor practising at two clinics has two accounts, deliberately. Where no
-- subdomain identifies the clinic, the caller must be able to tell "one match"
-- from "more than one" so it can refuse rather than guess which clinic someone
-- meant to sign in to.
CREATE OR REPLACE FUNCTION public.auth_resolve_account(p_email text, p_slug text)
RETURNS TABLE (user_id uuid, clinic_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.clinic_id
  FROM public.app_user u
  JOIN public.clinic c ON c.id = u.clinic_id
  WHERE lower(u.email) = lower(btrim(p_email))
    AND (p_slug IS NULL OR c.slug = p_slug)
  ORDER BY u.created_at
  LIMIT 2;
$$;

-- ---------------------------------------------------------------------------
-- 2. Refresh
-- ---------------------------------------------------------------------------
--
-- Matches on the stored SHA-256 of the token, never the token itself. Revoked
-- sessions are excluded here rather than by the caller, so a consumed token
-- cannot be resolved into a tenant at all.
CREATE OR REPLACE FUNCTION public.auth_resolve_refresh_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, clinic_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.user_id, s.clinic_id
  FROM public.refresh_session s
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 3. Share-link redemption
-- ---------------------------------------------------------------------------
--
-- Deliberately does NOT filter on expiry, revocation or the access cap. The
-- caller checks those inside the tenant transaction so that a refused attempt
-- is still audited against the right clinic — a revoked link being tried is
-- exactly the event someone needs to see.
CREATE OR REPLACE FUNCTION public.share_link_resolve(p_token_hash text)
RETURNS TABLE (link_id uuid, clinic_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT l.id, l.clinic_id
  FROM public.share_link l
  WHERE l.token_hash = p_token_hash
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER runs as the OWNER, so the owner must be the resolver role
-- and not the migrator that is executing this file.
ALTER FUNCTION public.auth_resolve_account(text, text)        OWNER TO emr_auth_resolver;
ALTER FUNCTION public.auth_resolve_refresh_session(text)      OWNER TO emr_auth_resolver;
ALTER FUNCTION public.share_link_resolve(text)                OWNER TO emr_auth_resolver;

REVOKE ALL ON FUNCTION public.auth_resolve_account(text, text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_resolve_refresh_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.share_link_resolve(text)           FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.auth_resolve_account(text, text)   TO emr_app;
GRANT EXECUTE ON FUNCTION public.auth_resolve_refresh_session(text) TO emr_app;
GRANT EXECUTE ON FUNCTION public.share_link_resolve(text)           TO emr_app;

-- The messaging worker signs nobody in and redeems nothing. Withholding these
-- keeps its blast radius where the rest of the design already puts it.
REVOKE EXECUTE ON FUNCTION public.auth_resolve_account(text, text)   FROM emr_worker_messaging;
REVOKE EXECUTE ON FUNCTION public.auth_resolve_refresh_session(text) FROM emr_worker_messaging;
REVOKE EXECUTE ON FUNCTION public.share_link_resolve(text)           FROM emr_worker_messaging;

-- ---------------------------------------------------------------------------
-- Assertion
-- ---------------------------------------------------------------------------
--
-- If someone later adds a fourth SECURITY DEFINER function, this migration is
-- the place the reviewer expects to find it. Failing here is how they find out
-- it was added somewhere else.
DO $$
DECLARE
  unexpected text;
BEGIN
  SELECT string_agg(p.proname, ', ')
  INTO unexpected
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND p.proname NOT IN (
      'auth_resolve_account',
      'auth_resolve_refresh_session',
      'share_link_resolve'
    );

  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      'Unreviewed SECURITY DEFINER function(s): %. Every tenant-boundary crossing belongs in 0002_pre_tenant_resolvers.sql.',
      unexpected;
  END IF;
END $$;
