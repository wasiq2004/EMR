'use client';

import * as React from 'react';
import { UserPlus, Users } from 'lucide-react';
import { ROLE_LABEL, type StaffUser } from '@emr/contracts';
import { useStaff } from '@/features/staff/api';
import {
  EditStaffDialog,
  InviteStaffDialog,
  ResetStaffPasswordDialog,
} from '@/features/staff/staff-dialogs';
import { useCan, useSession } from '@/lib/session';
import { relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * Staff and roles.
 *
 * The medical registration number is the field that matters most here: a doctor
 * without one CANNOT sign a prescription, because the number is a legally
 * required element of the document and would otherwise print blank. The list
 * calls that out rather than letting the doctor discover it at the moment of
 * signing.
 *
 * There is no self-service password reset anywhere in this product — no mail
 * provider is connected, and a reset link that never arrives is worse than none.
 * An administrator issues a new password from this screen and reads it out.
 */
export default function StaffSettingsPage() {
  const canManage = useCan('user:create');
  const session = useSession();
  const staffQuery = useStaff();

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<StaffUser | null>(null);
  const [resetting, setResetting] = React.useState<StaffUser | null>(null);

  const staff = staffQuery.data ?? [];
  const cannotSign = staff.filter(
    (user) => user.role === 'DOCTOR' && !user.medicalRegistrationNumber,
  );

  return (
    <div className="flex flex-col gap-4">
      {cannotSign.length > 0 ? (
        <Alert
          tone="warning"
          title={`${cannotSign.length} doctor account${cannotSign.length === 1 ? '' : 's'} cannot sign prescriptions`}
          action={
            canManage ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing(cannotSign[0]!)}>
                Add the number
              </Button>
            ) : null
          }
        >
          {cannotSign.map((user) => user.fullName).join(', ')} —{' '}
          {cannotSign.length === 1 ? 'this account has' : 'these accounts have'} no
          medical registration number on file. Add it before they consult.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Staff"
          description={`${staff.length} account${staff.length === 1 ? '' : 's'}`}
          actions={
            canManage ? (
              <Button size="sm" variant="primary" onClick={() => setInviteOpen(true)}>
                <UserPlus aria-hidden />
                Add a staff member
              </Button>
            ) : null
          }
        />

        {staffQuery.isLoading ? (
          <SkeletonRows rows={5} />
        ) : staff.length === 0 ? (
          <PanelBody>
            <EmptyState
              icon={Users}
              title="No staff yet"
              description="Add the people who work here and give each one a role. Every account gets its own one-time password."
              action={
                canManage ? (
                  <Button variant="primary" onClick={() => setInviteOpen(true)}>
                    Add a staff member
                  </Button>
                ) : null
              }
            />
          </PanelBody>
        ) : (
          <ul className="divide-y divide-line-soft">
            {staff.map((user) => (
              <li key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{user.fullName}</span>
                    <Badge tone="neutral">{ROLE_LABEL[user.role]}</Badge>
                    {user.id === session.userId ? <Badge tone="info">You</Badge> : null}
                    {/*
                      Hidden with the rest of two-factor — owner decision,
                      2026-09-28. It marked every single account with a warning
                      badge for a feature nobody can turn on, which trains people
                      to ignore warning badges.

                    {user.mfaEnabled ? (
                      <Badge tone="positive">
                        <ShieldCheck aria-hidden />
                        Two-factor on
                      </Badge>
                    ) : (
                      <Badge tone="warning">No two-factor</Badge>
                    )}
                    */}
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
                    <Button size="sm" variant="secondary" onClick={() => setEditing(user)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setResetting(user)}>
                      Reset password
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <InviteStaffDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <EditStaffDialog user={editing} onClose={() => setEditing(null)} />
      <ResetStaffPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}
