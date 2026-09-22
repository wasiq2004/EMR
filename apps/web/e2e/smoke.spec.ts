import { expect, test, type Page } from '@playwright/test';

/**
 * Every screen, opened in a real browser, as each role.
 *
 * The rule: a console error fails the test. A React render error, a missing
 * key, a failed fetch — all of it surfaces on the console, and none of it
 * surfaces in an HTTP status code.
 */

/**
 * The fixture clinic.
 *
 * There is no seeded data: the product ships with no clinics and no accounts.
 * `scripts/verify/fixtures.mjs up` builds a clinic and exports these, so the
 * browser suite runs against records it created and can delete afterwards
 * rather than against invented ones living in the database.
 */
const DOMAIN = process.env.VERIFY_DOMAIN;
const PASSWORD = process.env.VERIFY_PASSWORD;

if (!DOMAIN || !PASSWORD) {
  throw new Error(
    'Set VERIFY_DOMAIN and VERIFY_PASSWORD. Run: ' +
      'eval "$(node scripts/verify/fixtures.mjs up)" && npx playwright test',
  );
}

const SIGN_IN: Record<string, string> = {
  RECEPTIONIST: `reception@${DOMAIN}`,
  DOCTOR: `doctor@${DOMAIN}`,
  NURSE_ASSISTANT: `nurse@${DOMAIN}`,
  OWNER_ADMIN: `owner@${DOMAIN}`,
  AUDITOR: `auditor@${DOMAIN}`,
};

/** Noise from the dev server that says nothing about the application. */
const IGNORED = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /favicon/i,
];

/**
 * Refusals that are the correct behaviour, not faults.
 *
 * The share-link resolver answers 403 to an unverified recipient so the page
 * can ask for the one-time code — a 200 there would mean the document had been
 * handed over without checking who was asking.
 *
 * `/api/auth/me` answers 401 when nobody is signed in, which is what the public
 * screens are. The alternative — 200 with an empty body — would make "signed
 * out" and "session broken" the same response.
 *
 * Nothing else belongs in this list. A 403 anywhere a role is supposed to be
 * able to work is a bug in the permission matrix or in the screen, and adding
 * it here is how that bug becomes permanent.
 */
const EXPECTED_REFUSALS: [number, RegExp][] = [
  // 403 asks the recipient for the one-time code; 404 is an unknown, revoked or
  // expired token. The API returns the same 404 for all three on purpose —
  // telling a stranger that a link existed and has been revoked tells them a
  // document exists and who it is about.
  [403, /^\/api\/share\//],
  [404, /^\/api\/share\//],
  [401, /^\/api\/auth\/me$/],
];

function watchConsole(page: Page): string[] {
  const problems: string[] = [];

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORED.some((pattern) => pattern.test(text))) return;
    // The browser logs its own line for a failed request. The response
    // listener below reports those with the URL attached, which is more
    // useful, so drop the duplicate rather than reporting it twice.
    if (/Failed to load resource/i.test(text)) return;
    problems.push(`console.error: ${text}`);
  });

  page.on('pageerror', (error) => {
    problems.push(`uncaught: ${error.message}`);
  });

  // A failed request says which URL it was, which the console message does not.
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (IGNORED.some((pattern) => pattern.test(url.pathname))) return;
    if (EXPECTED_REFUSALS.some(([status, pattern]) =>
      response.status() === status && pattern.test(url.pathname))) return;
    problems.push(`${response.status()} ${url.pathname}${url.search}`);
  });

  return problems;
}

