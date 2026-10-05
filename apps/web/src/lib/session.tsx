'use client';

import * as React from 'react';
import { useIsRestoring, useQuery } from '@tanstack/react-query';
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
  /*
   * `isRestoring` is not optional here, and neither is `status`.
   *
   * The query cache is restored from the device asynchronously. While that is
   * happening TanStack Query holds queries idle, so `isLoading` — which is
   * `isPending && isFetching` — reports FALSE even though nothing has been
   * fetched yet. A guard written against `isLoading` therefore sees "not
   * loading, no session" on first paint and bounces a signed-in user to the
   * sign-in screen.
   *
   * That is what used to happen on every fresh load of a deep link. Wait for
   * restoration to finish, and treat `pending` as still loading.
   */
  const isRestoring = useIsRestoring();

  const { data, status } = useQuery({
    queryKey: qk.session,
    queryFn: () => api.get<Session>('/auth/me'),
    initialData: initialSession ?? undefined,
    staleTime: 60_000,
    retry: false,
  });

  const isLoading = isSessionLoading({
    isRestoring,
    status,
    hasSession: data !== undefined,
  });

  const value = React.useMemo(
    () => ({ session: data ?? null, isLoading }),
    [data, isLoading],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Whether we still do not know who the signed-in user is.
 *
 * A PURE FUNCTION WITH TESTS, because the obvious way to write this is wrong in
 * a way nothing catches. `isLoading` here does not mean "a request is in
 * flight" — it means "we cannot yet say who this is", and the authenticated
 * layout replaces the ENTIRE APP with a spinner while it is true.
 *
 * THE BUG THIS FIXES. The condition used to include `fetchStatus === 'fetching'`,
 * so any background refetch of `/auth/me` blanked the whole clinic to a spinner
 * and then remounted it. Remounting discards React state, and the state it
 * discarded was the state that mattered: the staff screen invalidates the
 * session after every mutation — correctly, because an administrator who renames
 * or demotes someone should see their own sidebar change rather than keep a
 * stale one — so **creating a staff member or issuing a password unmounted the
 * dialog that was displaying the one-time password.**
 *
 * The password flashed up and vanished with the dialog. It is not stored in
 * plaintext and cannot be shown again, so the only recovery was to issue
 * another one and watch that disappear too. From the outside it looked like no
 * password was being generated at all, which is how it was reported.
 *
 * `hasSession` is checked FIRST and short-circuits. Once we know who the user
 * is we are never "loading" again, whatever a refetch is doing — a slightly
 * stale session for a few hundred milliseconds is correct, and is what every
 * other screen in this product already assumes. The restore case the comment
 * above describes is still covered: during restoration there is no data, so
 * `isRestoring` and `pending` both still hold.
 */
export function isSessionLoading(state: {
  /** The persisted query cache is still being read off the device. */
  isRestoring: boolean;
  status: 'pending' | 'error' | 'success';
  /** We have a session object — from the server, the cache, or a fetch. */
  hasSession: boolean;
}): boolean {
  // Knowing who the user is settles the question. A refetch in the background
  // must never blank the app, because blanking it destroys what is on screen.
  if (state.hasSession) return false;

  // No session yet. Both of these mean "not yet known" rather than "nobody":
  // returning false here is what bounced a signed-in user to the sign-in screen
  // on a cold load of a deep link.
  return state.isRestoring || state.status === 'pending';
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
