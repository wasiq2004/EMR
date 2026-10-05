'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Download, Upload } from 'lucide-react';
import {
  IMPORT_MAX_ROWS,
  IMPORT_TARGET_FIELDS,
  type ImportColumnMapping,
  type ImportJobRow,
  type ImportRowProblem,
  type ImportUploadResult,
  type ImportValidationResult,
} from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { useCan } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

/**
 * The import wizard.
 *
 * WHAT THIS SCREEN USED TO BE, because it explains most of the decisions below:
 * a mock. The chosen file was never uploaded or read. The column list it asked
 * you to confirm was a hardcoded array of seven names. The result figures —
 * "1,284 rows read", "1,207 ready", "54 possible duplicates", "23 problems" —
 * were string literals, and the button beneath them said "Import the 1,207
 * ready rows" and did nothing. There was no `POST /imports` on the server at
 * all. A clinic admin would have come away believing their register was in.
 *
 * Every number here is now counted from the clinic's own file by the server,
 * and by the same function that decides what actually gets inserted.
 *
 * TWO RULES, both from one observation — a half-imported register is worse than
 * no import, because staff cannot tell which records are real:
 *
 *   1. NOTHING COMMITS UNTIL THE WHOLE BATCH VALIDATES. One transaction.
 *   2. NO ROW IS DROPPED SILENTLY. Every rejection is in a file the clinic can
 *      correct and re-upload, carrying their own columns.
 */

const STAGES = [
  { key: 'UPLOAD', label: 'Upload' },
  { key: 'MAP', label: 'Match columns' },
  { key: 'CHECK', label: 'Check rows' },
  { key: 'IMPORT', label: 'Import' },
] as const;

export default function ImportSettingsPage() {
  const canImport = useCan('import:create');
  const canExecute = useCan('import:execute');

  if (!canImport) {
    return (
      <Panel>
        <PanelBody>
          <Alert tone="info" title="Importing is limited to clinic administrators" />
        </PanelBody>
      </Panel>
    );
  }

  return <ImportWizard canExecute={canExecute} />;
}

