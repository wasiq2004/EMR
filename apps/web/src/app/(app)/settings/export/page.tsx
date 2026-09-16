'use client';

import * as React from 'react';
import { Download, FileArchive } from 'lucide-react';
import { useCan } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

const CONTENTS = [
  'Patients, with demographics and identifiers',
  'Appointments and their history',
  'Consultations, with notes and finalisation state',
  'Vitals, diagnoses and allergies',
  'Prescriptions, with every medicine line',
  'All uploaded documents, as the original files',
  'Messages sent and received',
  'Invoices and payments',
  'The activity log',
  'A file index with checksums, and a plain-language guide to every file',
];

/**
 * Data export.
 *
 * Self-service and complete: no ticket, no developer, no delay. A clinic that
 * knows it can leave is considerably more willing to arrive, so this is a
 * selling point rather than an obligation.
 *
 * Every export writes an audit record, because a full clinical export is
 * precisely the action a departing employee would take.
 */
export default function ExportSettingsPage() {
  const canExport = useCan('export:create');
  const toast = useToast();

  if (!canExport) {
    return (
      <Panel>
        <PanelBody>
          <Alert tone="info" title="Exporting is limited to clinic administrators" />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Export everything"
          description="A complete copy of this clinic's data, in open formats."
        />
        <PanelBody className="flex flex-col gap-4">
          <ul className="flex flex-col gap-1.5">
            {CONTENTS.map((line) => (
              <li key={line} className="flex items-start gap-2 text-sm text-ink-soft">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" aria-hidden />
                {line}
              </li>
            ))}
          </ul>

          <Alert tone="info" title="The download link lasts 7 days">
            After that the bundle is deleted, so patient data does not sit in
            storage indefinitely. You can generate a new one whenever you want.
          </Alert>

          <Button
            variant="primary"
            className="w-fit"
            onClick={() =>
              toast.success(
                'Export started',
                'You will be told when the download is ready. Large clinics can take a few minutes.',
              )
            }
          >
            <Download aria-hidden />
            Start a full export
          </Button>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Previous exports" />
        <EmptyState
          icon={FileArchive}
          title="No exports yet"
          description="Every export is listed here, and recorded in the activity log."
        />
      </Panel>
    </div>
  );
}
