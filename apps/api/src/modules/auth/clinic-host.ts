/**
 * Which clinic a request is addressed to, from its hostname.
 *
 * ITS OWN MODULE, with no imports. It used to live in `auth.controller.ts`,
 * which cannot be loaded without a validated environment — `config.ts` throws at
 * import time if DATABASE_URL is missing — so the one piece of logic here that
 * is pure and worth testing could not be reached by a test. Pulling it out is
 * the whole reason there is now a test for it.
 */

/**
 * The clinic slug a host names, or null if it names none.
 *
 * Getting this wrong does not fail loudly. A wrong answer returns a slug that
 * matches no clinic, the sign-in resolver finds nobody, and the user is told
 * "that email and password do not match" while holding a correct password.
 * There is no error raised anywhere and nothing to search the logs for.
 *
 * THE CASE IT WAS MISSING. The product is addressed as
 * `{clinic-slug}.yourdomain.com`, so the first label is normally the clinic.
 * But the commonest deployment of all is ONE clinic on ONE domain —
 * `emr.example.com` — where the first label is the application's own name and
 * matches no clinic at all. `www` and `app` were special-cased by hand, which
 * shows the problem was half-seen: the real question is not "is this label one
 * of two reserved words" but "is this host the application itself", and only
 * the deployment can answer that. It already does, in PUBLIC_BASE_URL.
 *
 * NULL IS NOT "LET ANYONE IN". It means "resolve by email across every clinic",
 * and `auth_resolve_account` returns at most two rows so the caller can refuse
 * anything that is not exactly one match. A single-domain deployment therefore
 * signs in cleanly, while an address shared by two clinics where one person has
 * an account at both is still refused rather than guessed at.
 */
export function clinicSlugFromHost(
  host: string | undefined,
  appHosts: readonly string[],
): string | null {
  if (!host) return null;

  // Port stripped first: `emr.example.com:3000` is the same host.
  const name = (host.split(':')[0] ?? '').trim().toLowerCase();
  if (!name) return null;

  // The application's own address is not a clinic subdomain.
  if (appHosts.includes(name)) return null;

  const labels = name.split('.');
  // Two labels or fewer is a bare domain — `example.com`, or `localhost`.
  if (labels.length < 3) return null;

  const first = labels[0]!;
  /*
   * Kept alongside the appHosts check rather than replaced by it. A deployment
   * that never set PUBLIC_BASE_URL still should not read `www` as a clinic, and
   * no clinic may be called `www` or `app` anyway.
   */
  return first === 'www' || first === 'app' ? null : first;
}
