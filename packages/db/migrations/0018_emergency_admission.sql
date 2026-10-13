-- ===========================================================================
-- Somebody carried in
-- ===========================================================================
--
-- An emergency is a FLAG ON THE ORDINARY VISIT, not a new kind of record. Same
-- consultation, same prescription, same bill — entering the queue at the front.
--
-- The alternative, a separate emergency record type, was rejected: it forks
-- every screen that lists a visit, and the emergency version of each then drifts
-- away from the one people actually maintain. A clinic would end up with two
-- queues, two patient headers and two billing paths, and the one used in a
-- crisis would be the less tested of the pair.
--
-- WHAT THE COLUMNS ARE FOR
--
--   is_emergency                 The flag. Stays set after the visit, because
--                                "how many emergencies last month" is a question
--                                asked of old data, and a flag that clears when
--                                the patient is seen cannot answer it.
--
--   attendant_name               Who brought them in, and on what number. ON THE
--   attendant_phone_e164         VISIT, deliberately — `patient.emergency_contact_*`
--                                is the standing next-of-kin, a fact about the
--                                person that holds across years. This is the
--                                neighbour who drove them here this afternoon,
--                                and it is somebody different next time. Storing
--                                it on the patient would overwrite a real
--                                next-of-kin with whoever happened to be passing.
--
--   registration_bypass_reason   Why the duplicate search was skipped.
--                                Registering normally REFUSES without proof that
--                                a search ran first, because duplicate
--                                registration is the likeliest failure at a busy
--                                desk. That rule is wrong when somebody is being
--                                carried in — the question is whether they are
--                                seen in the next two minutes — so the emergency
--                                path bypasses it and records that it did.
--
--                                A bypass that leaves no trace is
--                                indistinguishable from the check never having
--                                existed. The duplicates this creates are a
--                                known, visible cost, resolved afterwards by
--                                merging, which is the right direction for the
--                                error to run in.

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
-- 2. The columns exist and mean what the application thinks
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(c)
  INTO missing
  FROM unnest(ARRAY[
    'is_emergency', 'attendant_name', 'attendant_phone_e164', 'registration_bypass_reason'
  ]) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointment' AND column_name = c
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'appointment is missing %', array_to_string(missing, ', ');
  END IF;
END
$$;

DO $$
BEGIN
  /*
   * NOT NULL with a default of false.
   *
   * A nullable flag has three states and the third one is "nobody knows", which
   * for "was this an emergency" is not an answer anybody can act on. Every
   * appointment booked before this migration was not an emergency, and false
   * says so truthfully.
   */
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointment'
      AND column_name = 'is_emergency' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'appointment.is_emergency is nullable. A three-state flag cannot answer '
      '"was this an emergency", and every row predating this migration was not one.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. The queue index, which is the one that is read constantly
-- ---------------------------------------------------------------------------
--
-- Every open screen in the clinic polls the live queue, and it is displayed
-- emergencies-first. Without this the sort is over the table on every poll.
DO $$
DECLARE
  idx oid;
BEGIN
  SELECT c.oid INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'appointment_queue_order_idx';

  IF idx IS NULL THEN
    RAISE EXCEPTION
      'appointment_queue_order_idx is missing. The live queue sorts emergencies '
      'first on every poll from every open screen in the clinic.';
  END IF;

  -- Leading with clinic_id, like every other index here: a scan that starts on
  -- a shared column reads rows belonging to other clinics before discarding them.
  IF (
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indexrelid = idx
  ) IS DISTINCT FROM 'clinic_id' THEN
    RAISE EXCEPTION 'appointment_queue_order_idx must lead with clinic_id.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. An emergency is still an ordinary appointment
-- ---------------------------------------------------------------------------
--
-- The guarantee this migration is really making. If somebody later gives
-- emergencies their own table, this fails — which is the point: the whole design
-- rests on there being ONE kind of visit, so that one consultation screen, one
-- prescription path and one bill serve both.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('emergency_visit', 'emergency_appointment')
  ) THEN
    RAISE EXCEPTION
      'A separate emergency visit table exists. An emergency is a flag on the '
      'ordinary appointment — a second table forks every screen that lists a visit.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. The standing tenancy assertion
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