async function signIn(page: Page, role: keyof typeof SIGN_IN) {
  const response = await page.request.post('/api/auth/login', {
    data: { email: SIGN_IN[role], password: PASSWORD },
  });

  // Fail here rather than twenty screens later. A refused sign-in sends every
  // subsequent visit to /login, where nothing errors and every assertion
  // passes — the suite goes green having tested the login page five times.
  expect(
    response.ok(),
    `sign-in failed for ${role}: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

/** Opens a route and fails on a console error or the Next error overlay. */
async function visit(page: Page, path: string, problems: string[]) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });

  // Let the session query resolve and the shell render — the error we shipped
  // only appeared after that point.
  await page.waitForTimeout(900);

  const overlay = page.locator('nextjs-portal');
  if (await overlay.count()) {
    const text = await overlay.first().innerText().catch(() => '');
    if (/error/i.test(text)) problems.push(`error overlay on ${path}: ${text.slice(0, 200)}`);
  }

  expect(problems, `${path} reported problems`).toEqual([]);
}

test.describe('public screens', () => {
  test('sign in, two-factor and the share link render', async ({ page }) => {
    const problems = watchConsole(page);
    for (const path of ['/login', '/login/mfa', '/share/not-a-real-token']) {
      await visit(page, path, problems);
    }

    // The refusal has to be a page, not a blank screen: someone holding a link
    // that no longer works needs to be told so, in words.
    await expect(page.getByText(/not valid|expired|no longer/i).first()).toBeVisible();
  });
});

const CLINIC_ROUTES = [
  '/today',
  '/queue',
  '/appointments',
  '/appointments/new',
  '/patients',
  '/patients/new',
  '/documents',
  '/inbox',
  '/inbox/unlinked',
  '/tasks',
];

const ADMIN_ROUTES = [
  '/patients/merge',
  '/billing',
  '/billing/invoices/new',
  '/reports',
  '/settings/clinic',
  '/settings/locations',
  '/settings/users',
  '/settings/services',
  '/settings/encounter-templates',
  '/settings/prescription-templates',
  '/settings/whatsapp',
  '/settings/message-templates',
  '/settings/consent',
  '/settings/import',
  '/settings/export',
  '/settings/account',
];

test('Front Desk opens every screen it can reach', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'RECEPTIONIST');
  for (const path of CLINIC_ROUTES) await visit(page, path, problems);
});

test('Doctor opens every screen it can reach', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'DOCTOR');
  for (const path of [...CLINIC_ROUTES, '/billing', '/reports']) {
    await visit(page, path, problems);
  }
});

test('Nurse opens every screen it can reach', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'NURSE_ASSISTANT');
  for (const path of CLINIC_ROUTES) await visit(page, path, problems);
});

test('Clinic Admin opens every screen including settings', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'OWNER_ADMIN');
  for (const path of [...CLINIC_ROUTES, ...ADMIN_ROUTES]) {
    await visit(page, path, problems);
  }
});

test('Compliance opens its own two screens', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'AUDITOR');
  for (const path of ['/audit', '/audit/reports']) await visit(page, path, problems);
});

test('patient record and consultation render for a doctor', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'DOCTOR');

  const search = await page.request.get('/api/patients/search?q=Lakshmi');
  const patientId = (await search.json()).items[0].id as string;

  for (const suffix of ['', '/visits', '/documents', '/billing', '/consents', '/edit']) {
    await visit(page, `/patients/${patientId}${suffix}`, problems);
  }

  /*
   * Start the consultation the way a doctor does, by pressing the button on
   * the Snapshot, rather than seeding one over the API. It is the better test:
   * it exercises the button, the mutation, the redirect and the new route,
   * which is the sequence that actually breaks.
   */
  await page.goto(`/patients/${patientId}`);
  // Wait for the Snapshot to settle. The action bar re-renders as the
  // aggregate load resolves, so clicking too early catches a button that is
  // about to be replaced.
  await expect(page.getByRole('heading', { name: /severe allergy/i })).toBeVisible();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /start consultation/i }).click();
  await page.waitForURL(/\/encounters\/[0-9a-f-]+$/, { timeout: 20_000 });
  await page.waitForTimeout(900);
  expect(problems, 'opening the consultation reported problems').toEqual([]);

  const encounterId = page.url().split('/encounters/')[1]!;
  for (const suffix of ['/preview', '/amend']) {
    await visit(page, `/encounters/${encounterId}${suffix}`, problems);
  }
});
