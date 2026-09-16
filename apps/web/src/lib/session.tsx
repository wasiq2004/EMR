'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { can, type Permission, type Session } from '@emr/contracts';
import { api } from './api-client';
import { qk } from './query-client';

/**
 * The signed-in user.
 *
 * `useCan` is the only sanctioned way for a component to ask whether to render
 * an action. It reads the shared permission matrix, so a screen can never offer
 * something the API will refuse — and equally, it can never grant anything,
 * because the API checks again and is the only authority.
 */

interface SessionContextValue {
  session: Session | null;
  isLoading: boolean;
}

const SessionContext = React.createContext<SessionContextValue>({
  session: null,
  isLoading: true,
});

export function SessionProvider({
  children,
  initialSession,
}: {
  children: React.ReactNode;
  initialSession?: Session | null;
}) {
  const { data, isLoading } = useQuery({
    queryKey: qk.session,
    queryFn: () => api.get<Session>('/auth/me'),
    initialData: initialSession ?? undefined,
    staleTime: 60_000,
    retry: false,
  });

  const value = React.useMemo(
    () => ({ session: data ?? null, isLoading }),
    [data, isLoading],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const { session } = React.useContext(SessionContext);
  if (!session) {
    // Reaching this means a signed-in screen rendered outside the authenticated
    // layout. That is a routing bug, not a runtime condition to handle.
    throw new Error('useSession called outside an authenticated layout');
  }
  return session;
}

export function useOptionalSession(): SessionContextValue {
  return React.useContext(SessionContext);
}

/** True when the signed-in role holds the permission. Navigation only. */
export function useCan(permission: Permission): boolean {
  const { session } = React.useContext(SessionContext);
  return session ? can(session.role, permission) : false;
}

export function useCanAny(permissions: Permission[]): boolean {
  const { session } = React.useContext(SessionContext);
  if (!session) return false;
  return permissions.some((p) => can(session.role, p));
}

/**
 * Whether this user may sign a prescription.
 *
 * Holding DOCTOR is necessary but not sufficient — a registration number must
 * be on file, because it is a legal element of a valid Indian e-prescription
 * and would otherwise print blank. The UI explains this up front rather than
 * letting a doctor write a whole prescription and fail at the last step.
 */
export function useCanSign(): { allowed: boolean; reason: string | null } {
  const { session } = React.useContext(SessionContext);
  if (!session) return { allowed: false, reason: 'Not signed in' };

  if (!can(session.role, 'prescription:sign')) {
    return {
      allowed: false,
      reason: 'Only a doctor can sign a prescription.',
    };
  }

  if (!session.hasMedicalRegistration) {
    return {
      allowed: false,
      reason:
        'Your medical registration number is not on file. A clinic administrator ' +
        'must add it under Staff and roles before you can sign.',
    };
  }

  return { allowed: true, reason: null };
}
