import { describe, expect, it } from 'vitest';
import { PERMISSION_MATRIX, can, type UserRole } from '@emr/contracts';
import {
  CLINICAL_NARRATIVE_FIELDS,
  redactEncounter,
  redactSnapshot,
} from './redact';

/**
 * Who can read what, asserted against the matrix rather than against a list
 * written out again here.
 *
 * These tests exist because the leak they cover was INVISIBLE. Both endpoints
 * returned 200 to every role that was supposed to reach them, the route guards
 * were correct, and the payload simply contained more than the guard implied.
 * Nothing failed; `scripts/verify/pharmacy.sh` even asserted a 403 that the
 * matrix says should be a 200, so the one check pointed at this was testing the
 * wrong mechanism.
 *
 * So the assertions below are deliberately phrased as "no role lacking X ever
 * receives X", driven by PERMISSION_MATRIX itself. A role added next year is
 * covered without anybody remembering to come back here.
 */

const ROLES = Object.keys(PERMISSION_MATRIX) as UserRole[];

const FULL_ENCOUNTER = {
  id: 'enc-1',
  patientId: 'pat-1',
  practitionerId: 'doc-1',
  startedAt: '2026-10-13T09:00:00.000Z',
  isFinalized: true,
  chiefComplaint: 'Chest pain for two days',
  historyOfPresentIllness: 'Radiating to the left arm',
  examinationNotes: 'BP 150/95, no murmur',
  assessmentNotes: 'Suspected angina',
  planNotes: 'Refer to cardiology',
  followUpInstructions: 'Return immediately if pain recurs',
  followUpAfterDays: 7,
  amendmentReason: 'Corrected the recorded BP',
};

const FULL_SNAPSHOT = {
  patientId: 'pat-1',
  allergies: [{ substanceText: 'Penicillin' }],
  conditions: [{ displayText: 'Type 2 diabetes' }],
  activeMedications: [{ drugName: 'Metformin' }],
  latestVitals: [{ code: '8480-6', value: 150 }],
  recentEncounters: [
    { id: 'enc-1', chiefComplaint: 'Chest pain', diagnoses: ['Suspected angina'] },
  ],
  outstandingPaise: 50000,
};

describe('redactEncounter', () => {
  it('leaves the narrative alone for every role that may read clinical content', () => {
    for (const role of ROLES.filter((r) => can(r, 'encounterClinicalContent:read'))) {
      expect(redactEncounter(FULL_ENCOUNTER, role).assessmentNotes, role).toBe(
        'Suspected angina',
      );
    }
  });

  it('blanks EVERY narrative field for every role that may not', () => {
    const blind = ROLES.filter((r) => !can(r, 'encounterClinicalContent:read'));
    // If this is empty the test proves nothing, and the matrix has changed in a
    // way somebody should look at.
    expect(blind.length).toBeGreaterThan(0);

    for (const role of blind) {
      const out = redactEncounter(FULL_ENCOUNTER, role);
      for (const field of CLINICAL_NARRATIVE_FIELDS) {
        expect(out[field], `${role} received ${field}`).toBeNull();
      }
    }
  });

  it('keeps the metadata a receptionist actually needs', () => {
    const out = redactEncounter(FULL_ENCOUNTER, 'RECEPTIONIST');
    expect(out.id).toBe('enc-1');
    expect(out.startedAt).toBe('2026-10-13T09:00:00.000Z');
    expect(out.practitionerId).toBe('doc-1');
    expect(out.isFinalized).toBe(true);
    // Scheduling information, not clinical content: the desk books the return
    // visit and a bare interval says nothing about why.
    expect(out.followUpAfterDays).toBe(7);
  });

  it('does not invent fields a projection never selected', () => {
    const outline = { id: 'enc-1', startedAt: '2026-10-13T09:00:00.000Z' };
    const out = redactEncounter(outline, 'RECEPTIONIST');
    expect('planNotes' in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['id', 'startedAt']);
  });

  it('returns the same object when nothing needs hiding', () => {
    // The doctor's consultation screen calls this on every load.
    expect(redactEncounter(FULL_ENCOUNTER, 'DOCTOR')).toBe(FULL_ENCOUNTER);
  });

  it('never mutates the row it was given', () => {
    const row = { ...FULL_ENCOUNTER };
    redactEncounter(row, 'RECEPTIONIST');
    expect(row.assessmentNotes).toBe('Suspected angina');
  });
});

/**
 * `recentEncounters[0]` under `noUncheckedIndexedAccess` is `T | undefined`, and
 * optional-chaining past it would make these assertions pass on a fixture that
 * had lost its encounter. So the element is asserted to exist first.
 */
function firstVisit(snapshot: typeof FULL_SNAPSHOT) {
  const [visit] = snapshot.recentEncounters;
  expect(visit, 'the fixture must carry a recent encounter').toBeDefined();
  return visit!;
}

describe('redactSnapshot', () => {
  it('gives each section only to a role holding that section’s permission', () => {
    const sections = [
      ['allergies', 'allergy:read'],
      ['conditions', 'condition:read'],
      ['activeMedications', 'prescription:read'],
      ['latestVitals', 'observation:read'],
    ] as const;

    for (const role of ROLES) {
      const out = redactSnapshot(FULL_SNAPSHOT, role);
      for (const [section, permission] of sections) {
        const expected = can(role, permission) ? 1 : 0;
        expect(out[section].length, `${role} / ${section}`).toBe(expected);
      }
    }
  });

  it('withholds diagnoses from the pharmacy counter but keeps allergies', () => {
    const out = redactSnapshot(FULL_SNAPSHOT, 'PHARMACIST');
    // The reason PHARMACIST holds allergy:read at all: penicillin.
    expect(out.allergies).toHaveLength(1);
    expect(out.conditions).toHaveLength(0);
    expect(firstVisit(out).diagnoses).toEqual([]);
    expect(firstVisit(out).chiefComplaint).toBeNull();
    // It does dispense, so the medication list stays.
    expect(out.activeMedications).toHaveLength(1);
  });

  it('withholds all five from reception', () => {
    const out = redactSnapshot(FULL_SNAPSHOT, 'RECEPTIONIST');
    expect(out.allergies).toHaveLength(0);
    expect(out.conditions).toHaveLength(0);
    expect(out.activeMedications).toHaveLength(0);
    expect(out.latestVitals).toHaveLength(0);
    expect(firstVisit(out).chiefComplaint).toBeNull();
  });

  it('leaves the doctor’s snapshot whole', () => {
    const out = redactSnapshot(FULL_SNAPSHOT, 'DOCTOR');
    expect(out.allergies).toHaveLength(1);
    expect(out.conditions).toHaveLength(1);
    expect(out.activeMedications).toHaveLength(1);
    expect(out.latestVitals).toHaveLength(1);
    expect(firstVisit(out).diagnoses).toEqual(['Suspected angina']);
    expect(firstVisit(out).chiefComplaint).toBe('Chest pain');
  });

  it('keeps the balance, which is nobody’s clinical data', () => {
    for (const role of ROLES) {
      expect(redactSnapshot(FULL_SNAPSHOT, role).outstandingPaise, role).toBe(50000);
    }
  });

  it('never mutates the snapshot it was given', () => {
    const snap = { ...FULL_SNAPSHOT, conditions: [{ displayText: 'Type 2 diabetes' }] };
    redactSnapshot(snap, 'RECEPTIONIST');
    expect(snap.conditions).toHaveLength(1);
  });
});
