-- ===========================================================================
-- Consultation mode
-- ===========================================================================
--
-- Records whether the patient was in the room.
--
-- WHY THIS EXISTS. India's Telemedicine Practice Guidelines put Schedule X drugs
-- and narcotics on a prohibited list for teleconsultation. It is a legal
-- restriction, not a clinical judgement, so unlike an allergy warning it has no
-- override — there is no reason a doctor can write down that makes it lawful.
--
-- The prescribing safety check could not evaluate that rule at all, because the
-- encounter carried nothing to say which kind of consultation it was. Under this
-- system's own rule — a check that cannot run shows nothing, ever — the
-- restriction was therefore invisible in the interface, and a doctor on a video
-- call could prescribe alprazolam with no warning of any kind.
--
-- A teleconsultation prescription also has to carry a declaration that an
-- in-person one does not, which has the same prerequisite.
--
-- DEFAULT IN_PERSON, and the default is the point. Every consultation recorded
-- before this migration was almost certainly in person, that remains the
-- overwhelming majority in this segment, and it is the mode with FEWER
-- prohibitions — so a row that is wrong in this direction under-restricts
-- nothing. Defaulting the other way would mark every historical visit as remote
-- and put a false legal declaration on every reprinted prescription.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consultation_mode') THEN
    CREATE TYPE consultation_mode AS ENUM ('IN_PERSON', 'TELECONSULTATION');
  END IF;
END $$;

ALTER TABLE encounter
  ADD COLUMN IF NOT EXISTS consultation_mode consultation_mode
  NOT NULL DEFAULT 'IN_PERSON';

COMMENT ON COLUMN encounter.consultation_mode IS
  'IN_PERSON or TELECONSULTATION. Gates the Schedule X prohibition and the '
  'teleconsultation declaration on the printed prescription.';

-- Reporting asks "how many teleconsultations last month", and the answer is a
-- small slice of a large table. Partial, because the IN_PERSON majority is
-- better served by a sequential scan than by an index entry per row.
CREATE INDEX IF NOT EXISTS encounter_teleconsultation_idx
  ON encounter (clinic_id, started_at)
  WHERE consultation_mode = 'TELECONSULTATION';
