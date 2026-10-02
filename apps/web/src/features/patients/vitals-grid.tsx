'use client';

import type { Observation } from '@emr/contracts';
import { bmiBand, bodyMassIndex, vitalFor } from '@emr/contracts';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';

/**
 * The latest set of vitals, read-only.
 *
 * ONE COMPONENT, because there were two and they disagreed. The consultation
 * screen printed the numbers with no flag at all, so a doctor reading vitals
 * during a consultation could not see that a reading was out of range; the
 * patient page did flag them, but rendered `CRITICAL` as "Below range" — the
 * loudest reading in the system described with the wrong word.
 *
 * Both were also reading an `interpretation` that was always null, because the
 * server's write stripped it. That is fixed; this is the screen that shows it.
 */
export function VitalsGrid({
  vitals,
  className,
  showAge = true,
}: {
  vitals: Observation[];
  className?: string;
  /** The consultation screen is tight for space and the vitals are today's. */
  showAge?: boolean;
}) {
  /*
   * BMI from the latest weight and height, which may have been taken on
   * different days.
   *
   * That is the right behaviour and worth being explicit about: height is
   * measured once and weight every visit, so pairing today's weight with a
   * height from two years ago is exactly what a clinician expects. It is
   * derived here rather than stored — see `bodyMassIndex`.
   */
  const weight = vitals.find((v) => v.code === '29463-7')?.valueNumeric ?? null;
  const height = vitals.find((v) => v.code === '8302-2')?.valueNumeric ?? null;
  const bmi = bodyMassIndex(weight, height);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="grid grid-cols-2 gap-3">
        {vitals.map((vital) => (
          <VitalReading key={vital.id} vital={vital} showAge={showAge} />
        ))}
      </div>

      {bmi !== null ? (
        <div className="flex items-baseline gap-2 border-t border-line-soft pt-2">
          <span className="text-2xs uppercase tracking-wide text-ink-faint">BMI</span>
          <span className="text-sm font-semibold tabular text-ink">{bmi}</span>
          <span
            className={cn(
              'text-2xs font-medium',
              bmiBand(bmi).tone === 'normal' ? 'text-ink-soft' : 'text-warning',
            )}
          >
            {bmiBand(bmi).label}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function VitalReading({ vital, showAge }: { vital: Observation; showAge: boolean }) {
  const critical = vital.interpretation === 'CRITICAL';
  const abnormal = critical || vital.interpretation === 'HIGH' || vital.interpretation === 'LOW';

  const reference = vitalFor(vital.code);
  const range =
    reference?.low != null && reference?.high != null
      ? `${reference.low}–${reference.high}`
      : null;

  return (
    <div className="min-w-0">
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{vital.display}</p>
      <p
        className={cn(
          'text-lg font-semibold tabular',
          critical ? 'text-critical' : abnormal ? 'text-warning' : 'text-ink',
        )}
      >
        {vital.valueNumeric ?? vital.valueText ?? '—'}
        <span className="ml-1 text-2xs font-normal text-ink-faint">{vital.valueUnit}</span>
      </p>

      {/*
        The word as well as the colour — colour alone is not an accessible
        signal, and this one carries clinical meaning. Critical is worded
        differently from merely out of range, because they mean different things
        at a counter.
      */}
      {abnormal ? (
        <span
          className={cn('text-2xs font-medium', critical ? 'text-critical' : 'text-warning')}
        >
          {critical
            ? 'Well outside range'
            : vital.interpretation === 'HIGH'
              ? 'Above range'
              : 'Below range'}
          {range ? ` (${range})` : ''}
        </span>
      ) : vital.interpretation === 'NORMAL' ? (
        <span className="text-2xs text-ink-faint">In range{range ? ` (${range})` : ''}</span>
      ) : (
        /*
         * Null is not "normal". It means nothing checked this reading — weight
         * and height have no range, and neither does anything a template added.
         * Printing "In range" for them would be a claim nobody made.
         */
        <span className="text-2xs text-ink-faint">Not range-checked</span>
      )}

      {showAge ? (
        <p className="text-2xs text-ink-faint">{relativeTime(vital.effectiveAt)}</p>
      ) : null}
    </div>
  );
}
