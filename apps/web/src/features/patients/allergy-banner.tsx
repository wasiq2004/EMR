'use client';

import * as React from 'react';
import { AlertTriangle, Plus, ShieldCheck } from 'lucide-react';
import type { Allergy } from '@emr/contracts';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * ============================ SAFETY-CRITICAL UI ============================
 *
 * The allergy panel sits at the top of the Patient Snapshot, above the fold,
 * and is drawn to be visually unlike everything else on the screen.
 *
 * The acceptance criterion this exists to satisfy is absolute: five out of five
 * pilot doctors must mention the allergy unprompted when asked "without
 * scrolling back, what do you already know about this patient?". A single miss
 * is a patient-safety defect and a stop-and-redesign decision, not a backlog
 * item. Anything that makes this panel quieter — moving it below vitals,
 * collapsing it by default, matching it to the surrounding card style — must be
 * re-tested against that criterion before it ships.
 *
 * "No known allergies" is shown as a deliberate, positive statement rather than
 * an empty space, because an absent panel is ambiguous: it could mean none were
 * recorded, or that the panel failed to load.
 * ===========================================================================
 */
export function AllergyBanner({
  allergies,
  onAdd,
  canAdd,
  className,
}: {
  allergies: Allergy[];
  onAdd?: () => void;
  canAdd?: boolean;
  className?: string;
}) {
  const active = allergies.filter((a) => a.refutedAt === null);
  const hasHigh = active.some((a) => a.criticality === 'HIGH');

  if (active.length === 0) {
    return (
      <section
        aria-labelledby="allergies-heading"
        className={cn(
          'flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3',
          className,
        )}
      >
        <ShieldCheck className="size-4 shrink-0 text-positive" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="allergies-heading" className="text-sm font-semibold text-ink">
            No known allergies
          </h2>
          <p className="text-2xs text-ink-faint">
            Nothing has been recorded for this patient. Ask at triage.
          </p>
        </div>
        {canAdd && onAdd ? (
          <Button size="sm" variant="secondary" onClick={onAdd}>
            <Plus aria-hidden />
            Record allergy
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="allergies-heading"
      className={cn(
        'rounded-lg border-2 px-4 py-3',
        hasHigh
          ? 'border-critical bg-critical-soft'
          : 'border-warning-line bg-warning-soft',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className={cn('mt-0.5 size-5 shrink-0', hasHigh ? 'text-critical' : 'text-warning')}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="allergies-heading"
              className={cn(
                'text-md font-bold uppercase tracking-wide',
                hasHigh ? 'text-critical' : 'text-warning',
              )}
            >
              {hasHigh ? 'Severe allergy' : 'Allergies recorded'}
            </h2>
            <Badge tone={hasHigh ? 'alarm' : 'warning'}>
              {active.length} recorded
            </Badge>
          </div>

          <ul className="mt-2 flex flex-col gap-1.5">
            {active.map((allergy) => (
              <li key={allergy.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span
                  className={cn(
                    'text-md font-bold',
                    allergy.criticality === 'HIGH' ? 'text-critical' : 'text-ink',
                  )}
                >
                  {allergy.substanceText}
                </span>
                {allergy.criticality === 'HIGH' ? (
                  <Badge tone="alarm">High risk</Badge>
                ) : allergy.criticality === 'LOW' ? (
                  <Badge tone="neutral">Low risk</Badge>
                ) : (
                  <Badge tone="neutral">Risk not assessed</Badge>
                )}
                {allergy.reactionDescription ? (
                  <span className="text-xs text-ink-soft">
                    {allergy.reactionDescription}
                  </span>
                ) : null}
                <span className="text-2xs text-ink-faint">
                  recorded {formatDate(allergy.recordedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {canAdd && onAdd ? (
          <Button size="sm" variant="secondary" onClick={onAdd}>
            <Plus aria-hidden />
            Add
          </Button>
        ) : null}
      </div>
    </section>
  );
}
