-- ===========================================================================
-- Remove a duplicate — and weaker — prescription immutability guard
-- ===========================================================================
--
-- `0007_pharmacy_and_research.sql` added `medication_request_finalised_immutable`
-- to stop the pharmacy module editing a signed prescription. That rule was
-- already enforced, better, by `medication_request_finalized_immutable` from
-- `0001_roles_and_rls.sql`, and having both is worse than having one.
--
-- WHY THE OLDER ONE WINS.
--
--   Scope.   The 0001 guard freezes EVERY column except `status` and the audit
--            columns, by comparing `to_jsonb(NEW)` against `to_jsonb(OLD)`. The
--            0007 guard froze a HAND-LISTED set of ten clinical columns — so a
--            column added next year would be protected by the first and not by
--            the second, and nobody would notice until it mattered.
--
--   Message. Triggers fire in name order, and `finalised` sorts before
--            `finalized`. The weaker guard was therefore raising first and its
--            message was the one a user saw, hiding the clearer one behind it.
--
--   Truth.   Two triggers expressing one rule is two places to edit and one
--            place to forget. The pharmacy module is protected exactly as much
--            by the 0001 guard as it was by both.
--
-- The trigger condition differs cosmetically — 0001 reads `encounter.is_finalized`
-- and 0007 read `encounter.status = 'FINISHED'` — but finalisation sets both in
-- the same statement, so they select the same rows. `is_finalized` is the more
-- direct flag and is the one kept.
--
-- NOTHING IS WEAKENED BY THIS FILE. The assertion at the end proves the
-- surviving guard is still attached before the migration is allowed to commit.

DROP TRIGGER IF EXISTS medication_request_finalised_immutable ON public.medication_request;
DROP FUNCTION IF EXISTS medication_request_finalised_is_immutable();

-- ---------------------------------------------------------------------------
-- The assertion
-- ---------------------------------------------------------------------------
--
-- Dropping a guard is exactly the change that should have to prove it left the
-- protection in place. If the 0001 trigger is ever renamed or removed, this
-- fails the deployment rather than quietly leaving signed prescriptions
-- editable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.medication_request'::regclass
      AND tgname = 'medication_request_finalized_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'The prescription immutability guard is missing. A signed prescription must not be editable.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.medication_request'::regclass
      AND tgname = 'medication_request_finalised_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'The duplicate guard was not removed.';
  END IF;
END $$;
