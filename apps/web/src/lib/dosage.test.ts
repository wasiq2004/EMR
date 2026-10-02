import { describe, expect, it } from 'vitest';
import {
  dosesPerDay,
  expandFrequency,
  quantityForCourse,
} from '@emr/contracts';

/**
 * Dosage arithmetic.
 *
 * Tested because it is the number that reaches a pharmacy label. The screen
 * that writes a prescription used to hardcode `1-0-1`, `AFTER_FOOD` and `5
 * days` for every drug a doctor selected, whatever they meant — so a patient
 * could be handed a printed prescription saying twice a day for five days for a
 * drug intended once daily for three. These helpers are what replaced that, and
 * an off-by-one here is a patient one tablet short on the last day.
 */

describe('dosesPerDay', () => {
  it('adds up a positional frequency', () => {
    expect(dosesPerDay('1-0-1')).toBe(2);
    expect(dosesPerDay('1-1-1')).toBe(3);
    expect(dosesPerDay('1-1-1-1')).toBe(4);
    expect(dosesPerDay('2-0-2')).toBe(4);
    expect(dosesPerDay('1-0-0')).toBe(1);
  });

  it('reads the fractions an Indian prescription is written with', () => {
    expect(dosesPerDay('1/2-0-1/2')).toBe(1);
    expect(dosesPerDay('1/2-0-0')).toBe(0.5);
    expect(dosesPerDay('1/4-0-1/4')).toBe(0.5);
  });

  it('normalises the Latin abbreviations first', () => {
    expect(dosesPerDay('BD')).toBe(2);
    expect(dosesPerDay('TDS')).toBe(3);
    expect(dosesPerDay('OD')).toBe(1);
    expect(dosesPerDay('QID')).toBe(4);
    expect(dosesPerDay('hs')).toBe(1);
  });

  /*
   * An as-needed drug has NO daily total, and that has to come back as null
   * rather than as a number. Treating SOS as one-a-day would print a confident
   * quantity on a pharmacy label for a course nobody can count.
   */
  it('refuses to invent a daily total for SOS or STAT', () => {
    expect(dosesPerDay('SOS')).toBeNull();
    expect(dosesPerDay('STAT')).toBeNull();
    expect(dosesPerDay('sos')).toBeNull();
  });

  it('returns null rather than guessing at something it cannot parse', () => {
    expect(dosesPerDay('as directed')).toBeNull();
    expect(dosesPerDay('')).toBeNull();
    expect(dosesPerDay('1--1')).toBeNull();
    expect(dosesPerDay('0-0-0')).toBeNull();
    expect(dosesPerDay('1-x-1')).toBeNull();
  });
});

describe('quantityForCourse', () => {
  it('multiplies the daily dose by the days', () => {
    expect(quantityForCourse('1-0-1', 5)).toBe(10);
    expect(quantityForCourse('1-1-1', 3)).toBe(9);
    expect(quantityForCourse('1-0-0', 30)).toBe(30);
  });

  /*
   * Rounded UP, always. Half a tablet cannot be dispensed, and rounding down
   * sends the patient home one short on the last day of the course.
   */
  it('rounds up to a whole unit', () => {
    expect(quantityForCourse('1/2-0-1/2', 5)).toBe(5);
    expect(quantityForCourse('1/2-0-0', 5)).toBe(3);
    expect(quantityForCourse('1/2-0-0', 7)).toBe(4);
  });

  it('gives no quantity where there is no daily total', () => {
    expect(quantityForCourse('SOS', 5)).toBeNull();
    expect(quantityForCourse('STAT', 1)).toBeNull();
  });

  it('gives no quantity without a duration', () => {
    expect(quantityForCourse('1-0-1', null)).toBeNull();
    expect(quantityForCourse('1-0-1', 0)).toBeNull();
    expect(quantityForCourse('1-0-1', undefined)).toBeNull();
  });
});

describe('expandFrequency', () => {
  it('maps the abbreviations a doctor types to the positional form', () => {
    expect(expandFrequency('bd')).toBe('1-0-1');
    expect(expandFrequency('TDS')).toBe('1-1-1');
    expect(expandFrequency('hs')).toBe('0-0-1');
  });

  it('leaves anything it does not recognise exactly as typed', () => {
    // A tapering course is a real prescription that no preset list contains,
    // and mangling it would be worse than passing it through.
    expect(expandFrequency('2-0-2 for 3 days then 1-0-1')).toBe(
      '2-0-2 for 3 days then 1-0-1',
    );
    expect(expandFrequency('  1-0-1  ')).toBe('1-0-1');
  });
});
