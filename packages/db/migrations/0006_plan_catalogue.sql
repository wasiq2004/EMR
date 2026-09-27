-- ===========================================================================
-- The plan catalogue and deployment settings
-- ===========================================================================
--
-- Two tables that belong to the platform, not to any clinic, and so carry no
-- clinic_id and no row-level policy. The tenancy assertion in
-- `0001_roles_and_rls.sql` is keyed on the presence of a clinic_id column, so
-- they are exempt from it correctly rather than by omission.
--
-- WHAT THIS FILE IS ACTUALLY FOR. `0001` grants emr_app every privilege on
-- ALL TABLES IN SCHEMA public, which now includes these two. That is wrong in
-- two different ways and this file fixes both:
--
--   plan             — a clinic reads its own plan's feature flags, so SELECT
--                      has to stay. Write must not: a compromised clinic
--                      session that can UPDATE plan.features grants itself
--                      every feature on the deployment, and the FeatureGuard
--                      would be reading the attacker's own answer.
--
--   platform_setting — a clinic reads none of it. Pricing and onboarding
--                      policy are the vendor's, and one of the keys decides
--                      whether clinics may sign themselves up.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The console's role
-- ---------------------------------------------------------------------------
--
-- No DELETE on plan, deliberately. A plan is retired, never deleted — clinics
-- point at it, and the audit trail of what someone was charged has to still
-- resolve to a name a year later.
GRANT SELECT, INSERT, UPDATE         ON public.plan             TO emr_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_setting TO emr_platform;

-- ---------------------------------------------------------------------------
-- What a clinic may see
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.plan             FROM emr_app, emr_readonly, emr_worker_messaging;
REVOKE ALL ON public.platform_setting FROM emr_app, emr_readonly, emr_worker_messaging;

-- Read-only, and only the catalogue. FeatureGuard resolves a clinic's feature
-- set by joining subscription to plan on every cache miss, so without this the
-- guard fails closed and every gated feature is off for everyone.
GRANT SELECT ON public.plan TO emr_app, emr_readonly;

-- ---------------------------------------------------------------------------
-- The default catalogue
-- ---------------------------------------------------------------------------
--
-- Seeded here rather than in `seed.ts` because a deployment with no plans has a
-- console whose plan picker is empty, and the first clinic then gets onboarded
-- onto nothing. These are starting points and every field is editable from
-- Super Admin → Plans.
--
-- ON CONFLICT DO NOTHING: re-running must not overwrite pricing that an
-- operator has since changed.
--
-- Prices are in paise, so ₹2,999 is 299900. Annual is ten months — two free,
-- which is the usual shape and gives a reason to prepay.
--
-- A NULL limit is unlimited, which is a different thing from zero. `plan` and
-- `platform_setting` name features in camelCase to match the registry in
-- packages/contracts/src/features.ts; a key not in that registry is ignored
-- when the set is resolved, so a typo here disables rather than escalates.
INSERT INTO public.plan (
  code, name, description,
  monthly_price_paise, annual_price_paise,
  max_practitioners, max_patients, max_locations,
  included_messages_per_month, storage_gb,
  features, trial_days, display_order
) VALUES
  (
    'pilot',
    'Pilot',
    'One doctor, the full record. For a clinic moving off paper, with the parts that cost us money left off until they are wanted.',
    149900, 1499000,
    1, 2000, 1,
    0, 5,
    '{"whatsapp":false,"broadcasts":false,"teleconsultation":false,"documents":true,"billing":true,"reports":false,"dataPortability":true,"multiLocation":false}'::jsonb,
    14, 1
  ),
  (
    'clinic',
    'Clinic',
    'Up to three doctors with WhatsApp reminders and prescription delivery. The plan most clinics belong on.',
    299900, 2999000,
    3, NULL, 1,
    1000, 25,
    '{"whatsapp":true,"broadcasts":false,"teleconsultation":false,"documents":true,"billing":true,"reports":true,"dataPortability":true,"multiLocation":false}'::jsonb,
    14, 2
  ),
  (
    'clinic-plus',
    'Clinic Plus',
    'Everything, including broadcasts, teleconsultation and more than one location.',
    499900, 4999000,
    8, NULL, 5,
    5000, 100,
    '{"whatsapp":true,"broadcasts":true,"teleconsultation":true,"documents":true,"billing":true,"reports":true,"dataPortability":true,"multiLocation":true}'::jsonb,
    14, 3
  )
ON CONFLICT (code) DO NOTHING;

-- Clinics created before the catalogue existed carry a plan CODE and no
-- plan_id. Point them at the matching row so their features resolve, rather
-- than leaving them on the all-off default.
UPDATE public.subscription s
   SET plan_id = p.id
  FROM public.plan p
 WHERE s.plan_id IS NULL
   AND s.plan = p.code;

-- ---------------------------------------------------------------------------
-- The assertion, restated
-- ---------------------------------------------------------------------------
--
-- Same allow-list as `0005_platform_plane.sql`, re-run now that two tables have
-- been added to it. It is repeated rather than referenced because it is the
-- proof that the console cannot read clinical data, and a proof that only ran
-- once, before the last two grants, has not proved anything about them.
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

-- And the converse, extended: a clinic-facing role must hold nothing on the
-- platform's own tables, and no more than SELECT on the catalogue.
DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(DISTINCT grantee || ' on ' || table_name || ' (' || privilege_type || ')', ', ')
  INTO leaked
  FROM information_schema.table_privileges
  WHERE grantee IN ('emr_app', 'emr_readonly', 'emr_worker_messaging')
    AND table_schema = 'public'
    AND (
      table_name IN ('platform_user', 'platform_audit_event', 'platform_setting')
      OR (table_name = 'plan' AND privilege_type <> 'SELECT')
    );

  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      'A clinic-facing role has privileges it must not hold on the platform plane: %.',
      leaked;
  END IF;
END $$;
