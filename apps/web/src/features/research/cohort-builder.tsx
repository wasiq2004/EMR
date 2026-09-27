'use client';

import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { AGE_BANDS, type CohortFilters } from '@emr/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';

/**
 * The cohort builder.
 *
 * WHAT IT DELIBERATELY CANNOT DO: search for a person. There is no name field, no
 * phone field, no MRN field, and adding one would be pointless because the analyst
 * session holds no permission that would answer it. The blueprint's §7 rule — an
 * analyst is not a generic reports user and not a backdoor to identifiable records —
 * is expressed as the absence of the input rather than a validation on it.
 *
 * EVERY FILTER NARROWS. There is no "include" toggle that could widen a cohort by
 * accident, and the date range is required rather than defaulted to everything: an
 * unbounded cohort is the whole record, which is not a question.
 */
export function CohortBuilder({
  value,
  onChange,
  disabled,
}: {
  value: CohortFilters;
  onChange: (filters: CohortFilters) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<CohortFilters>) => onChange({ ...value, ...patch });

  const toggleBand = (band: string) => {
    const current = value.ageBands ?? [];
    const next = current.includes(band as never)
      ? current.filter((b) => b !== band)
      : [...current, band as never];
    set({ ageBands: next.length > 0 ? next : undefined });
  };

  const toggleSex = (sex: 'MALE' | 'FEMALE' | 'OTHER' | 'UNKNOWN') => {
    const current = value.sexes ?? [];
    const next = current.includes(sex)
      ? current.filter((s) => s !== sex)
      : [...current, sex];
    set({ sexes: next.length > 0 ? next : undefined });
  };

  return (
    <div className="space-y-4">
      <Alert tone="info" title="Cohorts describe groups, never people">
        Filters work on age bands, coded diagnoses and dates. There is no way to search
        by name, phone number or record number from this panel — the permission that
        would answer such a search is not held by this role.
      </Alert>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Visits from"
          htmlFor="cohort-from"
          required
          hint="Only finalised consultations are counted."
        >
          <Input
            id="cohort-from"
            type="date"
            value={value.from}
            disabled={disabled}
            onChange={(event) => set({ from: event.target.value })}
          />
        </Field>
        <Field label="Visits to" htmlFor="cohort-to" required>
          <Input
            id="cohort-to"
            type="date"
            value={value.to}
            disabled={disabled}
            onChange={(event) => set({ to: event.target.value })}
          />
        </Field>
      </div>

      <fieldset>
        <legend className="text-2xs uppercase tracking-wide text-ink-faint">
          Age bands
        </legend>
        <p className="mt-0.5 text-2xs text-ink-faint">
          Fixed bands, not configurable — a band narrowed to one year combined with a
          date range would identify a patient.
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {AGE_BANDS.map((band) => {
            const active = (value.ageBands ?? []).includes(band.key as never);
            return (
              <button
                key={band.key}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => toggleBand(band.key)}
                className={cn(
                  'rounded-sm border px-2 py-1 text-xs',
                  'transition-colors duration-[--duration-ui] ease-[--ease-ui]',
                  active
                    ? 'border-accent/30 bg-accent-soft font-medium text-accent-ink'
                    : 'border-line bg-surface text-ink-soft hover:bg-surface-sunk',
                )}
              >
                {band.label}
              </button>
            );
          })}
          <button
            type="button"
            disabled={disabled}
            aria-pressed={(value.ageBands ?? []).includes('UNKNOWN')}
            onClick={() => toggleBand('UNKNOWN')}
            className={cn(
              'rounded-sm border px-2 py-1 text-xs',
              (value.ageBands ?? []).includes('UNKNOWN')
                ? 'border-warning-line bg-warning-soft font-medium text-warning'
                : 'border-line bg-surface text-ink-soft hover:bg-surface-sunk',
            )}
          >
            Age unknown
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-2xs uppercase tracking-wide text-ink-faint">Sex</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'] as const).map((sex) => {
            const active = (value.sexes ?? []).includes(sex);
            return (
              <button
                key={sex}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => toggleSex(sex)}
                className={cn(
                  'rounded-sm border px-2 py-1 text-xs',
                  active
                    ? 'border-accent/30 bg-accent-soft font-medium text-accent-ink'
                    : 'border-line bg-surface text-ink-soft hover:bg-surface-sunk',
                )}
              >
                {sex === 'UNKNOWN' ? 'Not recorded' : sex.charAt(0) + sex.slice(1).toLowerCase()}
              </button>
            );
          })}
        </div>
      </fieldset>

      <TokenList
        label="Diagnosis codes"
        hint="Coded diagnoses only. A free-text diagnosis cannot be selected for — check the coding-completeness figure before drawing conclusions."
        values={value.diagnosisCodes ?? []}
        placeholder="E11.9"
        disabled={disabled}
        onChange={(next) => set({ diagnosisCodes: next.length > 0 ? next : undefined })}
      />

      <TokenList
        label="Medication molecules"
        hint="Generic names, never brands. A cohort by brand is a commercial question."
        values={value.medicationMolecules ?? []}
        placeholder="metformin"
        disabled={disabled}
        onChange={(next) => set({ medicationMolecules: next.length > 0 ? next : undefined })}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Consultation mode"
          htmlFor="cohort-mode"
          hint="Leave as any unless the mode is the question."
        >
          <Select
            id="cohort-mode"
            disabled={disabled}
            value={value.consultationModes?.[0] ?? ''}
            onChange={(event) =>
              set({
                consultationModes: event.target.value
                  ? [event.target.value as 'IN_PERSON']
                  : undefined,
              })
            }
          >
            <option value="">Any</option>
            <option value="IN_PERSON">In person</option>
            <option value="TELECONSULTATION">Teleconsultation</option>
          </Select>
        </Field>
        <Field
          label="Minimum visits in the period"
          htmlFor="cohort-min"
          hint="For a cohort of returning patients rather than one-off visits."
        >
          <Input
            id="cohort-min"
            type="number"
            min={1}
            disabled={disabled}
            value={value.minEncounters ?? ''}
            onChange={(event) =>
              set({ minEncounters: event.target.value ? Number(event.target.value) : undefined })
            }
          />
        </Field>
      </div>

      <fieldset className="rounded-md border border-line-soft p-3">
        <legend className="px-1 text-2xs uppercase tracking-wide text-ink-faint">
          Measurement range
        </legend>
        <p className="text-2xs text-ink-faint">
          Patients with an observation in this range during the period. Always check the
          unit-completeness figure first — the same code recorded in different units
          makes a range filter meaningless.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Input
            aria-label="Observation code"
            placeholder="Code, e.g. BP_SYSTOLIC"
            disabled={disabled}
            value={value.observation?.code ?? ''}
            onChange={(event) =>
              set({
                observation: event.target.value
                  ? { ...value.observation, code: event.target.value }
                  : undefined,
              })
            }
          />
          <Input
            aria-label="Minimum value"
            type="number"
            placeholder="At least"
            disabled={disabled || !value.observation?.code}
            value={value.observation?.min ?? ''}
            onChange={(event) =>
              value.observation?.code &&
              set({
                observation: {
                  ...value.observation,
                  min: event.target.value ? Number(event.target.value) : undefined,
                },
              })
            }
          />
          <Input
            aria-label="Maximum value"
            type="number"
            placeholder="At most"
            disabled={disabled || !value.observation?.code}
            value={value.observation?.max ?? ''}
            onChange={(event) =>
              value.observation?.code &&
              set({
                observation: {
                  ...value.observation,
                  max: event.target.value ? Number(event.target.value) : undefined,
                },
              })
            }
          />
        </div>
      </fieldset>
    </div>
  );
}

