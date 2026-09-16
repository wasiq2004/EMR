'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Search, UserCheck, UserPlus } from 'lucide-react';
import { normalisePhone, type PatientSummary } from '@emr/contracts';
import { useDuplicateCheck, useRegisterPatient } from '@/features/patients/api';
import { ageGender, formatDate, formatPhone } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PageHeader } from '@/components/ui/surface';
import { Alert, Spinner } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * ====================== REGISTRATION, WITH THE TRAP =========================
 *
 * Duplicate registration is the highest-likelihood risk in this product — it
 * will happen daily without active mitigation — and the Indian context defeats
 * the naive design:
 *
 *   - one mobile number routinely serves an entire family, so mobile is NOT a
 *     unique key
 *   - transliteration is unstable: Mohd / Mohammed / Muhammad
 *   - date of birth is frequently unknown; patients state an approximate age
 *   - no identifier can be made mandatory
 *
 * A split record means allergies and history are invisible at the point of
 * prescribing, which is why this screen is built the way it is:
 *
 *   1. SEARCH COMES FIRST and is not skippable. The form is not reachable
 *      without a search, and the server rejects a registration that arrives
 *      without the token this search issues.
 *   2. EVERYONE ON THAT NUMBER IS SHOWN as a picker, with name, age, gender and
 *      last visit — enough to recognise the person standing at the counter.
 *   3. "Register new" is available but VISUALLY SECONDARY to picking someone
 *      who is already here.
 *   4. A close name match raises a soft warning that can only be dismissed with
 *      a reason.
 *
 * Acceptance: no participant creates a duplicate without first seeing the
 * existing records. Two or more misses means this screen is redesigned.
 * ===========================================================================
 */
