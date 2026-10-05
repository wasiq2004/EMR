import { describe, expect, it } from 'vitest';
import { clinicSlugFromHost } from './clinic-host';

/**
 * Which clinic a request is addressed to.
 *
 * Tested because getting it wrong does not fail loudly. A wrong answer here
 * returns a slug that matches no clinic, the sign-in resolver finds nobody, and
 * the user is told "that email and password do not match" — while holding a
 * correct password. There is no error anywhere and nothing to search for.
 *
 * That is not hypothetical: a single-clinic deployment at `emr.nuvalyf.com` had
 * exactly this, and `emr` was read as a clinic slug.
 */

const APP_HOSTS = ['emr.nuvalyf.com'];

describe('clinicSlugFromHost', () => {
  /*
   * THE REGRESSION. One clinic, one domain, the app's own name as the first
   * label. Before the appHosts check this returned 'emr' and nobody could sign
   * in.
   */
  it('reads no clinic from the application’s own host', () => {
    expect(clinicSlugFromHost('emr.nuvalyf.com', APP_HOSTS)).toBeNull();
  });

  it('ignores the port when matching the application host', () => {
    expect(clinicSlugFromHost('emr.nuvalyf.com:3000', APP_HOSTS)).toBeNull();
  });

  it('matches the application host case-insensitively', () => {
    expect(clinicSlugFromHost('EMR.NuvaLyf.com', APP_HOSTS)).toBeNull();
  });

  /*
   * And the behaviour that must NOT regress: a genuine multi-tenant estate
   * still resolves the clinic from the subdomain.
   */
  it('still reads the clinic from a tenant subdomain', () => {
    expect(clinicSlugFromHost('sunrise.nuvalyf.com', APP_HOSTS)).toBe('sunrise');
    expect(clinicSlugFromHost('sunrise.nuvalyf.com:443', APP_HOSTS)).toBe('sunrise');
  });

  it('reads a clinic subdomain when no application host is configured', () => {
    expect(clinicSlugFromHost('sunrise.example.com', [])).toBe('sunrise');
  });

  /*
   * `www` and `app` stay reserved even with no configuration. A deployment that
   * never set PUBLIC_BASE_URL should still not read `www` as a clinic, and no
   * clinic may be named either.
   */
  it('never reads www or app as a clinic', () => {
    expect(clinicSlugFromHost('www.example.com', [])).toBeNull();
    expect(clinicSlugFromHost('app.example.com', [])).toBeNull();
  });

  /** A bare domain has no subdomain to read. */
  it('reads no clinic from a bare domain', () => {
    expect(clinicSlugFromHost('example.com', [])).toBeNull();
    expect(clinicSlugFromHost('localhost', [])).toBeNull();
    expect(clinicSlugFromHost('localhost:3000', [])).toBeNull();
  });

  it('handles a missing or empty host', () => {
    expect(clinicSlugFromHost(undefined, [])).toBeNull();
    expect(clinicSlugFromHost('', [])).toBeNull();
    expect(clinicSlugFromHost(':3000', [])).toBeNull();
  });

  /*
   * A deeper host still takes the FIRST label. `sunrise.clinics.example.com` is
   * the sunrise clinic, not the clinics clinic.
   */
  it('takes the first label of a deeper hostname', () => {
    expect(clinicSlugFromHost('sunrise.clinics.example.com', [])).toBe('sunrise');
  });

  /*
   * Returning null is not "let anyone in" — it means "resolve by email across
   * clinics", and the resolver refuses anything but exactly one match. This
   * test documents the contract the caller depends on, so that if null ever
   * starts meaning something looser, it fails here first.
   */
  it('returns null rather than a guess, which the resolver treats as ambiguous', () => {
    expect(clinicSlugFromHost('emr.nuvalyf.com', APP_HOSTS)).toBeNull();
    expect(clinicSlugFromHost('example.com', [])).toBeNull();
  });
});
