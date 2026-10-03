'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Building2,
  Copy,
  Eye,
  Lock,
  Receipt,
  Thermometer,
  Trash2,
  Video,
} from 'lucide-react';
import type {
  Allergy,
  ConsultationMode,
  DrugCatalogueItem,
  EncounterDraft,
  MedicationRequest,
  SafetyWarning,
} from '@emr/contracts';
import { CONSULTATION_MODE_LABEL } from '@emr/contracts';
import { usePatient, usePatientSnapshot } from '@/features/patients/api';
import { RecordVitalsDialog } from '@/features/patients/record-vitals-dialog';
import { useReminderSettings } from '@/features/reminders/api';
import { OrderTestPanel } from '@/features/lab/order-test-panel';
import { VitalsGrid } from '@/features/patients/vitals-grid';
import { AllergyBanner } from '@/features/patients/allergy-banner';
import { DiagnosisCombobox } from '@/features/encounter/diagnosis-combobox';
import { DrugCombobox } from '@/features/encounter/drug-combobox';
import {
  DosageDialog,
  type DosageChoice,
} from '@/features/encounter/dosage-dialog';
import { SafetyWarningDialog } from '@/features/encounter/safety-warning-dialog';
import {
  useAddDiagnosis,
  useAddInternalNote,
  useAddPrescriptionLine,
  useEncounter,
  useEncounterAutosave,
  useSetConsultationMode,
  useInternalNotes,
  usePrescriptionLines,
  useRemovePrescriptionLine,
  useReviseDosage,
} from '@/features/encounter/api';
import { api } from '@/lib/api-client';
import { checkPrescription, requiresAcknowledgement } from '@/lib/safety';
import { useCan, useCanSign, useSession } from '@/lib/session';
import { ageGender, formatDate, formatPaise } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, SaveState, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * ======================= THE CONSULTATION SCREEN ===========================
 *
 * The highest-risk screen in the product. The stated business risk is blunt: a
 * doctor who finds this slower than a paper pad abandons the product in week
 * two, and no amount of correct multi-tenancy compensates.
 *
 * The acceptance targets it has to hit: consultation plus prescription in under
 * four minutes, each additional medicine in under twenty seconds, and eighty
 * per cent of steps completed with no help.
 *
 * Design rules, all of which exist to serve those numbers:
 *   - ONE SCREEN. No wizard, no stacked modals. The only modal is the safety
 *     warning, where interrupting is the point.
 *   - Allergies stay visible the whole time, not just on the Snapshot.
 *   - Free text everywhere. Diagnoses save without a code. Medicines save
 *     without being in the catalogue.
 *   - Autosave every three seconds, with the save state always on screen.
 *   - Previous visit is one click to copy forward — templates and copy-forward
 *     are the difference between typing and confirming.
 * ===========================================================================
 */
