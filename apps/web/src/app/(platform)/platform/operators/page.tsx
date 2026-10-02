'use client';

import * as React from 'react';
import { Plus, ShieldAlert, UserCog } from 'lucide-react';
import {
  useCreateOperator,
  useOperators,
  useResetOperatorPassword,
  useUpdateOperator,
  type OperatorRow,
} from '@/features/platform/api';
import { CredentialReveal } from '@/components/ui/credential-reveal';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Who can operate this deployment.
 *
 * THREE ROLES, AND THE SPLIT IS NOT DECORATIVE. Support reads the estate and changes
 * nothing. Operator suspends clinics and moves plans. Platform Admin also manages
 * these accounts and is the only role that can reset a clinic administrator's
 * password — the single most sensitive action in the console, because it hands
 * somebody a working credential for a customer's clinic.
 *
 * Every account here reaches every customer, so the least authority that does the job
 * is the right default: a new operator is created as SUPPORT unless someone chooses
 * otherwise.
 */
const ROLES = [
  {
    value: 'SUPPORT',
    label: 'Support',
    detail: 'Reads clinics, usage and health. Changes nothing.',
  },
  {
    value: 'OPERATOR',
    label: 'Operator',
    detail: 'Suspends and restores clinics, assigns plans, edits the catalogue.',
  },
  {
    value: 'PLATFORM_ADMIN',
    label: 'Platform Admin',
    detail:
      'Everything an operator can do, plus managing these accounts and rescuing a locked-out clinic administrator.',
  },
] as const;

