'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Copy,
  Eye,
  Lock,
  Plus,
  Thermometer,
  Trash2,
  Video,
} from 'lucide-react';
import type {
  Allergy,
  ConsultationMode,
  DrugCatalogueItem,
  EncounterDraft,
  SafetyWarning,
} from '@emr/contracts';
import { CONSULTATION_MODE_LABEL } from '@emr/contracts';
import { usePatient, usePatientSnapshot } from '@/features/patients/api';
import { RecordVitalsDialog } from '@/features/patients/record-vitals-dialog';
import { AllergyBanner } from '@/features/patients/allergy-banner';
import { DrugCombobox } from '@/features/encounter/drug-combobox';
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
} from '@/features/encounter/api';
import { checkPrescription, requiresAcknowledgement } from '@/lib/safety';
import { useCan, useCanSign, useSession } from '@/lib/session';
import { ageGender, formatDate } from '@/lib/format';
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
  const patient = usePatient(patientId);
  const snapshot = usePatientSnapshot(patientId);
  const lines = usePrescriptionLines(encounterId);
  const notes = useInternalNotes(encounterId);

  const addLine = useAddPrescriptionLine(encounterId);
  const removeLine = useRemovePrescriptionLine(encounterId);
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
        isTeleconsultation: false,
      },
    );

    if (requiresAcknowledgement(warnings)) {
      setPendingDrug({ name, molecule, drug, warnings });
      return;
    }
    void commitLine(name, molecule, drug, warnings, null);
  };

  const commitLine = async (
    name: string,
    molecule: string | null,
    drug: DrugCatalogueItem | null,
    warnings: SafetyWarning[],
    overrideReason: string | null,
  ) => {
    await addLine.mutateAsync({
      catalogueItemId: drug?.id ?? null,
      drugDisplayName: name,
      moleculeName: molecule,
      strength: drug?.strength ?? null,
      dosageForm: drug?.dosageForm ?? null,
      route: drug?.route ?? null,
      frequency: '1-0-1',
      timingRelativeToFood: 'AFTER_FOOD',
      durationDays: 5,
      safetyWarningsShown: warnings,
      safetyOverrideReason: overrideReason,
    });
    setPendingDrug(null);
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
        <Alert tone="info" title="This consultation is signed and cannot be edited">
          Corrections are recorded as a separate amendment linked to this record,
          so the original stays intact.{' '}
          <Link href={`/encounters/${encounterId}/amend`} className="font-medium underline">
            Create an amendment
          </Link>
        </Alert>
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
                <Field label="Follow up in (days)" htmlFor="followUpAfterDays">
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
            <PanelBody className="grid grid-cols-2 gap-3">
              {(snapshot.data?.latestVitals ?? []).length === 0 ? (
                <p className="col-span-2 text-xs text-ink-faint">
                  No vitals recorded for this patient.
                </p>
              ) : (
                (snapshot.data?.latestVitals ?? []).map((vital) => (
                  <div key={vital.id}>
                    <p className="text-2xs uppercase tracking-wide text-ink-faint">
                      {vital.display}
                    </p>
                    <p className="text-md font-semibold tabular text-ink">
                      {vital.valueNumeric ?? '—'}{' '}
                      <span className="text-2xs font-normal text-ink-faint">
                        {vital.valueUnit}
                      </span>
                    </p>
                  </div>
                ))
              )}
            </PanelBody>
          </Panel>

          <DiagnosisPanel
            readOnly={readOnly}
            conditions={snapshot.data?.conditions ?? []}
            onAdd={(displayText, isChronic) =>
              addDiagnosis.mutate({ displayText, isChronic })
            }
            pending={addDiagnosis.isPending}
          />

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
                          <span className="text-2xs text-ink-faint">
                            {line.timingRelativeToFood === 'BEFORE_FOOD'
                              ? 'Before food'
                              : line.timingRelativeToFood === 'WITH_FOOD'
                                ? 'With food'
                                : 'After food'}
                          </span>
                          {line.durationDays ? (
                            <span className="text-2xs text-ink-faint">
                              {line.durationDays} days
                            </span>
                          ) : null}
                        </div>
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
          onProceed={(reason) =>
            void commitLine(
              pendingDrug.name,
              pendingDrug.molecule,
              pendingDrug.drug,
              pendingDrug.warnings,
              reason,
            )
          }
        />
      ) : null}

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
  conditions: { id: string; displayText: string; isChronic: boolean }[];
  onAdd: (displayText: string, isChronic: boolean) => void;
  pending: boolean;
}) {
  const [text, setText] = React.useState('');
  const [chronic, setChronic] = React.useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (text.trim().length < 2) return;
    onAdd(text.trim(), chronic);
    setText('');
    setChronic(false);
  };

  return (
    <Panel>
      <PanelHeader
        title="Diagnoses"
        description="A code is optional. Type the diagnosis as you would write it."
      />
      <PanelBody className="flex flex-col gap-3">
        {conditions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {conditions.map((condition) => (
              <Badge key={condition.id} tone={condition.isChronic ? 'chronic' : 'neutral'}>
                {condition.displayText}
              </Badge>
            ))}
          </div>
        ) : null}

        {!readOnly ? (
          <form onSubmit={submit} className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Input
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="e.g. Acute pharyngitis"
                aria-label="Add a diagnosis"
              />
              <Button type="submit" variant="secondary" loading={pending}>
                <Plus aria-hidden />
                Add
              </Button>
            </div>
            <label className="flex items-center gap-2 text-2xs text-ink-soft">
              <input
                type="checkbox"
                checked={chronic}
                onChange={(event) => setChronic(event.target.checked)}
                className="size-3.5 accent-accent"
              />
              Chronic — pin this to the top of the patient summary
            </label>
          </form>
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
