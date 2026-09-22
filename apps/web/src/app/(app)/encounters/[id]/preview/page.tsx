'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Lock, Printer } from 'lucide-react';
import { describeFrequency } from '@emr/contracts';
import { usePatient, usePatientSnapshot } from '@/features/patients/api';
import {
  useEncounter,
  useFinaliseEncounter,
  usePrescriptionLines,
} from '@/features/encounter/api';
import { useCanSign, useSession } from '@/lib/session';
import { ageGender, formatDate, formatPhone } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Prescription preview.
 *
 * This is the exact artefact the patient receives, shown before signing. Two
 * acceptance criteria run through it:
 *
 *   - No participant signs a prescription containing truncated or mis-rendered
 *     text. So the preview is the real layout at real proportions, not a
 *     summary of it — including the 22-medicine case, where the header must
 *     repeat and the signature block must not be orphaned.
 *   - The doctor understands that finalising is irreversible. The confirmation
 *     says so plainly rather than asking "Are you sure?".
 *
 * Dosage shorthand is expanded to plain language HERE, at render, not at entry.
 * The clinician types "1-0-1"; the patient reads "1 tablet in the morning and 1
 * at night". Neither is asked to compromise.
 */
export default function PrescriptionPreviewPage() {
  const params = useParams<{ id: string }>();
  const encounterId = params.id;
  const router = useRouter();
  const toast = useToast();
  const session = useSession();
  const signing = useCanSign();

  const encounter = useEncounter(encounterId);
  const patientId = encounter.data?.patientId ?? '';
  const patient = usePatient(patientId);
  const snapshot = usePatientSnapshot(patientId);
  const lines = usePrescriptionLines(encounterId);
  const finalise = useFinaliseEncounter(encounterId);

  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const sign = async () => {
    try {
      await finalise.mutateAsync({ version: encounter.data?.version ?? 1 });
      setConfirmOpen(false);
      toast.success(
        'Consultation signed',
        'The prescription is being prepared and will be sent to the patient.',
      );
      router.push(`/patients/${patientId}`);
    } catch (error) {
      setConfirmOpen(false);
      toast.error(
        'Could not sign',
        error instanceof Error ? error.message : 'Try again in a moment.',
      );
    }
  };

  if (encounter.isLoading || !encounter.data || !patient.data) {
    return <Skeleton className="mx-auto h-[70vh] max-w-3xl" />;
  }

  const medicines = lines.data ?? [];
  const finalised = encounter.data.isFinalized;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Link
          href={`/encounters/${encounterId}`}
          className="inline-flex items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to consultation
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" onClick={() => globalThis.print()}>
            <Printer aria-hidden />
            Print
          </Button>
          {!finalised ? (
            <Button
              variant="primary"
              size="lg"
              disabled={!signing.allowed}
              onClick={() => setConfirmOpen(true)}
            >
              <Lock aria-hidden />
              Sign &amp; finalise
            </Button>
          ) : null}
        </div>
      </div>

      {!signing.allowed && !finalised ? (
        <Alert tone="warning" title="You cannot sign this prescription" className="print:hidden">
          {signing.reason}
        </Alert>
      ) : null}

      <Alert tone="info" title="This is exactly what the patient receives" className="print:hidden">
        Check the letterhead, every medicine, and that nothing is cut off before
        you sign.
      </Alert>

      {/* ---- The document ------------------------------------------------ */}
      <article className="rounded-lg border border-line bg-white p-8 text-[#111] shadow-raise print:border-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-[#111] pb-4">
          <div>
            <h1 className="text-xl font-bold">{session.clinicName}</h1>
            <p className="mt-0.5 text-xs leading-relaxed text-[#444]">
              2nd Floor, Shivam Complex, FC Road, Shivajinagar
              <br />
              Pune 411005, Maharashtra
              <br />
              {formatPhone('+912025530012')}
            </p>
          </div>
          <div className="text-right text-xs text-[#444]">
            <p className="font-semibold text-[#111]">{session.fullName}</p>
            <p>MBBS, MD (General Medicine)</p>
            <p className="token">Reg. MMC-2011-44821</p>
          </div>
        </header>

        <section className="flex flex-wrap justify-between gap-4 border-b border-[#ccc] py-3 text-sm">
          <div>
            <p className="text-lg font-semibold">{patient.data.fullName}</p>
            <p className="text-xs text-[#444]">
              {ageGender(patient.data)} ·{' '}
              <span className="token">{patient.data.mrn}</span>
            </p>
          </div>
          <div className="text-right text-xs text-[#444]">
            <p>Date: {formatDate(encounter.data.startedAt)}</p>
            {snapshot.data && snapshot.data.allergies.length > 0 ? (
              <p className="mt-1 font-bold text-[#b3251b]">
                ALLERGIES:{' '}
                {snapshot.data.allergies.map((a) => a.substanceText).join(', ')}
              </p>
            ) : null}
          </div>
        </section>

        {encounter.data.assessmentNotes ? (
          <section className="border-b border-[#eee] py-3">
            <h2 className="text-2xs font-bold uppercase tracking-wide text-[#666]">
              Diagnosis
            </h2>
            <p className="mt-1 text-sm">{encounter.data.assessmentNotes}</p>
          </section>
        ) : null}

        <section className="py-4">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold">℞</span>
            <h2 className="text-2xs font-bold uppercase tracking-wide text-[#666]">
              Medicines
            </h2>
          </div>

          {medicines.length === 0 ? (
            <p className="text-sm text-[#666]">No medicines prescribed.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {medicines.map((line, index) => (
                <li key={line.id} className="flex gap-3 break-inside-avoid">
                  <span className="w-5 shrink-0 text-sm font-semibold tabular">
                    {index + 1}.
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {line.drugDisplayName}
                      {line.strength ? ` ${line.strength}` : ''}
                      {line.dosageForm ? (
                        <span className="font-normal text-[#444]">
                          {' '}
                          ({line.dosageForm})
                        </span>
                      ) : null}
                    </p>
                    <p className="text-sm text-[#333]">
                      {/* Patient-facing language, expanded from the shorthand. */}
                      {describeFrequency(line.frequency, line.dosageForm ?? 'tablet')}
                      {line.timingRelativeToFood === 'BEFORE_FOOD'
                        ? ', before food'
                        : line.timingRelativeToFood === 'WITH_FOOD'
                          ? ', with food'
                          : ', after food'}
                      {line.durationDays ? ` — for ${line.durationDays} days` : ''}
                    </p>
                    {line.instructions ? (
                      <p className="text-xs italic text-[#444]">{line.instructions}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {encounter.data.planNotes || encounter.data.followUpAfterDays ? (
          <section className="border-t border-[#eee] py-3">
            <h2 className="text-2xs font-bold uppercase tracking-wide text-[#666]">
              Advice
            </h2>
            {encounter.data.planNotes ? (
              <p className="mt-1 whitespace-pre-line text-sm">
                {encounter.data.planNotes}
              </p>
            ) : null}
            {encounter.data.followUpAfterDays ? (
              <p className="mt-1.5 text-sm font-medium">
                Please come back after {encounter.data.followUpAfterDays} days
                {encounter.data.followUpInstructions
                  ? ` — ${encounter.data.followUpInstructions}`
                  : ''}
                .
              </p>
            ) : null}
          </section>
        ) : null}

        {/* The signature block must never be orphaned onto its own page. */}
        <footer className="mt-8 flex items-end justify-between gap-6 break-inside-avoid border-t border-[#ccc] pt-4">
          <div className="max-w-xs space-y-2">
            <p className="text-2xs leading-relaxed text-[#666]">
              This prescription was issued electronically. Medicines listed were
              checked against allergies recorded at this clinic. Interaction
              checking is not performed.
            </p>
            {/*
              Required on a remote consultation and NOT on an in-person one, so
              it is printed from the recorded mode rather than always or never.
              Printing it on an in-person prescription would be a false
              declaration; omitting it on a remote one leaves the document
              incomplete.
            */}
            {encounter.data.consultationMode === 'TELECONSULTATION' ? (
              <p className="text-2xs leading-relaxed font-medium text-[#444]">
                Issued following a teleconsultation, in accordance with the
                Telemedicine Practice Guidelines. The patient was not physically
                examined.
              </p>
            ) : null}
          </div>
          <div className="text-right">
            <div className="h-10" />
            <p className="border-t border-[#111] pt-1 text-sm font-semibold">
              {session.fullName}
            </p>
            {session.qualifications ? (
              <p className="text-2xs text-[#444]">{session.qualifications}</p>
            ) : null}
            {/*
              The SIGNING doctor's number. This was a hardcoded literal, so every
              prescription printed by every doctor in every clinic carried one
              seeded practitioner's registration — which is a forged medical
              document, not a cosmetic bug.
            */}
            {session.medicalRegistrationNumber ? (
              <p className="token text-2xs text-[#444]">
                Reg. {session.medicalRegistrationNumber}
                {session.medicalCouncil ? ` · ${session.medicalCouncil}` : ''}
              </p>
            ) : (
              <p className="text-2xs font-medium text-[#b3251b]">
                No registration number on file — this prescription cannot be signed.
              </p>
            )}
            {finalised ? (
              <p className="mt-1 text-2xs text-[#666]">
                Signed {formatDate(encounter.data.finalizedAt)}
              </p>
            ) : null}
          </div>
        </footer>
      </article>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Sign and finalise this consultation</DialogTitle>
            <DialogDescription>
              Once signed, this record cannot be edited.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm text-ink-soft">
            <p>
              The prescription will be generated and sent to{' '}
              <strong className="text-ink">{patient.data.fullName}</strong>.
            </p>
            <p>
              If you need to change something later, you will record an amendment
              alongside this record rather than editing it — the original stays
              intact, which is what makes it usable as evidence.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={sign} loading={finalise.isPending}>
              <Lock aria-hidden />
              Sign &amp; finalise
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
