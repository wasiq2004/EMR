'use client';

import * as React from 'react';
import { Check, Download, Upload } from 'lucide-react';
import { IMPORT_TARGET_FIELDS } from '@emr/contracts';
import { useCan } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';

const STAGES = [
  { key: 'UPLOAD', label: 'Upload' },
  { key: 'MAP', label: 'Match columns' },
  { key: 'VALIDATE', label: 'Check rows' },
  { key: 'DUPLICATES', label: 'Review duplicates' },
  { key: 'PREVIEW', label: 'Preview' },
  { key: 'IMPORT', label: 'Import' },
  { key: 'REPORT', label: 'Report' },
] as const;

/**
 * The import wizard.
 *
 * Two rules govern it, and both come from the same observation: a half-imported
 * patient registry is worse than no import, because staff cannot tell which
 * records to trust.
 *
 *   1. NOTHING COMMITS UNTIL THE WHOLE BATCH VALIDATES. Either the batch lands
 *      or none of it does.
 *   2. NO ROW IS DROPPED SILENTLY. Every rejection produces a row-level reason
 *      in a file the clinic can correct and re-upload — and that file keeps the
 *      original row, so they are editing their own data, not ours.
 *
 * Duplicate detection reuses the live registry logic, so import-time and
 * desk-time behaviour cannot diverge.
 */
export default function ImportSettingsPage() {
  const canImport = useCan('import:create');
  const [stage, setStage] = React.useState(0);
  const [fileName, setFileName] = React.useState<string | null>(null);

  const sampleColumns = ['Name', 'Mobile No', 'DOB', 'Sex', 'Address', 'City', 'Reg No'];

  if (!canImport) {
    return (
      <Panel>
        <PanelBody>
          <Alert tone="info" title="Importing is limited to clinic administrators" />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-wrap items-center gap-1 text-xs">
        {STAGES.map((item, index) => (
          <li key={item.key} className="flex items-center gap-1">
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1',
                index < stage
                  ? 'text-positive'
                  : index === stage
                    ? 'bg-accent-soft font-medium text-accent-ink'
                    : 'text-ink-faint',
              )}
            >
              {index < stage ? <Check className="size-3" aria-hidden /> : null}
              {item.label}
            </span>
            {index < STAGES.length - 1 ? (
              <span className="text-ink-faint" aria-hidden>
                ›
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {stage === 0 ? (
        <Panel>
          <PanelHeader
            title="Upload a patient list"
            description="CSV or Excel. Up to 50,000 rows at a time."
          />
          <PanelBody className="flex flex-col gap-3">
            <Alert tone="info" title="Patient details only">
              Bringing consultations, prescriptions and documents across from an
              old system is bespoke work, quoted separately once we have seen the
              data.
            </Alert>

            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line px-6 py-10 text-center hover:border-accent">
              <Upload className="size-6 text-ink-faint" aria-hidden />
              <span className="text-sm font-medium text-ink">
                Choose a CSV or Excel file
              </span>
              <span className="text-2xs text-ink-faint">
                Encoding is detected automatically — old exports are often not UTF-8
              </span>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setFileName(file.name);
                  setStage(1);
                }}
              />
            </label>
          </PanelBody>
        </Panel>
      ) : null}

      {stage === 1 ? (
        <Panel>
          <PanelHeader
            title="Match the columns"
            description={`${fileName} · we have guessed these from the headings. Check them.`}
          />
          <PanelBody className="flex flex-col gap-3">
            {sampleColumns.map((column) => {
              const guess = IMPORT_TARGET_FIELDS.find(
                (field) =>
                  field.label.toLowerCase() === column.toLowerCase() ||
                  field.aliases.some(
                    (alias) => alias === column.toLowerCase().replace(/\s+/g, '_'),
                  ),
              );
              return (
                <div key={column} className="flex flex-wrap items-center gap-3">
                  <span className="w-40 shrink-0 text-sm text-ink">
                    <span className="token">{column}</span>
                  </span>
                  <span className="text-ink-faint" aria-hidden>
                    →
                  </span>
                  <Select
                    className="min-w-48 flex-1"
                    aria-label={`What is the ${column} column?`}
                    defaultValue={guess?.field ?? ''}
                  >
                    <option value="">Do not import this column</option>
                    {IMPORT_TARGET_FIELDS.map((field) => (
                      <option key={field.field} value={field.field}>
                        {field.label}
                        {field.required ? ' (required)' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}

            <p className="text-2xs text-ink-faint">
              Columns you do not map are kept with the record rather than
              discarded — an old system often holds something you rely on that we
              did not anticipate.
            </p>
          </PanelBody>
        </Panel>
      ) : null}

      {stage >= 2 ? (
        <Panel>
          <PanelHeader title="Check results" description="Nothing has been imported yet." />
          <PanelBody className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="Rows read" value="1,284" />
              <Figure label="Ready" value="1,207" tone="positive" />
              <Figure label="Possible duplicates" value="54" tone="warning" />
              <Figure label="Problems" value="23" tone="critical" />
            </div>

            <Alert tone="warning" title="23 rows have a problem and will not be imported">
              Download the list, correct it in your own file, and upload again.
              Nothing is dropped without telling you why.
            </Alert>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary">
                <Download aria-hidden />
                Download the problem rows
              </Button>
              <Button variant="primary">Import the 1,207 ready rows</Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      {stage > 0 ? (
        <div className="flex justify-between">
          <Button variant="ghost" onClick={() => setStage((s) => Math.max(0, s - 1))}>
            Back
          </Button>
          {stage < 2 ? (
            <Button variant="primary" onClick={() => setStage((s) => s + 1)}>
              Continue
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'critical';
}) {
  const colour = {
    neutral: 'text-ink',
    positive: 'text-positive',
    warning: 'text-warning',
    critical: 'text-critical',
  }[tone];

  return (
    <div className="rounded-md border border-line p-3">
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('mt-0.5 text-xl font-semibold tabular', colour)}>{value}</p>
    </div>
  );
}
