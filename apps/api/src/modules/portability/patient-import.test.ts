import { describe, expect, it } from 'vitest';
import { parseDate, parseGender, suggestMapping } from './patient-import.service';

/**
 * The field readers an old clinic register goes through.
 *
 * These are tested because they are the functions that are WRONG QUIETLY. A
 * date read month-first still produces a valid date, imports without complaint,
 * and shifts a birthday by weeks — enough to change a paediatric dose and enough
 * to stop a date-of-birth duplicate check from matching. There is no error
 * anywhere; the register is just subtly untrue.
 */

describe('parseDate', () => {
  it('reads ISO dates', () => {
    expect(parseDate('1990-04-03')).toBe('1990-04-03');
    expect(parseDate('1990-4-3')).toBe('1990-04-03');
  });

  /*
   * THE ASSUMPTION THAT MATTERS. 03/04/1990 is 3 April to an Indian clinic and
   * 4 March to an American export. Day-first is right for this market and for
   * the systems these clinics are leaving, and getting it backwards is the
   * single most damaging silent error in this file.
   */
  it('reads an ambiguous date day-first, as this market writes them', () => {
    expect(parseDate('03/04/1990')).toBe('1990-04-03');
    expect(parseDate('03-04-1990')).toBe('1990-04-03');
    expect(parseDate('03.04.1990')).toBe('1990-04-03');
  });

  it('reads an unambiguous day-first date the same way', () => {
    expect(parseDate('25/12/1990')).toBe('1990-12-25');
  });

  /*
   * A two-digit year is read as the past: a patient register holds no birthdays
   * in the future. Reading "58" as 2058 gives a negative age; reading "05" as
   * 1905 makes a twenty-year-old a centenarian.
   */
  it('reads a two-digit year as a birthday that has happened', () => {
    expect(parseDate('01/01/58')).toBe('1958-01-01');
    expect(parseDate('01/01/05')).toBe('2005-01-01');
  });

  /** 31 February is not a date. Rolling it into March invents a birthday. */
  it('refuses a day that does not exist in that month', () => {
    expect(parseDate('31/02/1990')).toBeNull();
    expect(parseDate('30/02/2000')).toBeNull();
    expect(parseDate('1990-02-31')).toBeNull();
  });

  it('accepts a leap day in a leap year and refuses it otherwise', () => {
    expect(parseDate('29/02/2000')).toBe('2000-02-29');
    expect(parseDate('29/02/1999')).toBeNull();
  });

  it('refuses a date in the future', () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(parseDate(`01/01/${nextYear}`)).toBeNull();
  });

  it('refuses a month above twelve rather than reading it month-first', () => {
    // 13 cannot be a month. It is also not a licence to swap the fields — an
    // export that writes 13/25/1990 is broken and should be reported.
    expect(parseDate('13/25/1990')).toBeNull();
  });

  it('refuses what is not a date at all', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('34')).toBeNull();
  });
});

describe('parseGender', () => {
  it('reads what a register actually writes', () => {
    expect(parseGender('M')).toBe('MALE');
    expect(parseGender('male')).toBe('MALE');
    expect(parseGender('F')).toBe('FEMALE');
    expect(parseGender('FEMALE')).toBe('FEMALE');
    expect(parseGender('Other')).toBe('OTHER');
  });

  /** A dropdown's stored index, which is what some older systems export. */
  it('reads a numeric code', () => {
    expect(parseGender('1')).toBe('MALE');
    expect(parseGender('2')).toBe('FEMALE');
  });

  it('treats a blank as not stated rather than as an error', () => {
    expect(parseGender('')).toBeUndefined();
    expect(parseGender('   ')).toBeUndefined();
  });

  /*
   * The important case. Something WAS written and it is not recognised, so the
   * row is reported rather than quietly becoming UNKNOWN — a record that reads
   * as complete and is not is worse than one the clinic was asked about.
   */
  it('reports an unrecognised entry instead of defaulting it', () => {
    expect(parseGender('Mle')).toBeNull();
    expect(parseGender('9')).toBeNull();
    expect(parseGender('पुरुष')).toBeNull();
  });
});

describe('suggestMapping', () => {
  it('matches a heading to a field through its aliases', () => {
    const mapping = suggestMapping(['Name', 'Mobile No', 'DOB', 'Sex']);
    expect(mapping).toEqual({
      Name: 'fullName',
      'Mobile No': 'mobileE164',
      DOB: 'dateOfBirth',
      Sex: 'gender',
    });
  });

  it('leaves a heading it does not recognise unmapped rather than guessing', () => {
    const mapping = suggestMapping(['Name', 'Consultant Dr', 'Remarks']);
    expect(mapping['Name']).toBe('fullName');
    expect(mapping['Consultant Dr']).toBe('');
    expect(mapping['Remarks']).toBe('');
  });

  /*
   * Two columns that both look like the mobile number: the first keeps it and
   * the second is left blank for a person to decide. Overwriting would silently
   * pick the second, which in a real export is often the landline.
   */
  it('does not let a second column steal a field from the first', () => {
    const mapping = suggestMapping(['Name', 'Mobile', 'Phone']);
    expect(mapping['Mobile']).toBe('mobileE164');
    expect(mapping['Phone']).toBe('');
  });

  it('is case and spacing insensitive', () => {
    expect(suggestMapping(['FULL NAME'])['FULL NAME']).toBe('fullName');
    expect(suggestMapping(['patient_name'])['patient_name']).toBe('fullName');
  });
});
