import { describe, expect, it } from 'vitest';
import { ageGender, currentAge, formatPaise, formatPhone, rupeesToPaise } from './format';

/**
 * Age derivation is the subtle one.
 *
 * Indian outpatient registration frequently captures a stated age rather than a
 * date of birth. A stated age is only meaningful alongside the date it was
 * stated — a patient recorded as "45" three years ago is 48 now, and treating
 * the stored number as current is how paediatric dosing quietly goes wrong.
 */

const yearsAgo = (n: number) => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - n);
  return date.toISOString().slice(0, 10);
};

describe('currentAge', () => {
  it('derives from a date of birth', () => {
    expect(
      currentAge({ dateOfBirth: yearsAgo(34), ageYears: null, ageRecordedAt: null }),
    ).toBe(34);
  });

  it('ages a stated age forward by the time since it was stated', () => {
    // Recorded as 45, three years ago. The patient is 48 now, not 45.
    expect(
      currentAge({ dateOfBirth: null, ageYears: 45, ageRecordedAt: yearsAgo(3) }),
    ).toBe(48);
  });

  it('prefers the date of birth when both are present', () => {
    expect(
      currentAge({
        dateOfBirth: yearsAgo(30),
        ageYears: 99,
        ageRecordedAt: yearsAgo(1),
      }),
    ).toBe(30);
  });

  it('falls back to the bare stated age when the date it was stated is missing', () => {
    expect(
      currentAge({ dateOfBirth: null, ageYears: 45, ageRecordedAt: null }),
    ).toBe(45);
  });

  it('returns null rather than guessing when nothing is recorded', () => {
    expect(
      currentAge({ dateOfBirth: null, ageYears: null, ageRecordedAt: null }),
    ).toBeNull();
  });

  it('handles an infant stated in the current year', () => {
    expect(
      currentAge({ dateOfBirth: null, ageYears: 0, ageRecordedAt: yearsAgo(0) }),
    ).toBe(0);
  });
});

describe('ageGender', () => {
  it('renders the compact form staff read fastest in a list', () => {
    expect(
      ageGender({
        dateOfBirth: yearsAgo(34),
        ageYears: null,
        ageRecordedAt: null,
        gender: 'FEMALE',
      }),
    ).toBe('34F');
  });

  it('does not invent an age it does not have', () => {
    expect(
      ageGender({
        dateOfBirth: null,
        ageYears: null,
        ageRecordedAt: null,
        gender: 'MALE',
      }),
    ).toBe('M');
  });
});

describe('money', () => {
  it('formats paise as rupees', () => {
    expect(formatPaise(60000)).toContain('600.00');
  });

  it('round-trips rupees to paise without floating-point drift', () => {
    // 1234.55 * 100 in binary floating point is 123454.99999999999.
    expect(rupeesToPaise(1234.55)).toBe(123455);
    expect(rupeesToPaise('0.07')).toBe(7);
  });

  it('treats an unparseable amount as zero rather than NaN', () => {
    expect(rupeesToPaise('abc')).toBe(0);
  });
});

describe('phone display', () => {
  it('groups an Indian mobile the way it is read aloud', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
  });

  it('shows a dash rather than an empty gap when there is no number', () => {
    expect(formatPhone(null)).toBe('—');
  });

  it('leaves a non-Indian number alone rather than mangling it', () => {
    expect(formatPhone('+442071234567')).toBe('+442071234567');
  });
});
