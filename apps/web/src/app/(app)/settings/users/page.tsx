'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, UserPlus } from 'lucide-react';
import { ROLE_LABEL, type StaffUser } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useCan } from '@/lib/session';
import { relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { Alert, SkeletonRows } from '@/components/ui/feedback';

/**
 * Staff and roles.
 *
 * The medical registration number is the field that matters most here: a doctor
 * without one CANNOT sign a prescription, because the number is a legally
 * required element of the document and would otherwise print blank. The list
 * calls that out rather than letting the doctor discover it at the moment of
 * signing.
 *
 * Note also that there is no self-service password reset in the system — an
 * administrator resets a password from this screen.
 */
export default function StaffSettingsPage() {
  const canManage = useCan('user:create');

  const { data, isLoading } = useQuery({
    queryKey: qk.staff,
    queryFn: () => api.get<{ items: StaffUser[] }>('/users'),
  });

  const staff = data?.items ?? [];
  const cannotSign = staff.filter(
    (user) => user.role === 'DOCTOR' && !user.medicalRegistrationNumber,
  );

  return (
    <div className="flex flex-col gap-4">
      {cannotSign.length > 0 ? (
        <Alert
          tone="warning"
          title={`${cannotSign.length} doctor account${cannotSign.length === 1 ? '' : 's'} cannot sign prescriptions`}
        >
          {cannotSign.map((user) => user.fullName).join(', ')} —{' '}
          {cannotSign.length === 1 ? 'this account has' : 'these accounts have'} no
          medical registration number on file. Add it before they consult.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Staff"
          description={`${staff.length} accounts`}
          actions={
            canManage ? (
              <Button size="sm" variant="primary">
                <UserPlus aria-hidden />
                Invite
              </Button>
            ) : null
          }
        />
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : (
          <ul className="divide-y divide-line-soft">
            {staff.map((user) => (
              <li key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{user.fullName}</span>
                    <Badge tone="neutral">{ROLE_LABEL[user.role]}</Badge>
                    {user.mfaEnabled ? (
                      <Badge tone="positive">
                        <ShieldCheck aria-hidden />
                        Two-factor on
                      </Badge>
                    ) : (
                      <Badge tone="warning">No two-factor</Badge>
                    )}
                    {!user.isActive ? <Badge tone="neutral">Deactivated</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-2xs text-ink-faint">
                    {user.email}
                    {user.qualifications ? ` · ${user.qualifications}` : ''}
                    {user.lastLoginAt
                      ? ` · last signed in ${relativeTime(user.lastLoginAt)}`
                      : ' · never signed in'}
                  </p>

                  {user.role === 'DOCTOR' ? (
                    user.medicalRegistrationNumber ? (
                      <p className="mt-1 text-2xs text-ink-faint">
                        Registration{' '}
                        <span className="token">{user.medicalRegistrationNumber}</span>
                        {user.medicalCouncil ? ` · ${user.medicalCouncil}` : ''}
                      </p>
                    ) : (
                      <p className="mt-1 text-2xs font-medium text-warning">
                        No registration number — cannot sign prescriptions
                      </p>
                    )
                  ) : null}
                </div>

                {canManage ? (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="secondary">
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost">
                      Reset password
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