/** A list of typed codes, added on Enter and removed individually. */
function TokenList({
  label,
  hint,
  values,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  values: string[];
  placeholder: string;
  disabled?: boolean;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = React.useState('');
  const id = React.useId();

  const add = () => {
    const value = draft.trim();
    if (!value || values.includes(value)) {
      setDraft('');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" variant="secondary" disabled={disabled || !draft.trim()} onClick={add}>
          Add
        </Button>
      </div>
      {values.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface-sunk px-1.5 py-0.5 text-xs text-ink"
            >
              <span className="token">{value}</span>
              <button
                type="button"
                aria-label={`Remove ${value}`}
                disabled={disabled}
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="text-ink-faint hover:text-critical"
              >
                <Trash2 className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </Field>
  );
}

/** A sensible starting definition: the last ninety days, nothing narrowed. */
export function defaultFilters(): CohortFilters {
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** The suppression notice, shown wherever a breakdown is rendered. */
export function SuppressionNote({
  suppressedCellCount,
  threshold,
}: {
  suppressedCellCount: number;
  threshold: number;
}) {
  if (suppressedCellCount === 0) return null;

  return (
    <p className="mt-2 flex items-center gap-1.5 text-2xs text-ink-faint">
      <Badge tone="neutral">—</Badge>
      {suppressedCellCount} cell{suppressedCellCount === 1 ? '' : 's'} hidden because fewer
      than {threshold} patients fall in them. A hidden cell is not zero; at a clinic this
      size a count of one or two would name someone.
    </p>
  );
}
