'use client';

import * as React from 'react';
import { ROLE_LABEL, type StaffUser, type UserRole } from '@emr/contracts';
import {
  useInviteStaff,
  useResetStaffPassword,
  useUpdateStaff,
  type InviteStaffInput,
} from './api';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Field, FieldGrid, Input, Select } from '@/components/ui/field';
import { PasswordPair, passwordProblem } from '@/components/ui/password-pair';
import { Alert } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The roles a clinic administrator can assign, and what each one is for.
 *
 * Written out rather than derived from the enum, because the enum gives you seven
 * names and no way to choose between them. Somebody setting up a clinic for the
 * first time needs the sentence, not the identifier.
 */
export const ASSIGNABLE_ROLES: { value: UserRole; detail: string }[] = [
  {
    value: 'DOCTOR',
    detail:
      'Consults, diagnoses and prescribes. The only role that can sign a prescription — and only with a medical registration number on file.',
  },
  {
    value: 'RECEPTIONIST',
    detail:
      'Registers patients, books and checks in, collects payment. Sees no clinical notes at all.',
  },
  {
    value: 'NURSE_ASSISTANT',
    detail:
      'Records vitals and allergies at triage. Reads the clinical record; does not diagnose or prescribe.',
  },
  {
    value: 'PHARMACIST',
    detail:
      'Works the medicine counter: dispenses against a finalised prescription, manages stock and purchasing. Cannot alter a prescription.',
  },
  {
    value: 'RESEARCH_ANALYST',
    detail:
      'Builds de-identified cohorts and reads data quality. Holds no permission that returns a patient’s name.',
  },
  {
    value: 'AUDITOR',
    detail:
      'Compliance review. Sees who did what and when, never what was recorded.',
  },
  {
    value: 'OWNER_ADMIN',
    detail:
      'Runs the practice: staff, services, settings, billing and reports. Sees clinical records but cannot author them.',
  },
];

/** A doctor is the only role for whom the registration fields mean anything. */
const isClinician = (role: UserRole) => role === 'DOCTOR';

/* ------------------------------------------------------------------------- *
 * Invite
 * ------------------------------------------------------------------------- */

