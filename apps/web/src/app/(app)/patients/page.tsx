'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Search, UserPlus, Users } from 'lucide-react';
import { usePatients } from '@/features/patients/api';
import { useCan } from '@/lib/session';
import { ageGender, formatDate, formatPhone } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/surface';
import {
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/table';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * Patient registry.
 *
 * The search field is focused on load. Registration has to complete in under a
 * minute during the morning rush, and a click to focus is time the front desk
 * does not have.
 *
 * "Register new patient" is deliberately NOT on this page as a primary action.
 * It lives at the end of a search, behind the duplicate check — search before
 * create is enforced by the workflow, because one mobile number routinely
 * serves an entire family and creating a fourth record for the same person
 * splits their clinical history.
 */
export default function PatientsPage() {
  const [term, setTerm] = React.useState('');
  const router = useRouter();
  const { data, isLoading } = usePatients(term);
  const canRegister = useCan('patient:create');

  const patients = data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <PageHeader
        title="Patients"
        description="Search by mobile number or name before registering anyone new."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-64 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
          <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
          <Input
            autoFocus
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Mobile number, name or record number"
            aria-label="Search patients"
            className="h-9 border-0 px-0 focus-visible:ring-0"
          />
        </div>

        {canRegister ? (
          <Button
            variant="primary"
            onClick={() =>
              router.push(
                term.trim()
                  ? `/patients/new?q=${encodeURIComponent(term.trim())}`
                  : '/patients/new',
              )
            }
          >
            <UserPlus aria-hidden />
            Register new patient
          </Button>
        ) : null}
      </div>

      <TableShell
        footer={
          <span>
            {isLoading
              ? 'Searching…'
              : `${patients.length} patient${patients.length === 1 ? '' : 's'}`}
          </span>
        }
      >
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : patients.length === 0 ? (
          <EmptyState
            icon={Users}
            title={term ? `No patient matches “${term}”` : 'No patients yet'}
            description={
              term
                ? 'Check the spelling, or try the mobile number instead.'
                : 'Patients you register will appear here.'
            }
            action={
              canRegister && term ? (
                <Button
                  variant="primary"
                  onClick={() =>
                    router.push(`/patients/new?q=${encodeURIComponent(term.trim())}`)
                  }
                >
                  <UserPlus aria-hidden />
                  Register &ldquo;{term}&rdquo;
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Age</TH>
                <TH>Mobile</TH>
                <TH>Record no.</TH>
                <TH>Last visit</TH>
              </tr>
            </THead>
            <TBody>
              {patients.map((patient) => (
                <TR
                  key={patient.id}
                  interactive
                  onClick={() => router.push(`/patients/${patient.id}`)}
                >
                  <TD>
                    <span className="flex items-center gap-2">
                      <Link
                        href={`/patients/${patient.id}`}
                        className="font-medium text-ink hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {patient.fullName}
                      </Link>
                      {patient.hasHighCriticalityAllergy ? (
                        <Badge tone="critical">
                          <AlertTriangle aria-hidden />
                          Allergy
                        </Badge>
                      ) : null}
                      {patient.tags.map((tag) => (
                        <Badge key={tag} tone="neutral">
                          {tag}
                        </Badge>
                      ))}
                    </span>
                  </TD>
                  <TD>{ageGender(patient)}</TD>
                  <TD>
                    <span className="token">{formatPhone(patient.mobileE164)}</span>
                  </TD>
                  <TD>
                    <span className="token">{patient.mrn}</span>
                  </TD>
                  <TD>
                    {patient.lastVisitAt ? formatDate(patient.lastVisitAt) : 'Never'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </TableShell>
    </div>
  );
}
