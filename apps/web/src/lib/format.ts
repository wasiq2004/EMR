/**
 * Display formatting. Everything a clinic reads on screen passes through here,
 * so the same value never appears two different ways in two places.
 */

import { differenceInYears, format, formatDistanceToNowStrict, parseISO } from 'date-fns';

/* ------------------------------------------------------------------------- *
 * Money — stored as paise, shown as rupees
 * ------------------------------------------------------------------------- */

const RUPEE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(paise: number): string {
  return RUPEE.format(paise / 100);
}

/** Compact form for dense tables, e.g. "₹1,250" with no paise when round. */
export function formatPaiseShort(paise: number): string {
  const rupees = paise / 100;
  const opts: Intl.NumberFormatOptions =
    Number.isInteger(rupees)
      ? { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }
      : { style: 'currency', currency: 'INR', minimumFractionDigits: 2 };
  return new Intl.NumberFormat('en-IN', opts).format(rupees);
}

export function rupeesToPaise(rupees: number | string): number {
  const n = typeof rupees === 'string' ? Number.parseFloat(rupees) : rupees;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/* ------------------------------------------------------------------------- *
 * Age
 * ------------------------------------------------------------------------- */

/**
 * Current age from whichever the clinic has.
 *
 * A stated age is only meaningful alongside the date it was stated — a patient
 * recorded as "45" three years ago is 48 now, and treating the stored number as
 * current is how paediatric dosing quietly goes wrong.
 */
export function currentAge(patient: {
  dateOfBirth: string | null;
  ageYears: number | null;
  ageRecordedAt: string | null;
}): number | null {
  if (patient.dateOfBirth) {
    return differenceInYears(new Date(), parseISO(patient.dateOfBirth));
  }
  if (patient.ageYears === null) return null;
  if (!patient.ageRecordedAt) return patient.ageYears;
  const elapsed = differenceInYears(new Date(), parseISO(patient.ageRecordedAt));
  return patient.ageYears + elapsed;
}

/** "34F" — the form staff read fastest in a list. */
export function ageGender(patient: {
  dateOfBirth: string | null;
  ageYears: number | null;
  ageRecordedAt: string | null;
  gender: string;
}): string {
  const age = currentAge(patient);
  const g = patient.gender === 'MALE' ? 'M' : patient.gender === 'FEMALE' ? 'F' : '—';
  return age === null ? g : `${age}${g}`;
}

/** Marks a derived age so nobody mistakes an estimate for a birthday. */
export function ageDetail(patient: {
  dateOfBirth: string | null;
  ageYears: number | null;
  ageRecordedAt: string | null;
}): string {
  const age = currentAge(patient);
  if (age === null) return 'Age not recorded';
  if (patient.dateOfBirth) return `${age} years · born ${formatDate(patient.dateOfBirth)}`;
  return `${age} years · age stated ${formatDate(patient.ageRecordedAt)}`;
}

/* ------------------------------------------------------------------------- *
 * Dates and times
 * ------------------------------------------------------------------------- */

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return format(parseISO(iso), 'd MMM yyyy');
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return format(parseISO(iso), 'h:mm a');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return format(parseISO(iso), 'd MMM yyyy, h:mm a');
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
}

/** "1h 20m" — how the queue shows a wait. */
export function formatMinutes(total: number | null): string {
  if (total === null) return '—';
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Countdown for the WhatsApp service window. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Closed';
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

/* ------------------------------------------------------------------------- *
 * Identity
 * ------------------------------------------------------------------------- */

/** Grouped the way an Indian mobile number is read aloud. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  if (e164.startsWith('+91') && e164.length === 13) {
    return `+91 ${e164.slice(3, 8)} ${e164.slice(8)}`;
  }
  return e164;
}

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Splits an interleaved BP pair back into "120/80" for display. */
export function formatBloodPressure(
  systolic: number | null,
  diastolic: number | null,
): string {
  if (systolic === null || diastolic === null) return '—';
  return `${systolic}/${diastolic}`;
}