function ImportWizard({ canExecute }: { canExecute: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [upload, setUpload] = React.useState<ImportUploadResult | null>(null);
  const [mapping, setMapping] = React.useState<ImportColumnMapping>({});
  const [checked, setChecked] = React.useState<ImportValidationResult | null>(null);
  const [imported, setImported] = React.useState<{
    importedRows: number;
    skippedRows: number;
  } | null>(null);

  const stage = imported ? 3 : checked ? 2 : upload ? 1 : 0;

  const history = useQuery({
    queryKey: ['imports'],
    queryFn: () => api.get<{ items: ImportJobRow[] }>('/imports'),
  });

  const start = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return api.post<ImportUploadResult>('/imports', form);
    },
    onSuccess: (result) => {
      setUpload(result);
      // The server's guess, pre-filled and shown for confirmation — never
      // applied without being looked at. "Reg No" is the old record number in
      // most exports and a referring doctor's registration in some.
      setMapping(result.suggestedMapping);
      setChecked(null);
      setImported(null);
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
    },
    onError: (error) =>
      toast.error(
        'Could not read that file',
        error instanceof ApiError ? error.message : 'Try again in a moment.',
      ),
  });

  const check = useMutation({
    mutationFn: () =>
      api.post<ImportValidationResult>(`/imports/${upload!.job.id}/validate`, {
        columnMapping: mapping,
      }),
    onSuccess: setChecked,
    onError: (error) =>
      toast.error(
        'Could not check the rows',
        error instanceof ApiError ? error.message : undefined,
      ),
  });

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ importedRows: number; skippedRows: number }>(
        `/imports/${upload!.job.id}/commit`,
        {},
      ),
    onSuccess: (result) => {
      setImported(result);
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
      toast.success(
        `${result.importedRows.toLocaleString('en-IN')} patients imported`,
        'They are tagged "imported" so staff know the details were not taken at this desk.',
      );
    },
    onError: (error) =>
      toast.error(
        'Nothing was imported',
        error instanceof ApiError
          ? error.message
          : 'The register is exactly as it was. Nothing partial was written.',
      ),
  });

  const restart = () => {
    setUpload(null);
    setMapping({});
    setChecked(null);
    setImported(null);
  };

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
            description={`A CSV, up to ${IMPORT_MAX_ROWS.toLocaleString('en-IN')} rows at a time.`}
          />
          <PanelBody className="flex flex-col gap-3">
            <Alert tone="info" title="Patient details only">
              Bringing consultations, prescriptions and documents across from an
              old system is bespoke work, quoted separately once we have seen the
              data. A generic importer would be guessing at what a diagnosis field
              meant, and a wrong guess there becomes a clinical record that reads
              as true.
            </Alert>

            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line px-6 py-10 text-center hover:border-accent">
              <Upload className="size-6 text-ink-faint" aria-hidden />
              <span className="text-sm font-medium text-ink">
                {start.isPending ? 'Reading the file…' : 'Choose a CSV file'}
              </span>
              {/*
                The old screen offered .xlsx and .xls, which it could afford to
                because it never opened the file. An Excel workbook is a zip of
                XML with merged cells and multiple sheets; reading one is its own
                piece of work, and the server says so rather than reporting every
                row as broken.
              */}
              <span className="text-2xs text-ink-faint">
                Exported from Excel, choose “CSV UTF-8”. Older encodings are
                detected and reported rather than silently mangled.
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={start.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) start.mutate(file);
                  // Cleared so choosing the same file twice fires again — after
                  // a failure, re-picking the file they just fixed is the first
                  // thing anybody tries.
                  event.target.value = '';
                }}
              />
            </label>
          </PanelBody>
        </Panel>
      ) : null}

      {stage === 1 && upload ? (
        <MapColumns
          upload={upload}
          mapping={mapping}
          onChange={setMapping}
          onBack={restart}
          onContinue={() => check.mutate()}
          checking={check.isPending}
        />
      ) : null}

      {stage === 2 && checked ? (
        <CheckResults
          result={checked}
          canExecute={canExecute}
          committing={commit.isPending}
          onBack={() => setChecked(null)}
          onCommit={() => commit.mutate()}
        />
      ) : null}

      {stage === 3 && imported && checked ? (
        <Panel>
          <PanelHeader
            title="Imported"
            description={`${checked.job.sourceFilename} · ${imported.importedRows.toLocaleString('en-IN')} patients added`}
          />
          <PanelBody className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Figure label="Added" value={imported.importedRows} tone="positive" />
              <Figure
                label="Not imported"
                value={imported.skippedRows}
                tone={imported.skippedRows > 0 ? 'warning' : 'neutral'}
              />
              <Figure label="Rows in the file" value={checked.job.totalRows} />
            </div>

            <Alert tone="info" title="Every imported record is tagged “imported”">
              The spelling, the number and the age came from the old system and
              were not checked at this desk. The tag stays on the record so staff
              know that when a number does not ring.
            </Alert>

            {imported.skippedRows > 0 ? (
              <ProblemDownload jobId={checked.job.id} count={imported.skippedRows} />
            ) : null}

            <div>
              <Button variant="secondary" onClick={restart}>
                Import another file
              </Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader title="Previous imports" />
        <PanelBody>
          {history.isPending ? (
            <Skeleton className="h-20" />
          ) : (history.data?.items ?? []).length === 0 ? (
            <p className="text-xs text-ink-faint">None yet.</p>
          ) : (
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>File</TH>
                    <TH>When</TH>
                    <TH>Who</TH>
                    <TH align="right">Rows</TH>
                    <TH align="right">Imported</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {(history.data?.items ?? []).map((job) => (
                    <TR key={job.id}>
                      <TD className="text-ink">{job.sourceFilename}</TD>
                      <TD className="whitespace-nowrap text-ink-faint">
                        {formatDateTime(job.createdAt)}
                      </TD>
                      <TD className="text-ink-soft">{job.requestedByName ?? '—'}</TD>
                      <TD align="right" className="tabular">
                        {job.totalRows}
                      </TD>
                      <TD align="right" className="tabular">
                        {job.importedRows}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            job.status === 'COMPLETED'
                              ? 'positive'
                              : job.status === 'FAILED'
                                ? 'critical'
                                : 'neutral'
                          }
                        >
                          {/*
                            An abandoned import reads as what it is. Somebody who
                            uploaded a file, saw the problem count and closed the
                            tab left nothing in the register, and the row should
                            not imply otherwise.
                          */}
                          {job.status === 'AWAITING_MAPPING' ||
                          job.status === 'AWAITING_CONFIRMATION'
                            ? 'Not imported'
                            : job.status.toLowerCase()}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

/* --------------------------------------------------------------------------- */

function MapColumns({
  upload,
  mapping,
  onChange,
  onBack,
  onContinue,
  checking,
}: {
  upload: ImportUploadResult;
  mapping: ImportColumnMapping;
  onChange: (mapping: ImportColumnMapping) => void;
  onBack: () => void;
  onContinue: () => void;
  checking: boolean;
}) {
  const columns = upload.job.columns;
  const used = Object.values(mapping).filter(Boolean);
  const missingRequired = IMPORT_TARGET_FIELDS.filter(
    (field) => field.required && !used.includes(field.field),
  );

  return (
    <Panel>
      <PanelHeader
        title="Match the columns"
        description={`${upload.job.sourceFilename} · ${upload.job.totalRows.toLocaleString('en-IN')} rows · ${columns.length} columns`}
      />
      <PanelBody className="flex flex-col gap-4">
        {/*
          Reported rather than silently handled. A file exported from an older
          desktop system is usually CP1252, and the place it shows is a name with
          an accent or an apostrophe — which the clinic is the only one who can
          confirm looks right.
        */}
        {upload.decodedAs === 'windows-1252' ? (
          <Alert tone="warning" title="This file is not UTF-8">
            It has been read as Windows-1252, which is what older systems export.
            Check the sample rows below — if a name with an accent or an
            apostrophe looks wrong, re-export it as CSV UTF-8 instead.
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3">
          {columns.map((column) => (
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
                value={mapping[column] ?? ''}
                onChange={(event) =>
                  onChange({ ...mapping, [column]: event.target.value })
                }
              >
                <option value="">Do not import this column</option>
                {IMPORT_TARGET_FIELDS.map((field) => (
                  <option
                    key={field.field}
                    value={field.field}
                    // One field per column. Taking whichever comes last would
                    // write one column into the register and discard the other
                    // without saying which.
                    disabled={
                      used.includes(field.field) && mapping[column] !== field.field
                    }
                  >
                    {field.label}
                    {field.required ? ' (required)' : ''}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>

        {missingRequired.length > 0 ? (
          <Alert
            tone="warning"
            title={`Which column holds the ${missingRequired
              .map((field) => field.label.toLowerCase())
              .join(' and the ')}?`}
          >
            A patient record cannot be created without it.
          </Alert>
        ) : null}

        {/*
          The first three rows, as they were actually read. This is the check
          that catches a mapping that is wrong in a way the headings do not
          reveal — a date column holding "34" because the old system put age
          there, or a name column holding a record number.
        */}
        {upload.sampleRows.length > 0 ? (
          <div>
            <p className="mb-1.5 text-2xs uppercase tracking-wide text-ink-faint">
              The first rows, as read from your file
            </p>
            <TableScroller className="rounded-lg border border-line">
              <Table>
                <THead>
                  <TR>
                    {columns.map((column) => (
                      <TH key={column}>
                        {column}
                        {mapping[column] ? (
                          <span className="ml-1 font-normal normal-case text-accent-ink">
                            →{' '}
                            {
                              IMPORT_TARGET_FIELDS.find((f) => f.field === mapping[column])
                                ?.label
                            }
                          </span>
                        ) : (
                          <span className="ml-1 font-normal normal-case text-ink-faint">
                            skipped
                          </span>
                        )}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {upload.sampleRows.map((row, index) => (
                    <TR key={index}>
                      {columns.map((column) => (
                        <TD key={column}>{row[column] ?? ''}</TD>
                      ))}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          </div>
        ) : null}

        <p className="text-2xs text-ink-faint">
          A column you skip is not imported. Nothing has been written to the
          register yet — checking the rows does not change anything either.
        </p>
      </PanelBody>

      <div className="flex justify-between border-t border-line-soft px-4 py-3">
        <Button variant="ghost" onClick={onBack}>
          Choose a different file
        </Button>
        <Button
          variant="primary"
          disabled={missingRequired.length > 0}
          loading={checking}
          onClick={onContinue}
        >
          Check the rows
        </Button>
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------------------- */

const KIND_LABEL: Record<ImportRowProblem['kind'], string> = {
  INVALID: 'Will not import',
  ALREADY_REGISTERED: 'Already in the register',
  DUPLICATE_IN_FILE: 'Check this',
};

function CheckResults({
  result,
  canExecute,
  committing,
  onBack,
  onCommit,
}: {
  result: ImportValidationResult;
  canExecute: boolean;
  committing: boolean;
  onBack: () => void;
  onCommit: () => void;
}) {
  const { job, problems } = result;

  return (
    <Panel>
      <PanelHeader
        title="Check results"
        description="Nothing has been imported yet."
      />
      <PanelBody className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Rows read" value={job.totalRows} />
          <Figure label="Ready" value={job.validRows} tone="positive" />
          <Figure
            label="Flagged"
            value={job.duplicateRows}
            tone={job.duplicateRows > 0 ? 'warning' : 'neutral'}
          />
          <Figure
            label="Problems"
            value={job.errorRows}
            tone={job.errorRows > 0 ? 'critical' : 'neutral'}
          />
        </div>

        {job.errorRows > 0 ? (
          <Alert
            tone="warning"
            title={`${job.errorRows.toLocaleString('en-IN')} ${job.errorRows === 1 ? 'row' : 'rows'} will not be imported`}
          >
            Download the list, correct it in your own file, and upload again.
            Nothing is dropped without telling you why.
          </Alert>
        ) : null}

        {job.validRows === 0 ? (
          <Alert tone="critical" title="There is nothing to import">
            Every row either has a problem or is already in the register.
          </Alert>
        ) : null}

        {problems.length > 0 ? (
          <div>
            <p className="mb-1.5 text-2xs uppercase tracking-wide text-ink-faint">
              {result.problemsTruncated
                ? `The first ${problems.length} — the download has every one`
                : 'What needs attention'}
            </p>
            <TableScroller className="max-h-72 rounded-lg border border-line">
              <Table>
                <THead>
                  <TR>
                    <TH align="right">Row</TH>
                    <TH>Who</TH>
                    <TH>What</TH>
                    <TH>Outcome</TH>
                  </TR>
                </THead>
                <TBody>
                  {problems.map((problem, index) => (
                    <TR key={`${problem.rowNumber}-${index}`}>
                      <TD align="right" className="tabular">
                        {problem.rowNumber}
                      </TD>
                      <TD className="text-ink">{problem.label}</TD>
                      <TD className="text-ink-soft">{problem.message}</TD>
                      <TD>
                        <Badge
                          tone={problem.kind === 'INVALID' ? 'critical' : 'warning'}
                        >
                          {KIND_LABEL[problem.kind]}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {job.errorRows + job.duplicateRows > 0 ? (
            <ProblemDownload
              jobId={job.id}
              count={job.errorRows + job.duplicateRows}
            />
          ) : null}
        </div>

        {/*
          Said at the moment of committing, because it is the only step that
          changes anything and the only one that cannot be undone by closing the
          tab. A merge screen exists for records that turn out to be the same
          person, but it is work somebody has to do by hand afterwards.
        */}
        {job.validRows > 0 ? (
          <Alert
            tone={job.duplicateRows > 0 ? 'warning' : 'info'}
            title={`${job.validRows.toLocaleString('en-IN')} patients will be added to the register`}
          >
            In one go — either all of them land or none do. Undoing it afterwards
            means merging records by hand.
          </Alert>
        ) : null}

        {!canExecute && job.validRows > 0 ? (
          <Alert tone="info" title="Someone with import rights has to finish this">
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="size-3.5" aria-hidden />
              You can prepare and check an import; committing it is a separate
              permission.
            </span>
          </Alert>
        ) : null}
      </PanelBody>

      <div className="flex justify-between border-t border-line-soft px-4 py-3">
        <Button variant="ghost" onClick={onBack}>
          Back to the columns
        </Button>
        <Button
          variant="primary"
          disabled={job.validRows === 0 || !canExecute}
          loading={committing}
          onClick={onCommit}
        >
          Import {job.validRows.toLocaleString('en-IN')}{' '}
          {job.validRows === 1 ? 'patient' : 'patients'}
        </Button>
      </div>
    </Panel>
  );
}

/**
 * The problem report.
 *
 * A real download of a real file: the clinic's own columns beside the reason, so
 * they fix the rows in the spreadsheet they exported rather than transcribing
 * from a list of row numbers.
 *
 * A plain anchor, the same way a document downloads. The route streams the file
 * and sets its own `Content-Disposition`, so fetching it into a blob to trigger
 * a click would add a copy in memory and a URL to revoke, and take the filename
 * away from the server that knows it.
 */
function ProblemDownload({ jobId, count }: { jobId: string; count: number }) {
  return (
    <Button variant="secondary" asChild>
      <a href={`/api/imports/${jobId}/problems`}>
        <Download aria-hidden />
        Download the {count.toLocaleString('en-IN')} flagged{' '}
        {count === 1 ? 'row' : 'rows'}
      </a>
    </Button>
  );
}

function Figure({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
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
      <p className={cn('mt-0.5 text-xl font-semibold tabular', colour)}>
        {value.toLocaleString('en-IN')}
      </p>
    </div>
  );
}