export default function ConsultationPage() {
  const params = useParams<{ id: string }>();
  const encounterId = params.id;
  const toast = useToast();
  const session = useSession();

  const encounter = useEncounter(encounterId);
  const patientId = encounter.data?.patientId ?? '';
  const canBill = useCan('invoice:create');

  /*
   * Read only once the consultation is signed. Before that there is nothing to
   * bill and the request would be answered for every keystroke of autosave.
   */
  const billing = useQuery({
    queryKey: ['encounter-billing', encounterId],
    queryFn: () =>
      api.get<{
        invoiceId: string | null;
        invoiceNumber: string | null;
        totalPaise: number;
        paidPaise: number;
        outstandingPaise: number;
      }>(`/invoices/for-encounter/${encounterId}`),
    enabled: Boolean(encounterId) && (encounter.data?.isFinalized ?? false),
  });
  const patient = usePatient(patientId);
  const snapshot = usePatientSnapshot(patientId);
  const lines = usePrescriptionLines(encounterId);
  const notes = useInternalNotes(encounterId);

  const addLine = useAddPrescriptionLine(encounterId);
  const removeLine = useRemovePrescriptionLine(encounterId);
  const reviseDosage = useReviseDosage(encounterId);
  const addDiagnosis = useAddDiagnosis(encounterId, patientId);
  const addNote = useAddInternalNote(encounterId);

  const canWriteClinical = useCan('encounterClinicalContent:update');
  const canWriteNotes = useCan('internalNote:create');
  const canPrescribe = useCan('prescription:create');
  const canRecordVitals = useCan('observation:create');
  const signing = useCanSign();

  const initialDraft: EncounterDraft | null = React.useMemo(() => {
    if (!encounter.data) return null;
    const e = encounter.data;
    return {
      chiefComplaint: e.chiefComplaint,
      historyOfPresentIllness: e.historyOfPresentIllness,
      examinationNotes: e.examinationNotes,
      assessmentNotes: e.assessmentNotes,
      planNotes: e.planNotes,
      followUpAfterDays: e.followUpAfterDays,
      followUpInstructions: e.followUpInstructions,
    };
  }, [encounter.data]);

  const setMode = useSetConsultationMode(encounterId);
  const autosave = useEncounterAutosave(
    encounterId,
    initialDraft,
    encounter.data?.version ?? 1,
  );

  const [vitalsOpen, setVitalsOpen] = React.useState(false);
  const [pendingDrug, setPendingDrug] = React.useState<{
    name: string;
    molecule: string | null;
    drug: DrugCatalogueItem | null;
    warnings: SafetyWarning[];
  } | null>(null);
  /*
   * A drug that has cleared safety and is waiting for its dose.
   *
   * Separate state from `pendingDrug`, which is a drug waiting for a safety
   * acknowledgement. The two are sequential and must not be merged: a doctor
   * overriding an allergy warning should answer that question on its own, then
   * be asked the dose — not have both dialogs fighting over the same screen.
   */
  const [dosing, setDosing] = React.useState<{
    name: string;
    molecule: string | null;
    drug: DrugCatalogueItem | null;
    warnings: SafetyWarning[];
    overrideReason: string | null;
  } | null>(null);
  /** A line whose dose is being changed, as opposed to a new drug being added. */
  const [editingLine, setEditingLine] = React.useState<MedicationRequest | null>(null);

  /*
   * What the follow-up field is going to do, in words.
   *
   * Reminders are scheduled at SIGNING, not while this autosaves — editing the
   * number must not create and cancel reminders as the doctor thinks. So the
   * wording is future tense until the consultation is signed.
   */
  const reminderSettings = useReminderSettings();
  const followUpDays = autosave.draft?.followUpAfterDays ?? null;
  const followUpHint = (() => {
    if (!followUpDays || followUpDays < 1) return 'Optional. Printed on the prescription.';
    if (!reminderSettings.data) return 'Printed on the prescription.';
    if (!reminderSettings.data.followUpEnabled) {
      // Named plainly rather than left blank: the doctor should not assume a
      // reminder will go out when the clinic has them off.
      return 'Printed on the prescription. No reminder — this clinic has follow-up reminders switched off.';
    }
    const lead = reminderSettings.data.leadTimeDays;
    const when = new Date();
    when.setDate(when.getDate() + followUpDays - lead);
    return `A WhatsApp reminder will be scheduled for ${when.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    })} when you sign this, if the patient has consented.`;
  })();

  const canOrderLabs = useCan('labOrder:create');
  const allergies: Allergy[] = snapshot.data?.allergies ?? [];
  const finalised = encounter.data?.isFinalized ?? false;
  const readOnly = finalised || !canWriteClinical;

  /* --- Prescribing ----------------------------------------------------- */

  const considerDrug = (name: string, molecule: string | null, drug: DrugCatalogueItem | null) => {
    const warnings = checkPrescription(
      { drugDisplayName: name, moleculeName: molecule, drugSchedule: drug?.drugSchedule },
      {
        allergies,
        existingLines: (lines.data ?? []).map((line) => ({
          catalogueItemId: line.catalogueItemId,
          drugDisplayName: line.drugDisplayName,
          moleculeName: line.moleculeName,
          strength: line.strength,
          dosageForm: line.dosageForm,
          route: line.route,
          frequency: line.frequency,
          timingRelativeToFood: line.timingRelativeToFood,
          durationDays: line.durationDays,
          quantity: line.quantity,
          instructions: line.instructions,
          safetyWarningsShown: [],
          safetyOverrideReason: null,
        })),
        /*
         * The REAL mode, not a hardcoded false.
         *
         * Schedule X may not be prescribed by telemedicine, and the server
         * enforces that from the encounter's own `consultationMode`. Passing
         * false here meant the client pre-check never raised the warning, so a
         * doctor in a teleconsultation chose a Schedule X drug, filled in the
         * dose, pressed save, and only then got a 422 from the server — with
         * the dialog that explains why never appearing. The check was right;
         * the input to it was a lie.
         */
        isTeleconsultation: encounter.data?.consultationMode === 'TELECONSULTATION',
      },
    );

    if (requiresAcknowledgement(warnings)) {
      setPendingDrug({ name, molecule, drug, warnings });
      return;
    }
    setDosing({ name, molecule, drug, warnings, overrideReason: null });
  };

  /**
   * Writes the line, with the dose the prescriber actually chose.
   *
   * This used to hardcode `frequency: '1-0-1'`, `timingRelativeToFood:
   * 'AFTER_FOOD'` and `durationDays: 5` for every drug, whatever the doctor
   * intended, and the panel then displayed those three values back as read-only
   * chips with no way to change them — so a patient could leave with a printed
   * prescription saying twice a day after food for five days for a drug meant
   * once at night for three. Every field was already in the contract and the
   * table. Nothing was asking.
   */
  const commitLine = async (
    name: string,
    molecule: string | null,
    drug: DrugCatalogueItem | null,
    warnings: SafetyWarning[],
    overrideReason: string | null,
    dose: DosageChoice,
  ) => {
    await addLine.mutateAsync({
      catalogueItemId: drug?.id ?? null,
      drugDisplayName: name,
      moleculeName: molecule,
      strength: drug?.strength ?? null,
      dosageForm: drug?.dosageForm ?? null,
      route: dose.route,
      frequency: dose.frequency,
      timingRelativeToFood: dose.timingRelativeToFood,
      durationDays: dose.durationDays,
      quantity: dose.quantity,
      instructions: dose.instructions,
      safetyWarningsShown: warnings,
      safetyOverrideReason: overrideReason,
    });
    setPendingDrug(null);
    setDosing(null);
  };

  /* --- Copy forward ----------------------------------------------------- */

  const previousVisit = snapshot.data?.recentEncounters.find((v) => v.id !== encounterId);

  const copyForward = () => {
    if (!previousVisit) return;
    autosave.update({
      chiefComplaint: previousVisit.chiefComplaint ?? autosave.draft?.chiefComplaint ?? null,
    });
    toast.success(
      'Copied from the last visit',
      'Everything is editable — nothing has been carried over as a current fact.',
    );
  };

  if (encounter.isLoading || !encounter.data || !patient.data) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      {/* Identity bar — never scrolls away from the doctor's context. */}
      <div className="sticky top-14 z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-canvas/95 px-4 py-2 backdrop-blur lg:-mx-6 lg:px-6">
        <Link
          href={`/patients/${patientId}`}
          className="inline-flex items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Record
        </Link>
        <h1 className="text-lg font-semibold text-ink">{patient.data.fullName}</h1>
        <span className="text-sm text-ink-soft">{ageGender(patient.data)}</span>
        <span className="token text-2xs text-ink-faint">{patient.data.mrn}</span>
        {finalised ? (
          <Badge tone="positive">
            <Lock aria-hidden />
            Signed {formatDate(encounter.data.finalizedAt)}
          </Badge>
        ) : null}
        <ConsultationModeControl
          mode={encounter.data.consultationMode}
          finalised={finalised}
          pending={setMode.isPending}
          onChange={(mode) =>
            setMode.mutate({ mode, version: encounter.data!.version })
          }
        />
        <div className="ml-auto flex items-center gap-3">
          {!finalised ? (
            <SaveState state={autosave.state} savedAt={autosave.savedAt} />
          ) : null}
          {!finalised && canPrescribe ? (
            <Button variant="primary" asChild>
              <Link href={`/encounters/${encounterId}/preview`}>
                <Eye aria-hidden />
                Preview &amp; sign
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {autosave.recovered && !finalised ? (
        <Alert
          tone="warning"
          title="There is an unsent draft of this note on this device"
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={autosave.applyRecovered}>
                Restore it
              </Button>
              <Button size="sm" variant="ghost" onClick={autosave.discardRecovered}>
                Discard
              </Button>
            </div>
          }
        >
          It was saved here but never reached the server, probably because the
          connection dropped.
        </Alert>
      ) : null}

      {finalised ? (
        <>
          <Alert tone="info" title="This consultation is signed and cannot be edited">
            Corrections are recorded as a separate amendment linked to this record,
            so the original stays intact.{' '}
            <Link href={`/encounters/${encounterId}/amend`} className="font-medium underline">
              Create an amendment
            </Link>
          </Alert>

          {/*
            BILLING, OFFERED AT THE MOMENT IT IS OWED.
            
            Shown only once signed, because a consultation still being written is
            not yet a chargeable thing — and offering to bill mid-sentence invites
            an invoice for a visit that then changes. The invoice carries this
            encounter's id, which is what lets check-out tell the front desk
            whether the visit was billed at all.
          */}
          {canBill ? (
            <Panel>
              <PanelBody className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {billing.data?.invoiceId
                      ? `Invoice ${billing.data.invoiceNumber}`
                      : 'Not billed yet'}
                  </p>
                  <p className="mt-0.5 text-2xs text-ink-faint">
                    {billing.data?.invoiceId
                      ? billing.data.outstandingPaise > 0
                        ? `${formatPaise(billing.data.outstandingPaise)} outstanding of ${formatPaise(billing.data.totalPaise)}`
                        : `${formatPaise(billing.data.totalPaise)} settled in full`
                      : 'Raise the invoice before the patient leaves the desk.'}
                  </p>
                </div>

                <Button variant={billing.data?.invoiceId ? 'secondary' : 'primary'} asChild>
                  <Link
                    href={
                      billing.data?.invoiceId
                        ? `/billing/invoices/${billing.data.invoiceId}`
                        : `/billing/invoices/new?patientId=${patientId}&encounterId=${encounterId}`
                    }
                  >
                    <Receipt aria-hidden />
                    {billing.data?.invoiceId ? 'Open invoice' : 'Raise an invoice'}
                  </Link>
                </Button>
              </PanelBody>
            </Panel>
          ) : null}
        </>
      ) : null}

      <AllergyBanner allergies={allergies} />

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* --- Narrative -------------------------------------------------- */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader
              title="Consultation"
              actions={
                !readOnly && previousVisit ? (
                  <Button size="sm" variant="secondary" onClick={copyForward}>
                    <Copy aria-hidden />
                    Copy last visit
                  </Button>
                ) : null
              }
            />
            <PanelBody className="flex flex-col gap-4">
              <Field
                label="Presenting complaint"
                htmlFor="chiefComplaint"
                hint="What the patient came in for, in their words."
              >
                <Textarea
                  rows={2}
                  autoFocus={!finalised}
                  disabled={readOnly}
                  value={autosave.draft?.chiefComplaint ?? ''}
                  onChange={(e) => autosave.update({ chiefComplaint: e.target.value })}
                />
              </Field>

              <Field label="History" htmlFor="historyOfPresentIllness">
                <Textarea
                  rows={3}
                  disabled={readOnly}
                  value={autosave.draft?.historyOfPresentIllness ?? ''}
                  onChange={(e) =>
                    autosave.update({ historyOfPresentIllness: e.target.value })
                  }
                />
              </Field>

              <Field label="Examination" htmlFor="examinationNotes">
                <Textarea
                  rows={3}
                  disabled={readOnly}
                  value={autosave.draft?.examinationNotes ?? ''}
                  onChange={(e) => autosave.update({ examinationNotes: e.target.value })}
                />
              </Field>

              <Field
                label="Assessment"
                htmlFor="assessmentNotes"
                hint="Narrative. Coded diagnoses go in the list on the right."
              >
                <Textarea
                  rows={3}
                  disabled={readOnly}
                  value={autosave.draft?.assessmentNotes ?? ''}
                  onChange={(e) => autosave.update({ assessmentNotes: e.target.value })}
                />
              </Field>

              <Field
                label="Plan and advice"
                htmlFor="planNotes"
                hint="Printed on the prescription the patient takes away."
              >
                <Textarea
                  rows={3}
                  disabled={readOnly}
                  value={autosave.draft?.planNotes ?? ''}
                  onChange={(e) => autosave.update({ planNotes: e.target.value })}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Follow up in (days)"
                  htmlFor="followUpAfterDays"
                  /*
                   * Says what will actually happen, which it previously did not.
                   *
                   * This field has always been stored and printed on the
                   * prescription, but nothing acted on it — so a doctor writing
                   * "7" had no way to know whether the patient would be
                   * reminded. Now one is scheduled when the consultation is
                   * SIGNED, and a field with a consequence should state it:
                   * silence here is how a doctor ends up assuming a reminder
                   * went out when the clinic has them switched off.
                   */
                  hint={followUpHint}
                >
                  <Input
                    inputMode="numeric"
                    className="token"
                    disabled={readOnly}
                    value={autosave.draft?.followUpAfterDays ?? ''}
                    onChange={(e) =>
                      autosave.update({
                        followUpAfterDays: e.target.value
                          ? Number.parseInt(e.target.value, 10)
                          : null,
                      })
                    }
                  />
                </Field>
                <Field label="Follow-up instructions" htmlFor="followUpInstructions">
                  <Input
                    disabled={readOnly}
                    value={autosave.draft?.followUpInstructions ?? ''}
                    onChange={(e) =>
                      autosave.update({ followUpInstructions: e.target.value })
                    }
                  />
                </Field>
              </div>
            </PanelBody>
          </Panel>

          {canWriteNotes ? (
            <InternalNotesPanel
              notes={notes.data ?? []}
              onAdd={(note) => addNote.mutate({ note, patientId })}
              pending={addNote.isPending}
            />
          ) : null}
        </div>

        {/* --- Structured side -------------------------------------------- */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader
              title="Vitals"
              actions={
                canRecordVitals && !finalised ? (
                  <Button size="sm" variant="secondary" onClick={() => setVitalsOpen(true)}>
                    <Thermometer aria-hidden />
                    Record
                  </Button>
                ) : null
              }
            />
            <PanelBody>
              {(snapshot.data?.latestVitals ?? []).length === 0 ? (
                <p className="text-xs text-ink-faint">No vitals recorded for this patient.</p>
              ) : (
                /*
                 * The shared grid, which flags an out-of-range reading.
                 *
                 * This panel used to print the numbers bare, so a doctor
                 * consulting could not see that a systolic was 210 — the one
                 * screen where that matters most. `showAge` is off because
                 * these are today's and the column is narrow.
                 */
                <VitalsGrid vitals={snapshot.data?.latestVitals ?? []} showAge={false} />
              )}
            </PanelBody>
          </Panel>

          <DiagnosisPanel
            readOnly={readOnly}
            conditions={snapshot.data?.conditions ?? []}
            onAdd={(input) => addDiagnosis.mutate(input)}
            pending={addDiagnosis.isPending}
          />

          {/*
            Lab orders sit between the diagnosis and the prescription, which is
            the order a consultation happens in: you decide what you think it is,
            then what you want to confirm it, then what you are giving for it.
            Rendered only where the role can order — reception never sees this
            screen, and a nurse can enter a result but not decide a test is
            needed.
          */}
          {canOrderLabs ? (
            <OrderTestPanel
              patientId={patientId}
              encounterId={encounterId}
              readOnly={readOnly}
            />
          ) : null}

          {canPrescribe ? (
            <Panel>
              <PanelHeader
                title="Prescription"
                description={`${lines.data?.length ?? 0} medicines`}
              />
              <PanelBody className="flex flex-col gap-3">
                {!finalised ? (
                  <DrugCombobox
                    allergies={allergies}
                    onSelect={(drug) =>
                      considerDrug(
                        drug.brandName ?? drug.moleculeName,
                        drug.moleculeName,
                        drug,
                      )
                    }
                    onFreeText={(name) => considerDrug(name, null, null)}
                  />
                ) : null}

                {(lines.data ?? []).length === 0 ? (
                  <p className="text-xs text-ink-faint">
                    No medicines added yet.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {(lines.data ?? []).map((line) => (
                      <li
                        key={line.id}
                        className="rounded-md border border-line bg-surface-sunk/50 p-2.5"
                      >
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-ink">
                              {line.drugDisplayName}
                              {line.strength ? (
                                <span className="token ml-1.5 text-xs text-ink-soft">
                                  {line.strength}
                                </span>
                              ) : null}
                            </p>
                            {line.safetyOverrideReason ? (
                              <p className="mt-1 text-2xs text-critical">
                                Prescribed despite a warning: {line.safetyOverrideReason}
                              </p>
                            ) : null}
                            {!line.catalogueItemId ? (
                              <p className="mt-0.5 text-2xs text-ink-faint">
                                Typed manually — allergy checking matches on the name only.
                              </p>
                            ) : null}
                          </div>
                          {!finalised ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => removeLine.mutate(line.id)}
                              aria-label={`Remove ${line.drugDisplayName}`}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          ) : null}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="token rounded-sm bg-surface px-1.5 py-0.5 text-xs text-ink">
                            {line.frequency}
                          </span>
                          {/*
                            Nothing is printed when the timing is null.

                            This used to fall through to "After food" for any
                            value it did not recognise, including null — so a
                            line with no timing recorded displayed, and printed,
                            an instruction nobody gave.
                          */}
                          {line.timingRelativeToFood ? (
                            <span className="text-2xs text-ink-faint">
                              {line.timingRelativeToFood === 'BEFORE_FOOD'
                                ? 'Before food'
                                : line.timingRelativeToFood === 'WITH_FOOD'
                                  ? 'With food'
                                  : 'After food'}
                            </span>
                          ) : null}
                          {line.durationDays ? (
                            <span className="text-2xs text-ink-faint">
                              {line.durationDays} days
                            </span>
                          ) : null}
                          {line.quantity ? (
                            <span className="text-2xs text-ink-faint">
                              Dispense {line.quantity}
                            </span>
                          ) : null}
                          {!finalised ? (
                            <button
                              type="button"
                              onClick={() => setEditingLine(line)}
                              className="ml-auto text-2xs font-medium text-accent hover:underline"
                            >
                              Change dose
                            </button>
                          ) : null}
                        </div>
                        {line.instructions ? (
                          <p className="mt-1 text-2xs text-ink-soft">{line.instructions}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {!signing.allowed && !finalised ? (
                  <Alert tone="warning" title="You will not be able to sign this">
                    {signing.reason}
                  </Alert>
                ) : null}
              </PanelBody>
            </Panel>
          ) : null}
        </div>
      </div>

      {pendingDrug ? (
        <SafetyWarningDialog
          open
          drugName={pendingDrug.name}
          warnings={pendingDrug.warnings}
          onCancel={() => setPendingDrug(null)}
          onProceed={(reason) => {
            // Override recorded, now ask the dose. Two questions, in order.
            setDosing({
              name: pendingDrug.name,
              molecule: pendingDrug.molecule,
              drug: pendingDrug.drug,
              warnings: pendingDrug.warnings,
              overrideReason: reason,
            });
            setPendingDrug(null);
          }}
        />
      ) : null}

      <DosageDialog
        open={dosing !== null}
        drugName={dosing?.name ?? ''}
        drug={dosing?.drug ?? null}
        saving={addLine.isPending}
        onCancel={() => setDosing(null)}
        onConfirm={(dose) => {
          if (!dosing) return;
          void commitLine(
            dosing.name,
            dosing.molecule,
            dosing.drug,
            dosing.warnings,
            dosing.overrideReason,
            dose,
          );
        }}
      />

      {/*
        The same dialog, opened on an existing line's values.

        A separate mount rather than one with a mode flag, because the two have
        different lifecycles: adding resets to defaults on every open, editing
        has to start from what is already recorded.
      */}
      <DosageDialog
        open={editingLine !== null}
        drugName={editingLine?.drugDisplayName ?? ''}
        drug={null}
        initial={
          editingLine
            ? {
                frequency: editingLine.frequency,
                timingRelativeToFood: editingLine.timingRelativeToFood,
                durationDays: editingLine.durationDays,
                route: editingLine.route,
                quantity: editingLine.quantity,
                instructions: editingLine.instructions,
              }
            : undefined
        }
        saving={reviseDosage.isPending}
        onCancel={() => setEditingLine(null)}
        onConfirm={(dose) => {
          if (!editingLine) return;
          reviseDosage.mutate(
            { lineId: editingLine.id, ...dose },
            { onSuccess: () => setEditingLine(null) },
          );
        }}
      />

      <RecordVitalsDialog
        patientId={patientId}
        encounterId={encounterId}
        open={vitalsOpen}
        onOpenChange={setVitalsOpen}
        recordedByName={session.fullName}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Diagnoses — free text accepted, coding optional
 * ------------------------------------------------------------------------- */

function DiagnosisPanel({
  readOnly,
  conditions,
  onAdd,
  pending,
}: {
  readOnly: boolean;
  conditions: { id: string; displayText: string; isChronic: boolean; code: string | null }[];
  onAdd: (input: {
    displayText: string;
    isChronic: boolean;
    code?: string | null;
    codeSystem?: string | null;
  }) => void;
  pending: boolean;
}) {
  /*
   * `chronic` is held outside the picker so a selection can PRE-FILL it.
   *
   * Diabetes and hypertension are chronic every single time, and asking on each
   * visit means the box gets answered carelessly. It stays editable because the
   * same code can be either — "asthma" in a child who may grow out of it.
   */
  const [chronic, setChronic] = React.useState(false);

  return (
    <Panel>
      <PanelHeader
        title="Diagnoses"
        description="Search for a code, or just type it. Both are recorded."
      />
      <PanelBody className="flex flex-col gap-3">
        {conditions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {conditions.map((condition) => (
              <Badge key={condition.id} tone={condition.isChronic ? 'chronic' : 'neutral'}>
                {condition.displayText}
                {/*
                  The code is shown where there is one, and its absence is left
                  plain rather than marked. A coded entry is not better care than
                  an uncoded one — it is more portable — and badging free text as
                  deficient would push doctors toward picking the nearest wrong
                  code, which is the one outcome worth avoiding.
                */}
                {condition.code ? (
                  <span className="ml-1 font-normal opacity-70">{condition.code}</span>
                ) : null}
              </Badge>
            ))}
          </div>
        ) : null}

        {!readOnly ? (
          <div className="flex flex-col gap-2">
            <DiagnosisCombobox
              onSelect={(item) => {
                onAdd({
                  displayText: item.displayText,
                  // The clinic's own default wins unless the doctor has already
                  // ticked the box themselves.
                  isChronic: chronic || item.isChronicByDefault,
                  code: item.code,
                  codeSystem: item.codeSystem,
                });
                setChronic(false);
              }}
              onFreeText={(displayText) => {
                onAdd({ displayText, isChronic: chronic, code: null, codeSystem: null });
                setChronic(false);
              }}
            />
            <label className="flex items-center gap-2 text-2xs text-ink-soft">
              <input
                type="checkbox"
                checked={chronic}
                onChange={(event) => setChronic(event.target.checked)}
                className="size-3.5 accent-accent"
                disabled={pending}
              />
              Chronic — pin this to the top of the patient summary
            </label>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------------------- *
 * Internal notes
 * ------------------------------------------------------------------------- */

function InternalNotesPanel({
  notes,
  onAdd,
  pending,
}: {
  notes: { id: string; note: string; authorName: string; createdAt: string }[];
  onAdd: (note: string) => void;
  pending: boolean;
}) {
  const [text, setText] = React.useState('');

  return (
    /*
     * Visually distinct from the clinical record because it IS distinct: these
     * notes are not part of the record, are not visible to administrators, and
     * are structurally incapable of being sent to the patient — the messaging
     * worker holds no database privilege on this table at all.
     */
    <Panel className="border-dashed bg-surface-sunk/40">
      <PanelHeader
        title="Private notes"
        description="Clinicians only. Never visible to the patient or to administrators."
      />
      <PanelBody className="flex flex-col gap-3">
        {notes.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id} className="rounded-md bg-surface p-2.5">
                <p className="text-sm text-ink">{note.note}</p>
                <p className="mt-1 text-2xs text-ink-faint">
                  {note.authorName} · {formatDate(note.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim().length < 2) return;
            onAdd(text.trim());
            setText('');
          }}
          className="flex flex-col gap-2"
        >
          <Textarea
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="A working note only you and other clinicians will see"
            aria-label="Add a private note"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            className="self-end"
            loading={pending}
          >
            Add note
          </Button>
        </form>
      </PanelBody>
    </Panel>
  );
}

/**
 * In person, or remote.
 *
 * A toggle rather than a question asked when the consultation opens. In-person
 * is the overwhelming majority of visits in this segment, and putting a modal
 * in front of every one of them to catch the rare case is the kind of friction
 * that gets a product abandoned. It defaults to in person and is one click to
 * change, for as long as the consultation is a draft.
 *
 * It is not decoration. Schedule X drugs and narcotics cannot be prescribed
 * remotely at all, and the printed prescription carries a declaration that an
 * in-person one must not carry — so this control changes what the doctor is
 * allowed to do and what the document says.
 *
 * Once signed it renders as a plain statement: the mode is part of the signed
 * record, and the immutability trigger would refuse the write anyway.
 */
function ConsultationModeControl({
  mode,
  finalised,
  pending,
  onChange,
}: {
  mode: ConsultationMode;
  finalised: boolean;
  pending: boolean;
  onChange: (mode: ConsultationMode) => void;
}) {
  const remote = mode === 'TELECONSULTATION';
  const Icon = remote ? Video : Building2;

  if (finalised) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
        <Icon className="size-3.5" aria-hidden />
        {CONSULTATION_MODE_LABEL[mode]}
      </span>
    );
  }

  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() => onChange(remote ? 'IN_PERSON' : 'TELECONSULTATION')}
      title="Schedule X medicines cannot be prescribed in a teleconsultation"
    >
      <Icon aria-hidden />
      {CONSULTATION_MODE_LABEL[mode]}
    </Button>
  );
}