export function InviteStaffDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const invite = useInviteStaff();

  const blank = {
    fullName: '',
    email: '',
    role: 'RECEPTIONIST' as UserRole,
    mobileE164: '',
    medicalRegistrationNumber: '',
    medicalCouncil: '',
    qualifications: '',
    specialty: '',
    password: '',
    confirmPassword: '',
  };

  const [form, setForm] = React.useState(blank);

  React.useEffect(() => {
    if (open) return;
    setForm(blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const password = passwordProblem(form.password, form.confirmPassword);
  const ready =
    form.fullName.trim().length >= 2 && EMAIL.test(form.email) && password === null;

  const chosen = ASSIGNABLE_ROLES.find((r) => r.value === form.role);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        This dialog used to become `mandatory` after submitting, because the
        server generated the password, returned it once, and an accidental
        Escape lost the only copy. The administrator types it now, so there is
        no secret on screen that cannot be recovered — and no reason to trap
        anybody in a dialog.
      */}
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add a staff member</DialogTitle>
        </DialogHeader>

        {(
          <>
            <FieldGrid>
              <Field label="Full name" htmlFor="staff-name" required>
                <Input
                  id="staff-name"
                  value={form.fullName}
                  onChange={(event) => set({ fullName: event.target.value })}
                />
              </Field>
              <Field label="Email" htmlFor="staff-email" required hint="Their sign-in.">
                <Input
                  id="staff-email"
                  type="email"
                  value={form.email}
                  onChange={(event) => set({ email: event.target.value.toLowerCase() })}
                />
              </Field>
            </FieldGrid>

            <PasswordPair
              idPrefix="staff"
              password={form.password}
              confirmation={form.confirmPassword}
              onPassword={(value) => set({ password: value })}
              onConfirmation={(value) => set({ confirmPassword: value })}
            />

            <Field label="Role" htmlFor="staff-role" required hint={chosen?.detail}>
              <Select
                id="staff-role"
                value={form.role}
                onChange={(event) => set({ role: event.target.value as UserRole })}
              >
                {ASSIGNABLE_ROLES.map((role) => (
                  <option key={role.value} value={role.value}>
                    {ROLE_LABEL[role.value]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Mobile" htmlFor="staff-mobile" hint="Optional.">
              <Input
                id="staff-mobile"
                value={form.mobileE164}
                onChange={(event) => set({ mobileE164: event.target.value })}
                placeholder="+919876543210"
              />
            </Field>

            {/*
              The registration fields appear only for a doctor, because they only
              mean anything for a doctor — and a form that shows every field to
              everyone teaches people to skip the ones that matter.
            */}
            {isClinician(form.role) ? (
              <>
                <Alert tone="warning" title="A doctor cannot sign without a registration number">
                  It is a legally required element of an Indian e-prescription and
                  would otherwise print blank. You can add it later, but they cannot
                  finalise a consultation until you do.
                </Alert>

                {/*
                  FieldGrid, not a bare grid. "Medical registration number"
                  wraps onto a second line at this width and "Medical council"
                  beside it does not, so the two inputs sat on different
                  baselines. See `FieldGrid` for why shortening the label is not
                  the fix.
                */}
                <FieldGrid>
                  <Field label="Medical registration number" htmlFor="staff-reg">
                    <Input
                      id="staff-reg"
                      value={form.medicalRegistrationNumber}
                      onChange={(event) =>
                        set({ medicalRegistrationNumber: event.target.value })
                      }
                      placeholder="MMC-2011-44821"
                    />
                  </Field>
                  <Field label="Medical council" htmlFor="staff-council">
                    <Input
                      id="staff-council"
                      value={form.medicalCouncil}
                      onChange={(event) => set({ medicalCouncil: event.target.value })}
                      placeholder="Maharashtra Medical Council"
                    />
                  </Field>
                  <Field label="Qualifications" htmlFor="staff-quals">
                    <Input
                      id="staff-quals"
                      value={form.qualifications}
                      onChange={(event) => set({ qualifications: event.target.value })}
                      placeholder="MBBS, MD"
                    />
                  </Field>
                  <Field label="Specialty" htmlFor="staff-specialty">
                    <Input
                      id="staff-specialty"
                      value={form.specialty}
                      onChange={(event) => set({ specialty: event.target.value })}
                      placeholder="General Medicine"
                    />
                  </Field>
                </FieldGrid>
              </>
            ) : null}

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!ready}
                loading={invite.isPending}
                onClick={() =>
                  invite.mutate(cleaned(form), {
                    onSuccess: () => {
                      toast.success(
                        `${form.fullName} added`,
                        'They can sign in with the password you set.',
                      );
                      onOpenChange(false);
                    },
                    onError: (error) =>
                      toast.error(
                        error instanceof ApiError
                          ? error.message
                          : 'That account could not be created',
                      ),
                  })
                }
              >
                Create account
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------- *
 * Edit
 * ------------------------------------------------------------------------- */

export function EditStaffDialog({
  user,
  onClose,
}: {
  user: StaffUser | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const session = useSession();
  const update = useUpdateStaff();

  const [form, setForm] = React.useState({
    fullName: '',
    role: 'RECEPTIONIST' as UserRole,
    mobileE164: '',
    medicalRegistrationNumber: '',
    medicalCouncil: '',
    qualifications: '',
    specialty: '',
    isActive: true,
  });

  React.useEffect(() => {
    if (!user) return;
    setForm({
      fullName: user.fullName,
      role: user.role,
      mobileE164: user.mobileE164 ?? '',
      medicalRegistrationNumber: user.medicalRegistrationNumber ?? '',
      medicalCouncil: user.medicalCouncil ?? '',
      qualifications: user.qualifications ?? '',
      specialty: user.specialty ?? '',
      isActive: user.isActive,
    });
  }, [user]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const chosen = ASSIGNABLE_ROLES.find((r) => r.value === form.role);

  /*
   * You cannot change your own role or deactivate yourself.
   *
   * The failure it prevents is specific and unrecoverable at a small clinic: the
   * only administrator demotes themselves, and now nobody can manage staff. The
   * server has the same guard; this is so the screen does not offer it.
   */
  const isSelf = user?.id === session.userId;

  return (
    <Dialog open={user !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{user?.fullName}</DialogTitle>
        </DialogHeader>

        <p className="token text-xs text-ink-faint">{user?.email}</p>

        <Field label="Full name" htmlFor="edit-name" required>
          <Input
            id="edit-name"
            value={form.fullName}
            onChange={(event) => set({ fullName: event.target.value })}
          />
        </Field>

        <Field
          label="Role"
          htmlFor="edit-role"
          hint={isSelf ? 'You cannot change your own role.' : chosen?.detail}
        >
          <Select
            id="edit-role"
            value={form.role}
            disabled={isSelf}
            onChange={(event) => set({ role: event.target.value as UserRole })}
          >
            {ASSIGNABLE_ROLES.map((role) => (
              <option key={role.value} value={role.value}>
                {ROLE_LABEL[role.value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Mobile" htmlFor="edit-mobile">
          <Input
            id="edit-mobile"
            value={form.mobileE164}
            onChange={(event) => set({ mobileE164: event.target.value })}
          />
        </Field>

        {isClinician(form.role) ? (
          <>
            {!form.medicalRegistrationNumber.trim() ? (
              <Alert tone="warning" title="This doctor cannot sign prescriptions">
                Add the medical registration number to unblock signing. The change
                applies immediately — the signing gate is not cached across it.
              </Alert>
            ) : null}

            <FieldGrid>
              <Field label="Medical registration number" htmlFor="edit-reg">
                <Input
                  id="edit-reg"
                  value={form.medicalRegistrationNumber}
                  onChange={(event) => set({ medicalRegistrationNumber: event.target.value })}
                />
              </Field>
              <Field label="Medical council" htmlFor="edit-council">
                <Input
                  id="edit-council"
                  value={form.medicalCouncil}
                  onChange={(event) => set({ medicalCouncil: event.target.value })}
                />
              </Field>
              <Field label="Qualifications" htmlFor="edit-quals">
                <Input
                  id="edit-quals"
                  value={form.qualifications}
                  onChange={(event) => set({ qualifications: event.target.value })}
                />
              </Field>
              <Field label="Specialty" htmlFor="edit-specialty">
                <Input
                  id="edit-specialty"
                  value={form.specialty}
                  onChange={(event) => set({ specialty: event.target.value })}
                />
              </Field>
            </FieldGrid>
          </>
        ) : null}

        {!isSelf ? (
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.isActive}
              onChange={(event) => set({ isActive: event.target.checked })}
            />
            <span>
              Active
              <span className="block text-2xs text-ink-faint">
                Deactivating stops them signing in. Their record stays, because
                everything they authored must keep naming them.
              </span>
            </span>
          </label>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={form.fullName.trim().length < 2}
            loading={update.isPending}
            onClick={() =>
              user &&
              update.mutate(
                {
                  id: user.id,
                  fullName: form.fullName.trim(),
                  // Never send a role change for yourself, even if something
                  // contrived past the disabled control.
                  ...(isSelf ? {} : { role: form.role, isActive: form.isActive }),
                  mobileE164: form.mobileE164 || null,
                  medicalRegistrationNumber: form.medicalRegistrationNumber || null,
                  medicalCouncil: form.medicalCouncil || null,
                  qualifications: form.qualifications || null,
                  specialty: form.specialty || null,
                },
                {
                  onSuccess: () => {
                    toast.success('Saved');
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
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------- *
 * Reset password
 * ------------------------------------------------------------------------- */

export function ResetStaffPasswordDialog({
  user,
  onClose,
}: {
  user: StaffUser | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const reset = useResetStaffPassword();
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');

  React.useEffect(() => {
    setPassword('');
    setConfirmation('');
  }, [user]);

  const problem = passwordProblem(password, confirmation);

  return (
    <Dialog open={user !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {/*
        Dismissable again. It was undismissable while a generated password was
        on screen, because closing it lost the only copy; nothing here is
        unrecoverable now.
      */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set a new password for {user?.fullName}</DialogTitle>
        </DialogHeader>

        <Alert tone="info" title="There is no self-service reset in this product">
          No mail provider is connected, and a reset link that never arrives is
          worse than none. Set a password here and tell them what it is.
        </Alert>

        <PasswordPair
          idPrefix="reset"
          label="New password"
          hint="At least 8 characters."
          password={password}
          confirmation={confirmation}
          onPassword={setPassword}
          onConfirmation={setConfirmation}
        />

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={problem !== null}
            loading={reset.isPending}
            onClick={() =>
              user &&
              reset.mutate(
                { id: user.id, password },
                {
                  onSuccess: () => {
                    toast.success(
                      'Password updated',
                      `Tell ${user.fullName} what you set.`,
                    );
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not work',
                    ),
                },
              )
            }
          >
            Set password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Drops empty strings so the server stores null rather than "". */
function cleaned(form: {
  fullName: string;
  email: string;
  role: UserRole;
  mobileE164: string;
  medicalRegistrationNumber: string;
  medicalCouncil: string;
  qualifications: string;
  specialty: string;
  password: string;
}): InviteStaffInput {
  return {
    fullName: form.fullName.trim(),
    email: form.email.trim(),
    role: form.role,
    // Sent as typed. Trimming a password silently changes it, and the person
    // who then cannot sign in has no way to discover why.
    password: form.password,
    mobileE164: form.mobileE164.trim() || null,
    medicalRegistrationNumber: form.medicalRegistrationNumber.trim() || null,
    medicalCouncil: form.medicalCouncil.trim() || null,
    qualifications: form.qualifications.trim() || null,
    specialty: form.specialty.trim() || null,
  };
}
