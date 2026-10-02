'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StaffUser, UserRole } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';

/**
 * Staff and roles.
 *
 * Every mutation invalidates the staff list AND the session, because changing a
 * role can change what the person doing the changing may see — an administrator
 * who demotes themselves should watch their own sidebar shrink rather than keep a
 * stale one until the next reload.
 */

export function useStaff() {
  return useQuery({
    queryKey: qk.staff,
    queryFn: () => api.get<{ items: StaffUser[] }>('/users'),
    select: (data) => data.items,
  });
}

function useInvalidateStaff() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.staff });
    void queryClient.invalidateQueries({ queryKey: qk.session });
    // The practitioner picker on the appointment screen reads the same people.
    void queryClient.invalidateQueries({ queryKey: qk.practitioners });
  };
}

export interface InviteStaffInput {
  fullName: string;
  email: string;
  role: UserRole;
  mobileE164?: string | null;
  medicalRegistrationNumber?: string | null;
  medicalCouncil?: string | null;
  qualifications?: string | null;
  specialty?: string | null;
}

/** Creates the account and returns its one-time password, shown once. */
export function useInviteStaff() {
  const invalidate = useInvalidateStaff();
  return useMutation({
    mutationFn: (input: InviteStaffInput) =>
      api.post<{ user: StaffUser; temporaryPassword: string }>('/users', input),
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
  const invalidate = useInvalidateStaff();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<InviteStaffInput> & {
      isActive?: boolean;
    }) => api.patch<{ user: StaffUser }>(`/users/${id}`, patch),
    onSuccess: invalidate,
  });
}

/**
 * Issues a new password.
 *
 * There is no self-service reset anywhere in this product — no "forgot password"
 * email, because no mail provider is connected and a reset link that never
 * arrives is worse than none. An administrator does it here and reads the new
 * password out.
 */
export function useResetStaffPassword() {
  const invalidate = useInvalidateStaff();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ temporaryPassword: string }>(`/users/${id}/reset-password`, {}),
    onSuccess: invalidate,
  });
}