export default function RegisterPatientPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();

  const [mobileRaw, setMobileRaw] = React.useState(searchParams.get('q') ?? '');
  const [name, setName] = React.useState('');
  const [searched, setSearched] = React.useState(false);

  const normalisedMobile = normalisePhone(mobileRaw) ?? '';
  const check = useDuplicateCheck(normalisedMobile, name, searched);

  const runSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setSearched(true);
    void check.refetch();
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        href="/patients"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All patients
      </Link>

      <PageHeader
        title="Register a patient"
        description="Check whether they are already registered first. One mobile number often covers a whole family."
      />

      {/* --- Step 1: search. Not skippable. ------------------------------- */}
      <Panel>
        <PanelHeader
          title="Step 1 · Find the patient"
          description="Enter the mobile number they give you."
        />
        <PanelBody>
          <form onSubmit={runSearch} className="flex flex-wrap items-end gap-3">
            <Field label="Mobile number" htmlFor="search-mobile" className="min-w-56 flex-1">
              <Input
                id="search-mobile"
                autoFocus
                inputMode="tel"
                className="token"
                value={mobileRaw}
                onChange={(event) => {
                  setMobileRaw(event.target.value);
                  setSearched(false);
                }}
                placeholder="98765 43210"
              />
            </Field>
            <Field label="Name (optional)" htmlFor="search-name" className="min-w-56 flex-1">
              <Input
                id="search-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setSearched(false);
                }}
                placeholder="Sunita Sharma"
              />
            </Field>
            <Button type="submit" variant="primary">
              <Search aria-hidden />
              Search
            </Button>
          </form>

          {mobileRaw && !normalisedMobile ? (
            <p className="mt-2 text-2xs text-warning">
              That does not look like a complete mobile number yet.
            </p>
          ) : null}
        </PanelBody>
      </Panel>

      {/* --- Step 2: what the search found -------------------------------- */}
      {searched ? (
        check.isFetching ? (
          <div className="px-1">
            <Spinner label="Checking the registry…" />
          </div>
        ) : (
          <SearchResults
            onSameMobile={check.data?.onSameMobile ?? []}
            similar={check.data?.similar ?? []}
            searchToken={check.data?.searchToken ?? null}
            prefillMobile={normalisedMobile}
            prefillName={name}
            onRegistered={(patientId, patientName) => {
              toast.success('Patient registered', `${patientName} is ready to be queued.`);
              router.push(`/patients/${patientId}`);
            }}
          />
        )
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * The picker — existing records first, "register new" second
 * ------------------------------------------------------------------------- */

function SearchResults({
  onSameMobile,
  similar,
  searchToken,
  prefillMobile,
  prefillName,
  onRegistered,
}: {
  onSameMobile: PatientSummary[];
  similar: { patient: PatientSummary; nameSimilarity: number | null }[];
  searchToken: string | null;
  prefillMobile: string;
  prefillName: string;
  onRegistered: (patientId: string, patientName: string) => void;
}) {
  const [showForm, setShowForm] = React.useState(false);

  return (
    <>
      {onSameMobile.length > 0 ? (
        <Panel className="border-info-line">
          <PanelHeader
            title={`${onSameMobile.length} ${onSameMobile.length === 1 ? 'patient is' : 'patients are'} already registered on this number`}
            description="A family sharing one handset is normal. Is the person in front of you one of these?"
          />
          <ul className="divide-y divide-line-soft">
            {onSameMobile.map((patient) => (
              <li key={patient.id}>
                <Link
                  href={`/patients/${patient.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-sunk"
                >
                  <UserCheck className="size-4 shrink-0 text-accent" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-ink">
                        {patient.fullName}
                      </span>
                      <span className="text-sm text-ink-soft">{ageGender(patient)}</span>
                      {patient.hasHighCriticalityAllergy ? (
                        <Badge tone="critical">
                          <AlertTriangle aria-hidden />
                          Allergy
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-2xs text-ink-faint">
                      <span className="token">{patient.mrn}</span> · last seen{' '}
                      {patient.lastVisitAt ? formatDate(patient.lastVisitAt) : 'never'}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-accent">
                    This is them →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <Alert tone="positive" title="Nobody is registered on this number">
          Go ahead and create a new record.
        </Alert>
      )}

      {similar.length > 0 ? (
        <Panel className="border-warning-line">
          <PanelHeader
            title="Similar names on other numbers"
            description="Transliteration varies. Check these before creating a new record."
          />
          <ul className="divide-y divide-line-soft">
            {similar.map(({ patient, nameSimilarity }) => (
              <li key={patient.id}>
                <Link
                  href={`/patients/${patient.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-sunk"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-ink">{patient.fullName}</span>
                    <span className="ml-2 text-sm text-ink-soft">
                      {ageGender(patient)}
                    </span>
                    <span className="mt-0.5 block text-2xs text-ink-faint">
                      <span className="token">{formatPhone(patient.mobileE164)}</span>
                      {nameSimilarity !== null
                        ? ` · ${Math.round(nameSimilarity * 100)}% name match`
                        : ''}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* Available, but quieter than picking someone who is already here. */}
      {!showForm ? (
        <div className="flex justify-center py-2">
          <Button variant="secondary" onClick={() => setShowForm(true)}>
            <UserPlus aria-hidden />
            None of these — register a new patient
          </Button>
        </div>
      ) : (
        <RegistrationForm
          searchToken={searchToken}
          prefillMobile={prefillMobile}
          prefillName={prefillName}
          likelyDuplicate={similar[0]?.patient ?? onSameMobile[0] ?? null}
          onRegistered={onRegistered}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * The form
 * ------------------------------------------------------------------------- */

function RegistrationForm({
  searchToken,
  prefillMobile,
  prefillName,
  likelyDuplicate,
  onRegistered,
}: {
  searchToken: string | null;
  prefillMobile: string;
  prefillName: string;
  likelyDuplicate: PatientSummary | null;
  onRegistered: (patientId: string, patientName: string) => void;
}) {
  const register = useRegisterPatient();
  const toast = useToast();

  const [fullName, setFullName] = React.useState(prefillName);
  const [gender, setGender] = React.useState('FEMALE');
  const [ageYears, setAgeYears] = React.useState('');
  const [dateOfBirth, setDateOfBirth] = React.useState('');
  const [mobileBelongsToRelative, setRelative] = React.useState(false);
  const [addressLine1, setAddress] = React.useState('');
  const [city, setCity] = React.useState('Pune');
  const [notes, setNotes] = React.useState('');
  const [overrideReason, setOverrideReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  // A warning fires only when the name is genuinely close to an existing one.
  const nameCollision =
    likelyDuplicate && similarEnough(fullName, likelyDuplicate.fullName)
      ? likelyDuplicate
      : null;

  const needsOverride = nameCollision !== null;
  const overrideValid = !needsOverride || overrideReason.trim().length >= 4;
  const hasAge = ageYears.trim() !== '' || dateOfBirth !== '';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!fullName.trim()) return setError('Enter the patient name.');
    if (!hasAge) return setError('Enter either a date of birth or an approximate age.');
    if (!overrideValid) {
      return setError('Say why this is a different person from the one shown above.');
    }
    if (!searchToken) {
      return setError('Search again before registering — the check has expired.');
    }

    try {
      const patient = await register.mutateAsync({
        fullName: fullName.trim(),
        mobileE164: prefillMobile || null,
        mobileBelongsToRelative,
        gender,
        dateOfBirth: dateOfBirth || null,
        ageYears: ageYears ? Number.parseInt(ageYears, 10) : null,
        addressLine1: addressLine1 || null,
        city: city || null,
        notes: notes || null,
        searchToken,
        duplicateOverrideReason: needsOverride ? overrideReason.trim() : null,
      });
      onRegistered(patient.id, patient.fullName);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Could not register the patient.';
      setError(message);
      toast.error('Registration failed', message);
    }
  };

  return (
    <form onSubmit={submit}>
      <Panel>
        <PanelHeader
          title="Step 2 · New patient details"
          description="Only the name and an age are required. Everything else can wait."
        />
        <PanelBody className="flex flex-col gap-4">
          {error ? <Alert tone="critical" title={error} /> : null}

          {/*
            The soft warning. Dismissible, but only with a stated reason — which
            is what turns "clicked past it" into "decided".
          */}
          {nameCollision ? (
            <Alert
              tone="warning"
              title={`${nameCollision.fullName}, ${ageGender(nameCollision)} is already registered`}
            >
              <p>Is this the same person?</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" asChild>
                  <Link href={`/patients/${nameCollision.id}`}>
                    Yes — open that record
                  </Link>
                </Button>
              </div>
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="fullName" required>
              <Input
                id="fullName"
                autoFocus
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
              />
            </Field>

            <Field label="Gender" htmlFor="gender">
              <Select
                id="gender"
                value={gender}
                onChange={(event) => setGender(event.target.value)}
              >
                <option value="FEMALE">Female</option>
                <option value="MALE">Male</option>
                <option value="OTHER">Other</option>
                <option value="UNKNOWN">Not stated</option>
              </Select>
            </Field>

            {/*
              Age without a date of birth is the normal case for a walk-in. The
              date the age was stated is recorded alongside it, so the derived
              age stays correct next year.
            */}
            <Field
              label="Age in years"
              htmlFor="ageYears"
              hint="Use this when the exact date of birth is not known."
            >
              <Input
                id="ageYears"
                inputMode="numeric"
                className="token"
                value={ageYears}
                onChange={(event) => setAgeYears(event.target.value)}
              />
            </Field>

            <Field label="Date of birth" htmlFor="dateOfBirth" hint="If they know it.">
              <Input
                id="dateOfBirth"
                type="date"
                value={dateOfBirth}
                onChange={(event) => setDateOfBirth(event.target.value)}
              />
            </Field>
          </div>

          <div className="rounded-md border border-line bg-surface-sunk/50 p-3">
            <p className="text-2xs uppercase tracking-wide text-ink-faint">Mobile</p>
            <p className="token mt-0.5 text-sm text-ink">
              {formatPhone(prefillMobile) || 'None given'}
            </p>
            <label className="mt-2 flex items-center gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={mobileBelongsToRelative}
                onChange={(event) => setRelative(event.target.checked)}
                className="size-3.5 accent-accent"
              />
              This number belongs to a relative, not the patient
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address" htmlFor="addressLine1">
              <Input
                id="addressLine1"
                value={addressLine1}
                onChange={(event) => setAddress(event.target.value)}
              />
            </Field>
            <Field label="City" htmlFor="city">
              <Input
                id="city"
                value={city}
                onChange={(event) => setCity(event.target.value)}
              />
            </Field>
          </div>

          <Field label="Notes for the desk" htmlFor="notes" hint="Not clinical content.">
            <Textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>

          {needsOverride ? (
            <Field
              label="Why is this a different person?"
              htmlFor="overrideReason"
              required
              hint="Recorded with the new patient record."
            >
              <Input
                id="overrideReason"
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder="e.g. Different person — sister-in-law, same household"
              />
            </Field>
          ) : null}
        </PanelBody>
      </Panel>

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" asChild>
          <Link href="/patients">Cancel</Link>
        </Button>
        <Button type="submit" variant="primary" size="lg" loading={register.isPending}>
          <UserPlus aria-hidden />
          Register patient
        </Button>
      </div>
    </form>
  );
}

/** Rough check, enough to decide whether to raise the soft warning. */
function similarEnough(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const [x, y] = [norm(a), norm(b)];
  if (x.length < 3 || y.length < 3) return false;
  if (x === y) return true;
  return x.slice(0, 4) === y.slice(0, 4);
}
