-- ===========================================================================
-- Payments: the guarantee the contract already promised
-- ===========================================================================
--
-- `RecordPayment` has required an `idempotencyKey` since it was written, and
-- carried the comment "a retried request must not take the payment twice". The
-- key was parsed, validated, and thrown away: the `payment` table had no column
-- to put it in. Submitting the same payment twice recorded it twice.
--
-- That is a money bug, and the worst kind of money bug, because both rows look
-- real. A front desk is the worst place for an at-least-once write — the
-- terminal gets tapped twice because the first tap did not visibly do anything,
-- or the request times out and the receptionist retries with the patient
-- standing there. Reconciling it afterwards means deciding which of two
-- identical ₹300 receipts was never actually collected, and nobody can.
--
-- The generated migration adds the column and the index. This file is the part
-- that matters: proving the index exists, is unique, and is partial, because
-- the whole guarantee IS the index. A service-level check-then-insert loses the
-- race to two concurrent requests, which is exactly the double-tap being
-- guarded against.

-- ---------------------------------------------------------------------------
-- 1. The index is the guarantee
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  idx oid;
BEGIN
  SELECT c.oid INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'payment_idempotency_uq';

  IF idx IS NULL THEN
    RAISE EXCEPTION
      'payment_idempotency_uq is missing. Without it a retried payment is taken twice.';
  END IF;

  IF NOT (SELECT indisunique FROM pg_index WHERE indexrelid = idx) THEN
    RAISE EXCEPTION
      'payment_idempotency_uq exists but is not UNIQUE, so it enforces nothing.';
  END IF;

  -- Partial on purpose. Payments written before the column existed have no key,
  -- and inventing one would be a lie about what happened; a total index would
  -- instead collapse every one of them into a single allowed row.
  IF (SELECT indpred FROM pg_index WHERE indexrelid = idx) IS NULL THEN
    RAISE EXCEPTION
      'payment_idempotency_uq is not partial. Rows predating the column have a '
      'NULL key and a total index would reject all but one of them.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Scoped to the clinic, not global
-- ---------------------------------------------------------------------------
--
-- Two clinics that happen to generate the same key must not block each other.
-- The leading column is clinic_id for that reason, and it is asserted rather
-- than assumed because a later hand-edit that drops it would still be unique,
-- still pass the check above, and quietly make one clinic's keys another's
-- problem.
DO $$
BEGIN
  IF (
    SELECT a.attname
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE c.relname = 'payment_idempotency_uq'
  ) IS DISTINCT FROM 'clinic_id' THEN
    RAISE EXCEPTION
      'payment_idempotency_uq must lead with clinic_id, or one clinic''s keys '
      'collide with another''s.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Payments stay inside the tenant boundary
-- ---------------------------------------------------------------------------
--
-- Re-asserted because this migration touched the table. A new column is a new
-- chance for someone to have created a second payment-shaped table beside it.
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
