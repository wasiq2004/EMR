-- ===========================================================================
-- Appointments remember what they were booked for
-- ===========================================================================
--
-- `BookAppointment` has always accepted a `serviceItemId`, and the booking path
-- has always used it — to look up the service's duration and work out the end
-- time — and then thrown it away, because `appointment` had no column to put it
-- in. The clinic chose a service, the slot length came from it, and nothing
-- afterwards could say which service the appointment was.
--
-- The cost showed up in the analytics: "how many consultations versus dressings
-- did we book last month" was a question the schema could not answer, so the
-- service filter there narrowed revenue only and the control had to say so.
--
-- EXISTING ROWS KEEP A NULL. They are genuinely uncategorised, and the
-- temptation — guessing the service from the invoice lines attached to the
-- encounter — would be inventing history to make a chart look complete. A
-- service-filtered count simply excludes them, and the screen says why.

-- ---------------------------------------------------------------------------
-- 1. Force RLS on everything carrying a clinic_id
-- ---------------------------------------------------------------------------
--
-- Nothing new here, but the loop is cheap and re-running it over already-forced
-- tables is a no-op. See `0007` for what FORCE does and does not buy.
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
-- 2. The analytics index
-- ---------------------------------------------------------------------------
--
-- "Appointments by service over a date range" is the query this column exists
-- for, and it scans a range of `scheduled_start` filtered by service. Partial on
-- the non-null rows, because every appointment booked before this migration has
-- a null and would otherwise bloat an index that can never match them.
CREATE INDEX IF NOT EXISTS appointment_clinic_service_idx
  ON public.appointment (clinic_id, service_item_id, scheduled_start)
  WHERE service_item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Retiring a service must not delete appointment history
-- ---------------------------------------------------------------------------
--
-- A clinic takes a service off its price list all the time. If that cascaded,
-- every appointment ever booked under it would vanish — which is both a data
-- loss and an audit problem, since those visits happened. `SET NULL` leaves the
-- appointment and drops only the categorisation.
DO $$
DECLARE
  action "char";
BEGIN
  SELECT c.confdeltype INTO action
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'appointment'
    AND c.conname = 'appointment_service_item_id_service_item_id_fk';

  IF action IS NULL THEN
    RAISE EXCEPTION 'appointment.service_item_id has no foreign key to service_item.';
  END IF;

  -- 'n' is SET NULL. 'c' would be CASCADE, which is the dangerous one.
  IF action <> 'n' THEN
    RAISE EXCEPTION
      'appointment.service_item_id must be ON DELETE SET NULL, not %. Retiring a '
      'service would otherwise delete every appointment ever booked under it.',
      action;
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
