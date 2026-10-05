-- ===========================================================================
-- The plans forgot three modules that shipped
-- ===========================================================================
--
-- REPORTED SYMPTOM: signing in as a pharmacist showed "This part of the product
-- is not enabled for your clinic. Your administrator can ask us to add it."
--
-- The pharmacist was not misconfigured and the guard was not wrong. The plan was
-- stale. `FEATURES` in `packages/contracts/src/features.ts` carries eleven keys;
-- every plan row in the catalogue carried eight:
--
--     billing, reports, whatsapp, documents, broadcasts,
--     multiLocation, dataPortability, teleconsultation
--
-- Absent from all of them: PHARMACY, LAB and ANALYTICS — the three modules added
-- in the last three stages of work. `resolveFeatures` treats an absent key as
-- false, deliberately and correctly ("the failure is a clinic asking why a
-- button is missing, not a clinic using something it never bought"), so all
-- three were off for every clinic on a catalogue plan.
--
-- WHY IT LOOKED LIKE A PHARMACIST PROBLEM SPECIFICALLY. `landingRouteFor` sends
-- a pharmacist to `/pharmacy` and an analyst to `/analytics`, because neither has
-- a clinic dashboard to land on. So those two roles hit the gate on the first
-- screen after sign-in, which reads as "this account is broken" rather than "this
-- module is not enabled". A doctor or receptionist would only have noticed later,
-- on the lab tab.
--
-- WHY NO TEST CAUGHT IT. `scripts/verify/fixtures.mjs` writes a subscription with
-- a feature OVERRIDE turning all eleven on — correctly, so the clinical suites
-- test clinic behaviour rather than a price list. But that meant every suite ran
-- against a clinic configured by hand, and nothing ever asserted that a clinic on
-- a REAL catalogue plan could reach the pharmacy. The gap was between the plan
-- catalogue and the feature registry, and nothing was looking there.
-- `platform.sh` now asserts it.
--
-- WHAT THIS MIGRATION WILL AND WILL NOT DO
--
-- It fills keys that are ABSENT. It never overwrites a key that is already
-- present, in either direction — `'{...}'::jsonb || features` puts the existing
-- value on the right, and the right operand wins. An operator who deliberately
-- switched `pharmacy` off on a plan keeps that decision.
--
-- It grants the three modules on `clinic-plus` ONLY. That is the top tier, and a
-- top tier missing three shipped modules is unambiguously a mistake rather than a
-- pricing decision. For every other plan the keys are written as explicit FALSE:
-- no change in behaviour, but the console's plan editor renders from the registry,
-- so they stop being invisible and an operator can price them deliberately. This
-- migration does not invent a price for a module nobody has priced.
--
-- TO CHANGE IT AFTERWARDS, no migration is needed:
--   * per plan    — the console's Plans screen, which renders every registry key
--   * per clinic  — a feature override on the subscription, which beats the plan
--                   in both directions

-- ---------------------------------------------------------------------------
-- 1. Force RLS on everything carrying a clinic_id
-- ---------------------------------------------------------------------------
--
-- Re-asserted on every migration. `plan` is a PLATFORM table with no clinic_id,
-- so it is not in this set and is not meant to be — it is shared catalogue data
-- read by every tenant. The standing check at the bottom confirms nothing that
-- does carry a clinic_id lost its policy.
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
-- 2. The top tier gets the modules it should always have had
-- ---------------------------------------------------------------------------
--
-- `analytics` depends on `reports` — a commercial dependency, not a technical
-- one, enforced in `resolveFeatures`. `clinic-plus` already has `reports`, so
-- this grant is effective. Were it not, analytics would resolve to false and
-- this would be a silent no-op, which is why the assertion below checks the
-- resolved outcome rather than the stored flag.
UPDATE plan
SET features = '{"pharmacy": true, "lab": true, "analytics": true}'::jsonb || features
WHERE code = 'clinic-plus';

-- ---------------------------------------------------------------------------
-- 3. Every other plan: explicit, and therefore visible
-- ---------------------------------------------------------------------------
--
-- No behavioural change — absent already resolved to false. The point is that
-- an unset key is indistinguishable in the console from one somebody decided
-- against, and that ambiguity is what let this sit unnoticed through three
-- stages of work.
UPDATE plan
SET features = '{"pharmacy": false, "lab": false, "analytics": false}'::jsonb || features
WHERE code <> 'clinic-plus';

-- ---------------------------------------------------------------------------
-- 4. No plan may be missing a key the product knows about
-- ---------------------------------------------------------------------------
--
-- The eleven keys as of this migration. Hardcoded on purpose: a migration is a
-- statement about a moment, and this one asserts that at this moment no plan is
-- silently missing a module. A twelfth feature added later will NOT fail here —
-- that is what the `platform.sh` assertion is for, which reads the registry from
-- the running build and therefore moves with it.
DO $$
DECLARE
  required text[] := ARRAY[
    'whatsapp', 'broadcasts', 'teleconsultation', 'documents', 'billing',
    'reports', 'pharmacy', 'lab', 'analytics', 'dataPortability', 'multiLocation'
  ];
  bad text;
BEGIN
  SELECT string_agg(format('%s (missing: %s)', code, missing), '; ')
  INTO bad
  FROM (
    SELECT p.code,
           (SELECT string_agg(k, ', ')
            FROM unnest(required) AS k
            WHERE NOT (p.features ? k)) AS missing
    FROM plan p
  ) q
  WHERE missing IS NOT NULL;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'PLAN FEATURE GAP — these plans do not mention every known module, so it '
      'silently resolves to off for every clinic on them: %',
      bad;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. The reported symptom, asserted directly
-- ---------------------------------------------------------------------------
--
-- Narrow and specific: a clinic on the top tier must be able to reach the
-- pharmacy. This is the assertion that would have caught the bug.
DO $$
DECLARE
  broken text;
BEGIN
  SELECT string_agg(c.slug, ', ')
  INTO broken
  FROM clinic c
  JOIN subscription s ON s.clinic_id = c.id
  JOIN plan p ON p.id = s.plan_id
  WHERE p.code = 'clinic-plus'
    -- The override wins in both directions, so a deliberate per-clinic "off"
    -- is respected rather than reported as broken.
    AND coalesce(
          (s.feature_overrides ->> 'pharmacy')::boolean,
          (p.features ->> 'pharmacy')::boolean,
          false
        ) IS NOT TRUE;

  IF broken IS NOT NULL THEN
    RAISE EXCEPTION
      'A clinic on the top tier still cannot reach the pharmacy: %', broken;
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
