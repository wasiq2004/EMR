'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, FilePlus2 } from 'lucide-react';
import { useEncounter } from '@/features/encounter/api';
import { usePatient } from '@/features/patients/api';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PageHeader } from '@/components/ui/surface';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * Amending a finalised consultation.
 *
 * Corrections append; they never overwrite. This creates a NEW record linked to
 * the original, and the original is shown alongside, read-only, so the person
 * writing the amendment can see exactly what they are correcting.
 *
 * The database enforces this too — a trigger rejects edits to a finalised
 * encounter — so the rule survives a refactor of this screen.
 */
export default function AmendEncounterPage() {
  const params = useParams<{ id: string }>();
  const encounterId = params.id;
  const router = useRouter();
  const toast = useToast();

  const encounter = useEncounter(encounterId);
  const patient = usePatient(encounter.data?.patientId ?? '');

  const [reason, setReason] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [touched, setTouched] = React.useState(false);

  const valid = reason.trim().length >= 8;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) {
      setTouched(true);
      return;
    }
    setSaving(true);
    try {
      const amendment = await api.post<{ id: string }>(
        `/encounters/${encounterId}/amend`,
        { amendmentReason: reason.trim() },
      );
      toast.success(
        'Amendment created',
        'The original record is unchanged and remains linked to this one.',
      );
      router.push(`/encounters/${amendment.id}`);
    } catch {
      toast.error('Could not create the amendment', 'Try again in a moment.');
    } finally {
      setSaving(false);
    }
  };

  if (encounter.isLoading || !encounter.data) {
    return <Skeleton className="mx-auto h-96 max-w-3xl" />;
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        href={`/encounters/${encounterId}`}
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to the consultation
      </Link>

      <PageHeader
        title="Amend this consultation"
        description={`${patient.data?.fullName ?? 'Patient'} · consultation of ${formatDate(encounter.data.startedAt)}`}
      />

      <Alert tone="info" title="The original record will not change">
        An amendment is a new, linked record. Anyone reading the history will see
        both the original and your correction, in order — which is what makes the
        record usable as evidence.
      </Alert>

      <Panel>
        <PanelHeader
          title="What the original says"
          description="Read-only. This is the record you are correcting."
        />
        <PanelBody className="flex flex-col gap-3 text-sm">
          <Detail label="Presenting complaint" value={encounter.data.chiefComplaint} />
          <Detail label="Examination" value={encounter.data.examinationNotes} />
          <Detail label="Assessment" value={encounter.data.assessmentNotes} />
          <Detail label="Plan" value={encounter.data.planNotes} />
        </PanelBody>
      </Panel>

      <form onSubmit={submit}>
        <Panel>
          <PanelHeader title="Why is this being corrected?" />
          <PanelBody>
            <Field
              label="Reason for the amendment"
              htmlFor="amendmentReason"
              required
              hint="Visible to anyone who reads this patient's history, including in a later clinical review."
              error={
                touched && !valid
                  ? 'Write at least a short sentence explaining the correction.'
                  : undefined
              }
            >
              <Textarea
                rows={4}
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Dosage recorded as 500 mg; the prescription issued was 250 mg. Correcting the record to match."
              />
            </Field>
          </PanelBody>
        </Panel>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" asChild>
            <Link href={`/encounters/${encounterId}`}>Cancel</Link>
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!valid}>
            <FilePlus2 aria-hidden />
            Create amendment
          </Button>
        </div>
      </form>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-0.5 whitespace-pre-line text-ink">
        {value ?? <span className="text-ink-faint">Not recorded</span>}
      </p>
    </div>
  );
}
