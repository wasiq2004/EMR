'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import type { Clinic } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useCan } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Field, FieldSet, Input, Select } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * Clinic profile.
 *
 * The name, address and logo here are what appear on the prescription
 * letterhead, so a change is a change to a legal document.
 */
export default function ClinicSettingsPage() {
  const canEdit = useCan('clinic:update');
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: qk.clinic,
    queryFn: () => api.get<Clinic>('/clinic'),
  });

  const [form, setForm] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!data) return;
    setForm({
      name: data.name,
      registrationNumber: data.registrationNumber ?? '',
      gstin: data.gstin ?? '',
      addressLine1: data.addressLine1 ?? '',
      addressLine2: data.addressLine2 ?? '',
      city: data.city ?? '',
      state: data.state ?? '',
      pincode: data.pincode ?? '',
      contactPhoneE164: data.contactPhoneE164 ?? '',
      contactEmail: data.contactEmail ?? '',
      timezone: data.timezone,
    });
  }, [data]);

  const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  if (isLoading || !data) return <Skeleton className="h-96 w-full" />;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        toast.success('Clinic details saved');
      }}
      className="flex flex-col gap-4"
    >
      <Alert tone="info" title="This appears on every prescription">
        The name and address below are printed on the letterhead patients take
        away.
      </Alert>

      <Panel>
        <PanelHeader title="Clinic" />
        <PanelBody className="flex flex-col gap-4">
          <FieldSet legend="Identity">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Clinic name" htmlFor="name" required>
                <Input id="name" disabled={!canEdit} value={form.name ?? ''} onChange={set('name')} />
              </Field>
              <Field
                label="Establishment registration"
                htmlFor="registrationNumber"
                hint="Where your state requires it."
              >
                <Input
                  id="registrationNumber"
                  className="token"
                  disabled={!canEdit}
                  value={form.registrationNumber ?? ''}
                  onChange={set('registrationNumber')}
                />
              </Field>
              <Field label="GSTIN" htmlFor="gstin" hint="Only if registered.">
                <Input
                  id="gstin"
                  className="token"
                  disabled={!canEdit}
                  value={form.gstin ?? ''}
                  onChange={set('gstin')}
                />
              </Field>
              <Field
                label="Timezone"
                htmlFor="timezone"
                hint="Drives appointment times, the calendar's day boundary and reminder timing."
              >
                <Select
                  id="timezone"
                  disabled={!canEdit}
                  value={form.timezone ?? ''}
                  onChange={set('timezone')}
                >
                  <option value="Asia/Kolkata">Asia/Kolkata</option>
                </Select>
              </Field>
            </div>
          </FieldSet>

          <FieldSet legend="Address">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Address line 1" htmlFor="addressLine1">
                <Input id="addressLine1" disabled={!canEdit} value={form.addressLine1 ?? ''} onChange={set('addressLine1')} />
              </Field>
              <Field label="Address line 2" htmlFor="addressLine2">
                <Input id="addressLine2" disabled={!canEdit} value={form.addressLine2 ?? ''} onChange={set('addressLine2')} />
              </Field>
              <Field label="City" htmlFor="city">
                <Input id="city" disabled={!canEdit} value={form.city ?? ''} onChange={set('city')} />
              </Field>
              <Field label="State" htmlFor="state">
                <Input id="state" disabled={!canEdit} value={form.state ?? ''} onChange={set('state')} />
              </Field>
              <Field label="Pincode" htmlFor="pincode">
                <Input id="pincode" className="token" disabled={!canEdit} value={form.pincode ?? ''} onChange={set('pincode')} />
              </Field>
            </div>
          </FieldSet>

          <FieldSet legend="Contact" description="Shown to patients on messages and documents.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone" htmlFor="contactPhoneE164">
                <Input id="contactPhoneE164" className="token" disabled={!canEdit} value={form.contactPhoneE164 ?? ''} onChange={set('contactPhoneE164')} />
              </Field>
              <Field label="Email" htmlFor="contactEmail">
                <Input id="contactEmail" type="email" disabled={!canEdit} value={form.contactEmail ?? ''} onChange={set('contactEmail')} />
              </Field>
            </div>
          </FieldSet>

          <FieldSet legend="Letterhead logo" description="Composited into every generated PDF.">
            <Button type="button" variant="secondary" className="w-fit" disabled={!canEdit}>
              <Upload aria-hidden />
              Upload logo
            </Button>
          </FieldSet>
        </PanelBody>
      </Panel>

      {canEdit ? (
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            Save changes
          </Button>
        </div>
      ) : null}
    </form>
  );
}
