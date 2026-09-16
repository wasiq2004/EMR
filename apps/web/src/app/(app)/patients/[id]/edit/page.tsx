'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { usePatient, useUpdatePatient } from '@/features/patients/api';
import { ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * Editing patient details.
 *
 * Two receptionists editing the same record is routine, so every save carries
 * the version that was read. If someone else changed the record meanwhile the
 * save is refused rather than silently overwriting their work, and this screen
 * offers to reload instead of pretending it succeeded.
 */
export default function EditPatientPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const { data: patient, isLoading, refetch } = usePatient(params.id);
  const update = useUpdatePatient(params.id);

  const [form, setForm] = React.useState<Record<string, string>>({});
  const [conflict, setConflict] = React.useState(false);

  React.useEffect(() => {
    if (!patient) return;
    setForm({
      fullName: patient.fullName,
      gender: patient.gender,
      addressLine1: patient.addressLine1 ?? '',
      city: patient.city ?? '',
      pincode: patient.pincode ?? '',
      bloodGroup: patient.bloodGroup ?? '',
      emergencyContactName: patient.emergencyContactName ?? '',
      emergencyContactPhoneE164: patient.emergencyContactPhoneE164 ?? '',
      emergencyContactRelation: patient.emergencyContactRelation ?? '',
      clinicalAlert: patient.clinicalAlert ?? '',
      notes: patient.notes ?? '',
    });
  }, [patient]);

  const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!patient) return;
    setConflict(false);

    try {
      await update.mutateAsync({
        ...form,
        clinicalAlert: form.clinicalAlert || null,
        notes: form.notes || null,
        version: patient.version,
      } as never);
      toast.success('Details saved');
      router.push(`/patients/${params.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.isConflict) {
        setConflict(true);
      } else {
        toast.error('Could not save', 'Try again in a moment.');
      }
    }
  };

  if (isLoading || !patient) return <Skeleton className="h-96 w-full" />;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {conflict ? (
        <Alert
          tone="warning"
          title="Someone else changed this record while you were editing"
          action={
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                void refetch();
                setConflict(false);
              }}
            >
              Reload their version
            </Button>
          }
        >
          Your changes have not been saved. Reload to see the current details,
          then make your edit again.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader title="Patient details" />
        <PanelBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" htmlFor="fullName" required>
            <Input id="fullName" value={form.fullName ?? ''} onChange={set('fullName')} />
          </Field>
          <Field label="Gender" htmlFor="gender">
            <Select id="gender" value={form.gender ?? ''} onChange={set('gender')}>
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="OTHER">Other</option>
              <option value="UNKNOWN">Not stated</option>
            </Select>
          </Field>
          <Field label="Address" htmlFor="addressLine1">
            <Input id="addressLine1" value={form.addressLine1 ?? ''} onChange={set('addressLine1')} />
          </Field>
          <Field label="City" htmlFor="city">
            <Input id="city" value={form.city ?? ''} onChange={set('city')} />
          </Field>
          <Field label="Pincode" htmlFor="pincode">
            <Input id="pincode" className="token" value={form.pincode ?? ''} onChange={set('pincode')} />
          </Field>
          <Field label="Blood group" htmlFor="bloodGroup">
            <Input id="bloodGroup" value={form.bloodGroup ?? ''} onChange={set('bloodGroup')} />
          </Field>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Emergency contact" />
        <PanelBody className="grid gap-4 sm:grid-cols-3">
          <Field label="Name" htmlFor="emergencyContactName">
            <Input id="emergencyContactName" value={form.emergencyContactName ?? ''} onChange={set('emergencyContactName')} />
          </Field>
          <Field label="Mobile" htmlFor="emergencyContactPhoneE164">
            <Input id="emergencyContactPhoneE164" className="token" value={form.emergencyContactPhoneE164 ?? ''} onChange={set('emergencyContactPhoneE164')} />
          </Field>
          <Field label="Relationship" htmlFor="emergencyContactRelation">
            <Input id="emergencyContactRelation" value={form.emergencyContactRelation ?? ''} onChange={set('emergencyContactRelation')} />
          </Field>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Flags and notes"
          description="The alert is shown on every screen for this patient."
        />
        <PanelBody className="flex flex-col gap-4">
          <Field
            label="Clinical alert"
            htmlFor="clinicalAlert"
            hint="Use sparingly. It appears above every tab of this record."
          >
            <Input id="clinicalAlert" value={form.clinicalAlert ?? ''} onChange={set('clinicalAlert')} />
          </Field>
          <Field label="Desk notes" htmlFor="notes" hint="Not clinical content.">
            <Textarea id="notes" rows={3} value={form.notes ?? ''} onChange={set('notes')} />
          </Field>
        </PanelBody>
      </Panel>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" asChild>
          <Link href={`/patients/${params.id}`}>Cancel</Link>
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
