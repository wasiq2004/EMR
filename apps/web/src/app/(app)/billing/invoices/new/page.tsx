'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus, Search, Trash2 } from 'lucide-react';
import { computeInvoiceTotals, type PatientSummary, type ServiceItem } from '@emr/contracts';
import { api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { ageGender, formatPaise, rupeesToPaise } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PageHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';

interface Line {
  description: string;
  quantity: number;
  unitRupees: string;
}

/** Creating an invoice. Amounts are entered in rupees and stored in paise. */
export default function NewInvoicePage() {
  const router = useRouter();
  const toast = useToast();

  const [term, setTerm] = React.useState('');
  const [patient, setPatient] = React.useState<PatientSummary | null>(null);
  const [lines, setLines] = React.useState<Line[]>([
    { description: 'Consultation', quantity: 1, unitRupees: '600' },
  ]);
  const [discountRupees, setDiscountRupees] = React.useState('0');
  const [saving, setSaving] = React.useState(false);

  const { data: results } = useQuery({
    queryKey: qk.patients(term.trim()),
    queryFn: () =>
      api.get<{ items: PatientSummary[] }>('/patients/search', {
        query: { q: term.trim(), limit: 6 },
      }),
    enabled: term.trim().length >= 2 && !patient,
  });

  const { data: services } = useQuery({
    queryKey: qk.services,
    queryFn: () =>
      api.get<{ items: ServiceItem[] }>('/services').catch(() => ({ items: [] })),
  });

  const priced = lines.map((line) => ({
    serviceItemId: null,
    description: line.description,
    quantity: line.quantity,
    unitPricePaise: rupeesToPaise(line.unitRupees),
    amountPaise: rupeesToPaise(line.unitRupees) * line.quantity,
    hsnSac: null,
  }));

  const totals = computeInvoiceTotals(priced, rupeesToPaise(discountRupees), 0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!patient) return;
    setSaving(true);
    try {
      const invoice = await api.post<{ id: string }>(
        '/invoices',
        {
          patientId: patient.id,
          lineItems: priced,
          discountPaise: rupeesToPaise(discountRupees),
        },
        { idempotencyKey: idempotencyKey() },
      );
      toast.success('Invoice created');
      router.push(`/billing/invoices/${invoice.id}`);
    } catch {
      toast.error('Could not create the invoice');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        href="/billing"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Billing
      </Link>

      <PageHeader title="New invoice" />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Panel>
          <PanelHeader title="Patient" />
          <PanelBody>
            {patient ? (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{patient.fullName}</p>
                  <p className="text-2xs text-ink-faint">
                    {ageGender(patient)} ·{' '}
                    <span className="token">{patient.mrn}</span>
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5">
                  <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
                  <Input
                    autoFocus
                    value={term}
                    onChange={(event) => setTerm(event.target.value)}
                    placeholder="Find the patient"
                    aria-label="Find the patient"
                    className="h-9 border-0 px-0 focus-visible:ring-0"
                  />
                </div>
                {term.trim().length >= 2 ? (
                  <ul className="mt-2 rounded-md border border-line">
                    {(results?.items ?? []).map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => setPatient(row)}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-surface-sunk"
                        >
                          {row.fullName}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Charges"
            actions={
              <Button
                size="sm"
                variant="secondary"
                type="button"
                onClick={() =>
                  setLines((c) => [...c, { description: '', quantity: 1, unitRupees: '' }])
                }
              >
                <Plus aria-hidden />
                Add line
              </Button>
            }
          />
          <PanelBody className="flex flex-col gap-3">
            {(services?.items ?? []).length > 0 ? (
              <Select
                aria-label="Add from the service list"
                onChange={(event) => {
                  const service = (services?.items ?? []).find(
                    (s) => s.id === event.target.value,
                  );
                  if (!service) return;
                  setLines((c) => [
                    ...c,
                    {
                      description: service.name,
                      quantity: 1,
                      unitRupees: String(service.defaultFeePaise / 100),
                    },
                  ]);
                  event.target.value = '';
                }}
              >
                <option value="">Add from the service list…</option>
                {(services?.items ?? []).map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name} — {formatPaise(service.defaultFeePaise)}
                  </option>
                ))}
              </Select>
            ) : null}

            {lines.map((line, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <Field
                  label="Description"
                  htmlFor={`line-desc-${index}`}
                  className="min-w-48 flex-1"
                >
                  <Input
                    id={`line-desc-${index}`}
                    value={line.description}
                    onChange={(event) =>
                      setLines((c) =>
                        c.map((l, i) =>
                          i === index ? { ...l, description: event.target.value } : l,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Qty" htmlFor={`line-qty-${index}`} className="w-16">
                  <Input
                    id={`line-qty-${index}`}
                    inputMode="numeric"
                    className="token"
                    value={line.quantity}
                    onChange={(event) =>
                      setLines((c) =>
                        c.map((l, i) =>
                          i === index
                            ? { ...l, quantity: Number(event.target.value) || 1 }
                            : l,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Rate" htmlFor={`line-rate-${index}`} className="w-28">
                  <Input
                    id={`line-rate-${index}`}
                    inputMode="decimal"
                    className="token"
                    value={line.unitRupees}
                    onChange={(event) =>
                      setLines((c) =>
                        c.map((l, i) =>
                          i === index ? { ...l, unitRupees: event.target.value } : l,
                        ),
                      )
                    }
                  />
                </Field>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                  aria-label="Remove this line"
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}

            <Field label="Discount" htmlFor="discount" className="w-40">
              <Input
                id="discount"
                inputMode="decimal"
                className="token"
                value={discountRupees}
                onChange={(event) => setDiscountRupees(event.target.value)}
              />
            </Field>

            <dl className="ml-auto w-56 text-sm">
              <div className="flex justify-between py-0.5">
                <dt className="text-ink-faint">Subtotal</dt>
                <dd className="tabular text-ink">{formatPaise(totals.subtotalPaise)}</dd>
              </div>
              <div className="flex justify-between border-t border-line pt-1 text-md font-semibold">
                <dt>Total</dt>
                <dd className="tabular">{formatPaise(totals.totalPaise)}</dd>
              </div>
            </dl>
          </PanelBody>
        </Panel>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" asChild>
            <Link href="/billing">Cancel</Link>
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!patient}>
            Create invoice
          </Button>
        </div>
      </form>
    </div>
  );
}
