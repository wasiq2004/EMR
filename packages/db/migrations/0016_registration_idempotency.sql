-- ===========================================================================
-- The front desk stops doing things twice
-- ===========================================================================
--
-- Three endpoints — `POST /appointments`, `POST /queue` and `POST /patients` —
-- each took an `Idempotency-Key` HEADER from the web client and each ignored it.
-- Nothing on the server read that header, and neither table had a column to put
-- a key in, so the protection existed only as an option name in
-- `api-client.ts`. The call sites looked careful and were not.
--
-- These are a busy reception desk, which is the worst place for an at-least-once
-- write: the first tap does not visibly do anything so the terminal gets tapped
-- again, or the request times out and the receptionist retries with a patient
-- standing in front of them.
--
-- WHAT WENT WRONG IS DIFFERENT IN EACH CASE, and worth separating because it
-- changes what the fix is for:
--
--   * A DUPLICATE APPOINTMENT double-books a doctor. Until somebody notices and
--     cancels one, the day looks fuller than it is, the second patient is turned
--     away from a slot that was never real, and the no-show figures count an
--     appointment nobody made.
--   * A DUPLICATE WALK-IN puts one person in the queue twice, which the front
--     desk sees immediately — but queue position is sparse and manually
--     reordered, so the stray row drifts and gets called.
--   * A DUPLICATE REGISTRATION was already prevented, by accident. The search
--     token is single-use, so the second submit was refused — with "search for
--     the patient before creating a new record", to somebody who had just done
--     that and still did not know whether the first attempt had worked. The key
--     turns that into the record itself.
--
-- LOWER STAKES THAN `payment` (0010) OR THE PHARMACY (0015), and the contracts
-- say so: there the key is REQUIRED, because money moved or stock moved and a
-- request without protection should be refused. Here it is OPTIONAL. A duplicate
-- appointment is a mess a person can cancel and a duplicate patient is a record
-- a person can merge, so an integration that does not send a key is served
-- rather than turned away — it is simply not protected from its own retries.

-- ---------------------------------------------------------------------------
-- 1. Force RLS on everything carrying a clinic_id
-- ---------------------------------------------------------------------------
--
-- Re-asserted on every migration. A table added without it is a table where one
-- clinic can read another's patients, and the standing check at the bottom of
-- this file is what makes that impossible to merge unnoticed.
--
-- FORCE matters because the tables are owned by `emr_migrator`, and a table
-- owner is exempt from its own policies unless forced. It buys nothing against
-- `emr_migrator` itself, which is a SUPERUSER and bypasses RLS regardless — the
-- boundary that actually holds is `emr_app`, which is NOBYPASSRLS and is what
-- the API connects as.
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
-- 2. The indexes are the guarantee
-- ---------------------------------------------------------------------------
--
-- Not the service lookup. A check-then-insert in application code loses the race
-- to two concurrent requests, which is precisely the double-tap being guarded
-- against — the lookup turns the loser's constraint violation into a sensible
-- answer, and the index is what makes one of them lose.
DO $$
DECLARE
  target text;
  idx oid;
BEGIN
  FOREACH target IN ARRAY ARRAY['appointment_idempotency_uq', 'patient_idempotency_uq']
  LOOP
    SELECT c.oid INTO idx
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = target;

    IF idx IS NULL THEN
      RAISE EXCEPTION
        '% is missing. A retried request would book or register the same person twice.',
        target;
    END IF;

    IF NOT (SELECT indisunique FROM pg_index WHERE indexrelid = idx) THEN
      RAISE EXCEPTION '% exists but is not UNIQUE, so it enforces nothing.', target;
    END IF;

    -- Partial on purpose. Every appointment booked and every patient registered
    -- before this column existed has a NULL key, and inventing one would be a
    -- claim about a request nobody recorded. A total index would instead reject
    -- all but one of them, which on `patient` means refusing to migrate a
    -- clinic that already has a register.
    IF (SELECT indpred FROM pg_index WHERE indexrelid = idx) IS NULL THEN
      RAISE EXCEPTION
        '% is not partial. Existing rows have a NULL key and a total index would '
        'reject all but one.',
        target;
    END IF;

    -- Leading with clinic_id, so two clinics generating the same key cannot
    -- block each other. A UUID collision is not the worry; a client that
    -- derives a key from something predictable is.
    IF (
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indexrelid = idx
    ) IS DISTINCT FROM 'clinic_id' THEN
      RAISE EXCEPTION
        '% must lead with clinic_id, or one clinic''s keys collide with another''s.',
        target;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. One index covers both writers of `appointment`
-- ---------------------------------------------------------------------------
--
-- `POST /appointments` and `POST /queue` both insert into this table, and they
-- share one key space deliberately: a key minted for a booking must not be
-- reusable to add a walk-in. Two separate indexes, or one scoped by `is_walk_in`,
-- would let the same key through twice.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'appointment_idempotency_uq'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%is_walk_in%'
  ) THEN
    RAISE EXCEPTION
      'appointment_idempotency_uq must not be scoped by is_walk_in — a booking and '
      'a walk-in share one key space, or the same key is accepted twice.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. The standing tenancy assertion
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