export default function OperatorsPage() {
  const operators = useOperators();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<OperatorRow | null>(null);

  const admins = (operators.data ?? []).filter(
    (op) => op.role === 'PLATFORM_ADMIN' && op.isActive,
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Operators"
        description="Accounts that can operate this deployment. Every one reaches every customer."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden />
            New operator
          </Button>
        }
      />

      {admins.length === 1 ? (
        <Alert tone="warning" title="One active Platform Admin">
          If that account is locked out, nobody can manage operators or rescue a clinic
          administrator without database access. A second is worth having.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader title="Accounts" />
        <PanelBody>
          {operators.isLoading ? (
            <SkeletonRows rows={4} />
          ) : (operators.data ?? []).length === 0 ? (
            <EmptyState
              icon={UserCog}
              title="No operators"
              description="This cannot normally happen — you are signed in as one."
            />
          ) : (
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Email</TH>
                    <TH>Role</TH>
                    <TH>Last signed in</TH>
                    <TH>State</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {(operators.data ?? []).map((operator) => {
                    const locked =
                      operator.lockedUntil !== null &&
                      new Date(operator.lockedUntil) > new Date();
                    return (
                      <TR
                        key={operator.id}
                        className={operator.isActive ? undefined : 'opacity-60'}
                      >
                        <TD className="font-medium text-ink">{operator.fullName}</TD>
                        <TD className="token text-xs">{operator.email}</TD>
                        <TD>
                          <Badge
                            tone={
                              operator.role === 'PLATFORM_ADMIN'
                                ? 'critical'
                                : operator.role === 'OPERATOR'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {ROLES.find((r) => r.value === operator.role)?.label ?? operator.role}
                          </Badge>
                        </TD>
                        <TD className="whitespace-nowrap text-ink-faint">
                          {operator.lastLoginAt ? relativeTime(operator.lastLoginAt) : 'never'}
                        </TD>
                        <TD>
                          {!operator.isActive ? (
                            <Badge>Disabled</Badge>
                          ) : locked ? (
                            <Badge tone="critical">
                              Locked until {formatDateTime(operator.lockedUntil!)}
                            </Badge>
                          ) : operator.failedLoginAttempts > 0 ? (
                            <Badge tone="warning">
                              {operator.failedLoginAttempts} failed attempts
                            </Badge>
                          ) : (
                            <Badge tone="positive">Active</Badge>
                          )}
                        </TD>
                        <TD align="right">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(operator)}>
                            Manage
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableScroller>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="What each role can do" />
        <PanelBody className="space-y-2">
          {ROLES.map((role) => (
            <div key={role.value} className="flex items-start gap-2.5">
              <Badge
                tone={
                  role.value === 'PLATFORM_ADMIN'
                    ? 'critical'
                    : role.value === 'OPERATOR'
                      ? 'warning'
                      : 'neutral'
                }
              >
                {role.label}
              </Badge>
              <p className="min-w-0 text-xs text-ink-soft">{role.detail}</p>
            </div>
          ))}
          <p className="mt-1 flex items-start gap-1.5 text-2xs text-ink-faint">
            <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            No role reaches patient data. That is a database privilege this console&apos;s
            connection does not hold, not a screen it lacks.
          </p>
        </PanelBody>
      </Panel>

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ManageDialog operator={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function CreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const create = useCreateOperator();
  const [form, setForm] = React.useState({ fullName: '', email: '', role: 'SUPPORT' });
  const [issued, setIssued] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) return;
    setForm({ fullName: '', email: '', role: 'SUPPORT' });
    setIssued(null);
  }, [open]);

  const ready =
    form.fullName.trim().length >= 2 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{issued ? 'Operator created' : 'New operator'}</DialogTitle>
        </DialogHeader>

        {issued ? (
          <>
            <CredentialReveal email={form.email} password={issued} what="operator" />
            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Field label="Full name" htmlFor="op-name" required>
              <Input
                id="op-name"
                value={form.fullName}
                onChange={(event) => setForm((f) => ({ ...f, fullName: event.target.value }))}
              />
            </Field>

            <Field label="Email" htmlFor="op-email" required hint="Their sign-in.">
              <Input
                id="op-email"
                type="email"
                value={form.email}
                onChange={(event) =>
                  setForm((f) => ({ ...f, email: event.target.value.toLowerCase() }))
                }
              />
            </Field>

            <Field
              label="Role"
              htmlFor="op-role"
              required
              hint={ROLES.find((r) => r.value === form.role)?.detail}
            >
              <Select
                id="op-role"
                value={form.role}
                onChange={(event) => setForm((f) => ({ ...f, role: event.target.value }))}
              >
                {ROLES.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </Select>
            </Field>

            {form.role === 'PLATFORM_ADMIN' ? (
              <Alert tone="warning" title="This is the most privileged role">
                It can manage these accounts and reset a clinic administrator&apos;s password,
                which hands somebody a working credential for a customer&apos;s clinic. Grant it
                only where that is genuinely part of the job.
              </Alert>
            ) : null}

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!ready}
                loading={create.isPending}
                onClick={() =>
                  create.mutate(
                    { fullName: form.fullName.trim(), email: form.email.trim(), role: form.role },
                    {
                      onSuccess: (data) => {
                        setIssued(data.temporaryPassword);
                        toast.success('Operator created');
                      },
                      onError: (error) =>
                        toast.error(
                          error instanceof ApiError ? error.message : 'That did not save',
                        ),
                    },
                  )
                }
              >
                Create
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ManageDialog({
  operator,
  onClose,
}: {
  operator: OperatorRow | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const update = useUpdateOperator();
  const reset = useResetOperatorPassword();
  const [role, setRole] = React.useState('SUPPORT');
  const [issued, setIssued] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!operator) return;
    setRole(operator.role);
    setIssued(null);
  }, [operator]);

  return (
    <Dialog open={operator !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{operator?.fullName}</DialogTitle>
        </DialogHeader>

        {issued && operator ? (
          <CredentialReveal email={operator.email} password={issued} what="operator" />
        ) : (
          <>
            <p className="token text-xs text-ink-faint">{operator?.email}</p>

            <Field
              label="Role"
              htmlFor="manage-role"
              hint={ROLES.find((r) => r.value === role)?.detail}
            >
              <Select
                id="manage-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Alert tone="info" title="You cannot change your own role">
              Nor remove the last active Platform Admin. Both are refused by the server, so
              the console cannot be locked out of itself.
            </Alert>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                loading={reset.isPending}
                onClick={() =>
                  operator &&
                  reset.mutate(operator.id, {
                    onSuccess: (data) => {
                      setIssued(data.temporaryPassword);
                      toast.success('Password reset');
                    },
                    onError: (error) =>
                      toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                  })
                }
              >
                Reset password
              </Button>

              <Button
                variant={operator?.isActive ? 'critical' : 'secondary'}
                loading={update.isPending}
                onClick={() =>
                  operator &&
                  update.mutate(
                    { id: operator.id, isActive: !operator.isActive },
                    {
                      onSuccess: () => {
                        toast.success(operator.isActive ? 'Operator disabled' : 'Operator enabled');
                        onClose();
                      },
                      onError: (error) =>
                        toast.error(
                          error instanceof ApiError ? error.message : 'That did not save',
                        ),
                    },
                  )
                }
              >
                {operator?.isActive ? 'Disable account' : 'Enable account'}
              </Button>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {issued ? 'Done' : 'Cancel'}
          </Button>
          {!issued ? (
            <Button
              variant="primary"
              disabled={role === operator?.role}
              loading={update.isPending}
              onClick={() =>
                operator &&
                update.mutate(
                  { id: operator.id, role },
                  {
                    onSuccess: () => {
                      toast.success('Role changed');
                      onClose();
                    },
                    onError: (error) =>
                      toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                  },
                )
              }
            >
              Save role
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
