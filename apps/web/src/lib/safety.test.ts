import { describe, expect, it } from 'vitest';
import type { Allergy } from '@emr/contracts';
import {
  checkPrescription,
  isHardBlocked,
  requiresAcknowledgement,
  requiresOverrideReason,
} from './safety';

/**
 * Tests for the prescribing safety checks.
 *
 * These are not ordinary unit tests. Four of the pilot's acceptance criteria
 * are patient-safety criteria, and two of them are decided entirely by this
 * module:
 *
 *   - the allergy warning must fire when a penicillin-allergic patient is
 *     prescribed a penicillin, even under a different name
 *   - overriding it must require a deliberate act, not a single click
 *
 * A failure here is a stop-and-redesign decision, not a backlog item, so the
 * trap from the acceptance script is encoded directly below: Lakshmi
 * Narayanan is HIGH-criticality penicillin-allergic, and the natural
 * prescription for her sore throat is Amoxicillin.
 */

const penicillinAllergy: Allergy = {
  id: 'a1',
  patientId: 'p1',
  category: 'MEDICATION',
  criticality: 'HIGH',
  substanceMoleculeId: null,
  substanceText: 'Penicillin',
  reactionDescription: 'Widespread urticarial rash and facial swelling within 2 hours',
  reactionSeverity: 'SEVERE',
  onsetDate: null,
  refutedAt: null,
  recordedAt: '2020-01-01T00:00:00Z',
  recordedBy: 'u1',
};

const sulfaAllergy: Allergy = {
  ...penicillinAllergy,
  id: 'a2',
  substanceText: 'Sulfonamides',
  criticality: 'LOW',
  reactionSeverity: 'MILD',
};

describe('the acceptance trap: a penicillin for a penicillin-allergic patient', () => {
  const warnings = checkPrescription(
    { drugDisplayName: 'Mox 500', moleculeName: 'Amoxicillin' },
    { allergies: [penicillinAllergy], existingLines: [] },
  );

  it('fires, even though the drug is not called "penicillin"', () => {
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.kind).toBe('ALLERGY_CLASS');
  });

  it('blocks rather than warning quietly', () => {
    expect(warnings[0]?.severity).toBe('BLOCKING');
    expect(requiresAcknowledgement(warnings)).toBe(true);
  });

  it('demands a typed reason before it can be overridden', () => {
    expect(requiresOverrideReason(warnings)).toBe(true);
  });

  it('still lets the clinician decide — the system never refuses on its own', () => {
    expect(isHardBlocked(warnings)).toBe(false);
  });

  it('tells the doctor the substance, the risk and when it was recorded', () => {
    const warning = warnings[0]!;
    expect(warning.substanceText).toBe('Penicillin');
    expect(warning.criticality).toBe('HIGH');
    expect(warning.recordedAt).toBe('2020-01-01T00:00:00Z');
    expect(warning.detail).toContain('Penicillin');
  });
});

describe('exact substance match', () => {
  it('fires when the prescribed molecule is the recorded substance', () => {
    const warnings = checkPrescription(
      { drugDisplayName: 'Crystapen', moleculeName: 'Benzylpenicillin' },
      { allergies: [penicillinAllergy], existingLines: [] },
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(requiresAcknowledgement(warnings)).toBe(true);
  });
});

describe('false positives', () => {
  it('does not fire on a safe alternative', () => {
    // If this ever starts warning, doctors learn to click through warnings —
    // which is how the real one gets missed.
    const warnings = checkPrescription(
      { drugDisplayName: 'Azithral 500', moleculeName: 'Azithromycin' },
      { allergies: [penicillinAllergy], existingLines: [] },
    );
    expect(warnings).toHaveLength(0);
  });

  it('does not fire when nothing is recorded', () => {
    const warnings = checkPrescription(
      { drugDisplayName: 'Mox 500', moleculeName: 'Amoxicillin' },
      { allergies: [], existingLines: [] },
    );
    expect(warnings).toHaveLength(0);
  });

  it('ignores an allergy that was later disproved', () => {
    const warnings = checkPrescription(
      { drugDisplayName: 'Mox 500', moleculeName: 'Amoxicillin' },
      {
        allergies: [{ ...penicillinAllergy, refutedAt: '2024-01-01T00:00:00Z' }],
        existingLines: [],
      },
    );
    expect(warnings).toHaveLength(0);
  });
});

describe('criticality changes how loudly it warns', () => {
  it('a LOW-criticality class match is advisory, not blocking', () => {
    const warnings = checkPrescription(
      { drugDisplayName: 'Septran DS', moleculeName: 'Co-trimoxazole' },
      { allergies: [sulfaAllergy], existingLines: [] },
    );
    expect(warnings[0]?.kind).toBe('ALLERGY_CLASS');
    expect(warnings[0]?.severity).toBe('ADVISORY');
  });
});

describe('duplicate therapy', () => {
  it('flags the same molecule twice on one prescription', () => {
    const warnings = checkPrescription(
      { drugDisplayName: 'Dolo 650', moleculeName: 'Paracetamol' },
      {
        allergies: [],
        existingLines: [
          { drugDisplayName: 'Crocin 650', moleculeName: 'Paracetamol' } as never,
        ],
      },
    );
    expect(warnings.some((w) => w.kind === 'DUPLICATE_THERAPY')).toBe(true);
  });

  it('is advisory — two brands of the same molecule is sometimes deliberate', () => {
    const warnings = checkPrescription(
      { drugDisplayName: 'Dolo 650', moleculeName: 'Paracetamol' },
      {
        allergies: [],
        existingLines: [
          { drugDisplayName: 'Crocin 650', moleculeName: 'Paracetamol' } as never,
        ],
      },
    );
    expect(warnings[0]?.severity).toBe('ADVISORY');
  });
});

describe('Schedule X in a remote consultation', () => {
  const warnings = checkPrescription(
    { drugDisplayName: 'Alprax 0.25', moleculeName: 'Alprazolam', drugSchedule: 'X' },
    { allergies: [], existingLines: [], isTeleconsultation: true },
  );

  it('blocks the prescription', () => {
    expect(warnings.some((w) => w.kind === 'SCHEDULE_X_TELEMEDICINE')).toBe(true);
  });

  it('offers no override, because it is a legal restriction not a clinical one', () => {
    expect(isHardBlocked(warnings)).toBe(true);
  });

  it('does not block the same drug when the patient is seen in person', () => {
    const inPerson = checkPrescription(
      { drugDisplayName: 'Alprax 0.25', moleculeName: 'Alprazolam', drugSchedule: 'X' },
      { allergies: [], existingLines: [], isTeleconsultation: false },
    );
    expect(inPerson).toHaveLength(0);
  });
});

describe('ordering', () => {
  it('puts the most serious warning first, because that is what gets read', () => {
    const warnings = checkPrescription(
      { drugDisplayName: 'Mox 500', moleculeName: 'Amoxicillin' },
      {
        allergies: [penicillinAllergy],
        existingLines: [
          { drugDisplayName: 'Mox 500', moleculeName: 'Amoxicillin' } as never,
        ],
      },
    );
    expect(warnings.length).toBeGreaterThan(1);
    expect(warnings[0]?.severity).toBe('BLOCKING');
  });
});
