import { describe, expect, it } from 'vitest';
import { isSessionLoading } from './session';

/**
 * When the app is allowed to say "we do not know who you are".
 *
 * This predicate decides whether the authenticated layout renders the clinic or
 * replaces the whole thing with a spinner, so both ways of getting it wrong are
 * expensive and neither is visible to the type checker:
 *
 *   - TOO EAGER and a signed-in user is bounced to the sign-in screen on a cold
 *     load, because the cache had not finished restoring yet.
 *   - TOO BROAD and every background refetch of `/auth/me` unmounts the app,
 *     discarding whatever was on screen. That one shipped: the staff screen
 *     refreshes the session after a mutation, so creating a staff member threw
 *     away the dialog showing the one-time password it had just minted — and the
 *     password is not recoverable, so it looked as though none was generated.
 */

describe('isSessionLoading', () => {
  /*
   * THE REGRESSION TEST. A refetch with a session in hand must not report
   * loading. This is the case that unmounted the password dialog.
   */
  it('is not loading while refetching a session we already have', () => {
    expect(
      isSessionLoading({ isRestoring: false, status: 'success', hasSession: true }),
    ).toBe(false);
  });

  it('is not loading when the session came from the server on first paint', () => {
    // `initialData` makes the query succeed synchronously, before any fetch.
    expect(
      isSessionLoading({ isRestoring: false, status: 'success', hasSession: true }),
    ).toBe(false);
  });

  /*
   * Having the user outranks everything else. Even mid-restore, even on a failed
   * refetch, a known user means the app keeps rendering rather than blanking.
   */
  it('is not loading when a session exists, whatever else is happening', () => {
    expect(
      isSessionLoading({ isRestoring: true, status: 'pending', hasSession: true }),
    ).toBe(false);
    expect(
      isSessionLoading({ isRestoring: false, status: 'error', hasSession: true }),
    ).toBe(false);
  });

  /*
   * The other failure, and the reason the restore check exists at all. During
   * restoration TanStack holds the query idle, so its own `isLoading` is false
   * while nothing has been fetched — and a guard reading that sees "not loading,
   * no session" and redirects a signed-in user to sign in again.
   */
  it('is loading while the cache is still being restored', () => {
    expect(
      isSessionLoading({ isRestoring: true, status: 'pending', hasSession: false }),
    ).toBe(true);
  });

  it('is loading while the first fetch is still pending', () => {
    expect(
      isSessionLoading({ isRestoring: false, status: 'pending', hasSession: false }),
    ).toBe(true);
  });

  /*
   * A settled failure with no session is genuinely nobody — `retry: false`, so
   * this is the end of the road. Reporting loading here would spin forever
   * instead of sending them to the sign-in screen.
   */
  it('is not loading once the fetch has failed and there is no session', () => {
    expect(
      isSessionLoading({ isRestoring: false, status: 'error', hasSession: false }),
    ).toBe(false);
  });

  /*
   * Succeeded, restored, and still no session. Signed out: send them to sign in
   * rather than holding a spinner.
   */
  it('is not loading when the answer is that nobody is signed in', () => {
    expect(
      isSessionLoading({ isRestoring: false, status: 'success', hasSession: false }),
    ).toBe(false);
  });
});
