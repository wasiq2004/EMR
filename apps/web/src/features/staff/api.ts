'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StaffUser, UserRole } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';

/**
 * Staff and roles.
 *
 * WHICH MUTATIONS REFRESH THE SIGNED-IN SESSION, and why it is not all of them.
 *
 * Editing a staff member can change what the person doing the editing may see —
 * rename yourself and the sidebar should say the new name — so `useUpdateStaff`
 * refreshes the session. Creating an account and issuing a password cannot
 * change the acting user's own permissions or name, so they do not.
 *
 * That distinction used to be absent, and it cost something concrete. Every
 * staff mutation refreshed the session, a session refresh briefly reported the
 * app as loading, and the authenticated layout replaces the whole app with a
 * spinner while that is true — which unmounted the dialog that was displaying
 * the one-time password it had just minted. The password appeared and vanished,
 * and since it is not recoverable, it read as no password being generated at
 * all.
 *
 * `isSessionLoading` in `lib/session.tsx` is the real fix: a background refetch
 * no longer blanks the app. This narrowing is the second half — a mutation that
 * cannot affect the current session should not be asking for it to be refetched
 * in the first place.
 */

export function useStaff() {
  return useQuery({
    queryKey: qk.staff,
    queryFn: () => api.get<{ items: StaffUser[] }>('/users'),
    select: (data) => data.items,
  });
}

/**
 * The staff list and everything that reads the same people.
 *
 * Deliberately NOT the session — see the header. Use `useInvalidateStaffAndSelf`
 * for a change that could alter the acting user's own name or permissions.
 */
function useInvalidateStaff() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.staff });
    // The practitioner picker on the appointment screen reads the same people.
    void queryClient.invalidateQueries({ queryKey: qk.practitioners });
  };
}

/** For an edit, which can change what the person doing the editing may see. */
function useInvalidateStaffAndSelf() {
  const queryClient = useQueryClient();
  const invalidateStaff = useInvalidateStaff();
  return () => {
    invalidateStaff();
    void queryClient.invalidateQueries({ queryKey: qk.session });
  };
}

export interface InviteStaffInput {
  fullName: string;
  email: string;
  role: UserRole;
  /** Chosen by the administrator creating the account. */
  password: string;
  mobileE164?: string | null;
  medicalRegistrationNumber?: string | null;
  medicalCouncil?: string | null;
  qualifications?: string | null;
  specialty?: string | null;
}

/**
 * Creates the account with the password the administrator chose.
 *
 * IT USED TO BE GENERATED — `randomBytes(9).toString('base64url')` — returned
 * once, and displayed in a dialog that could never show it again. That was
 * secure and widely disliked: an administrator setting up five people had five
 * unreadable strings to relay across a counter.
 *
 * Nothing comes back now but the account. There is no secret to display,
 * which also retires the dialog that had to protect one.
 */
export function useInviteStaff() {
  const invalidate = useInvalidateStaff();
  return useMutation({
    mutationFn: (input: InviteStaffInput) => api.post<{ user: StaffUser }>('/users', input),
    onSuccess: invalidate,
  });
}

/**
 * Patches a staff member.
 *
 * Deliberately a partial update: the screen sends only what changed, so two
 * administrators editing different fields of the same person do not overwrite
 * each other's work with a stale whole-object write.
 */
export function useUpdateStaff() {
  const invalidate = useInvalidateStaffAndSelf();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<InviteStaffInput> & {
      isActive?: boolean;
    }) => api.patch<{ user: StaffUser }>(`/users/${id}`, patch),
    onSuccess: invalidate,
  });
}

/**
 * Sets a new password.
 *
 * There is no self-service reset anywhere in this product — no "forgot password"
 * email, because no mail provider is connected and a reset link that never
 * arrives is worse than none. An administrator does it here.
 *
 * The administrator types the password, so nothing comes back to display. That
 * is the point: the old flow generated a string, returned it once, and the
 * screen had to show a secret it could never show again.
 */
export function useResetStaffPassword() {
  const invalidate = useInvalidateStaff();
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.post<{ ok: true }>(`/users/${id}/reset-password`, { password }),
    onSuccess: invalidate,
  });
}
