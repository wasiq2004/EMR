-- ===========================================================================
-- The counter stops doing things twice
-- ===========================================================================
--
-- `POST /pharmacy/receipts` CREATES STOCK and `POST /pharmacy/sales` TAKES MONEY,
-- and until this migration a retried request did both twice. The web client sent
-- an `Idempotency-Key` header, which nothing on the server reads, and neither
-- table had a column to put a key in — so the protection existed only as a
-- reassuring option name in `api-client.ts`.
--
-- The two failures are different and both are bad:
--
--   * A DUPLICATE RECEIPT puts medicine on the shelf that is not there. The
--     shortfall surfaces at the next physical count, by which time nobody can
--     say which of two identical receipts was the phantom.
--   * A DUPLICATE SALE charges the customer twice and removes the stock twice.
--     Reconciling it afterwards means deciding which of two identical rows never
--     happened, which nobody can do from the rows alone.
--
-- A front desk or a medicine counter is the worst place for an at-least-once
-- write: the terminal gets tapped twice because the first tap did not visibly do
-- anything, or the request times out and the assistant retries with a patient
-- waiting. Same reasoning, same mechanism, as `payment.idempotency_key` in
-- migration `0010`.
--
-- NOT APPLIED TO `POST /pharmacy/lines/:id/fill`, deliberately. That one is a
-- SET rather than an ADD: `fillLine` calls `reverseExisting` first, returning
-- the line's previous quantity to stock, and only then issues the new amount.
-- Submitting it twice reverses and re-issues, and the net stock is right. It
-- costs two extra rows in the movement ledger, which is noise in an append-only
-- audit trail rather than wrong stock. A key there would be machinery for a
-- problem that does not exist.

-- ---------------------------------------------------------------------------
-- 1. Force RLS on everything carrying a clinic_id
-- ---------------------------------------------------------------------------
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
-- Not the service. A check-then-insert in application code loses the race to two
-- concurrent requests, which is precisely the double-tap being guarded against —
-- the lookup in the service turns a constraint violation into a sensible answer
-- for whichever request loses, and the index is what makes one of them lose.
DO $$
DECLARE
  target text;
  idx oid;
BEGIN
  FOREACH target IN ARRAY ARRAY['goods_receipt_idempotency_uq', 'pharmacy_sale_idempotency_uq']
  LOOP
    SELECT c.oid INTO idx
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = target;

    IF idx IS NULL THEN
      RAISE EXCEPTION
        '% is missing. A retried request would create stock or take money twice.',
        target;
    END IF;

    IF NOT (SELECT indisunique FROM pg_index WHERE indexrelid = idx) THEN
      RAISE EXCEPTION '% exists but is not UNIQUE, so it enforces nothing.', target;
    END IF;

    -- Partial on purpose: rows written before this column existed have a NULL
    -- key, and inventing one would be a lie about what happened. A total index
    -- would instead reject all but one of them.
    IF (SELECT indpred FROM pg_index WHERE indexrelid = idx) IS NULL THEN
      RAISE EXCEPTION
        '% is not partial. Rows predating the column have a NULL key and a total '
        'index would reject all but one.',
        target;
    END IF;

    -- Leading with clinic_id, so two clinics generating the same key cannot
    -- block each other.
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
-- 3. The standing tenancy assertion
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
