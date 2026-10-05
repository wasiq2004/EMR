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
  PHARMACIST: `pharmacist@${DOMAIN}`,
  RESEARCH_ANALYST: `analyst@${DOMAIN}`,
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

/**
 * The first given UTC weekday at least `days` from now, at UTC midnight.
 *
 * `weekday` is 0 = Sunday, matching `getUTCDay()` and the
 * `practitioner_schedule` column. UTC throughout because these dates are
 * compared against ISO dates the API returns, and mixing a local weekday with a
 * UTC date is wrong for part of every day on any machine east of Greenwich.
 */
function utcWeekdayAfter(days: number, weekday: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d;
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
  '/calendar',
  '/appointments',
  '/appointments/new',
  '/patients',
  '/patients/new',
  '/documents',
  '/inbox',
  '/inbox/unlinked',
  '/tasks',
];

/*
 * Routes that need clinical read access.
 *
 * NOT in `CLINIC_ROUTES`, which every clinic role walks. A lab result is a
 * measured fact about somebody's body, and reception — who sees names and
 * appointments but no clinical detail — holds no `labOrder:read`. Walking them
 * through `/lab` made the page fire two 403s, which is the API behaving
 * correctly and the test asking the wrong question. The navigation already does
 * not offer it to them, so a receptionist would never arrive here.
 */
const CLINICAL_ROUTES = ['/lab'];

const ADMIN_ROUTES = [
  '/patients/merge',
  '/billing',
  '/billing/invoices/new',
  '/reports',
  '/reports/analytics',
  '/settings/clinic',
  '/settings/locations',
  '/settings/users',
  '/settings/services',
  '/settings/schedules',
  '/settings/reminders',
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
  for (const path of [...CLINIC_ROUTES, ...CLINICAL_ROUTES, '/billing', '/reports']) {
    await visit(page, path, problems);
  }
});

test('Nurse opens every screen it can reach', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'NURSE_ASSISTANT');
  for (const path of [...CLINIC_ROUTES, ...CLINICAL_ROUTES]) {
    await visit(page, path, problems);
  }
});

test('Clinic Admin opens every screen including settings', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'OWNER_ADMIN');
  for (const path of [...CLINIC_ROUTES, ...CLINICAL_ROUTES, ...ADMIN_ROUTES]) {
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

/**
 * The calendar, actually used.
 *
 * "The page rendered" proves very little about a calendar. The grid positions
 * everything absolutely from minutes-since-midnight, the slots are derived
 * server-side and drawn client-side, and a timezone mistake anywhere in that
 * chain produces a page that renders perfectly with the appointments in the
 * wrong place. So this one books through the interface and checks the number
 * changes.
 */
test('the calendar draws a doctor’s day and books into it', async ({ page }) => {
  const problems = watchConsole(page);

  /*
   * The working week is set over the API, as an administrator.
   *
   * Not through the settings screen: that screen has its own coverage in the
   * route walk, and driving it here would mean this test fails for reasons that
   * have nothing to do with the calendar.
   */
  await signIn(page, 'OWNER_ADMIN');

  const staff = await page.request.get('/api/practitioners');
  const doctor = (await staff.json()).items.find(
    (row: { fullName: string }) => row.fullName === 'Dr Test Doctor',
  ) as { id: string };
  expect(doctor, 'the fixture doctor is bookable').toBeTruthy();

  /*
   * A Wednesday a month out: far enough that no fixture appointment lands on it,
   * and inside the 120-day range the API allows.
   *
   * UTC throughout. Advancing a local date by weekday and then formatting it is
   * right for most of the day and wrong between midnight and 05:30 on a
   * UTC+5:30 machine, where a local Wednesday is still Tuesday in UTC — which
   * made this suite pass every afternoon and fail overnight.
   */
  const target = utcWeekdayAfter(30, 3);
  const date = target.toISOString().slice(0, 10);
  const saved = await page.request.post('/api/availability/schedules', {
    data: {
      practitionerId: doctor.id,
      weekday: 3,
      startsAt: '09:00',
      endsAt: '10:00',
      slotMinutes: 15,
    },
  });
  expect(saved.ok(), `saving a schedule failed: ${await saved.text()}`).toBe(true);
  const scheduleId = (await saved.json()).id as string;

  try {
    await signIn(page, 'RECEPTIONIST');

    // The day is addressable, so the test goes straight to it. That is not a
    // convenience for the test: a calendar whose state is not in the URL cannot
    // be linked, bookmarked or backed out of.
    await page.goto(`/calendar?view=day&date=${date}`);
    await page.waitForTimeout(1500);

    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();

    const dayLabel = target.toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });

    // The slots are buttons labelled with their time and whether they are free.
    const freeSlots = page.getByRole('button', { name: /— free$/ });
    await expect(freeSlots.first()).toBeVisible({ timeout: 15_000 });
    expect(await freeSlots.count(), `four 15-minute slots on ${dayLabel}`).toBe(4);

    // The strip above the grid must say the day is empty before anything is
    // booked. A strip that always reads zero is the failure mode worth catching.
    await expect(page.getByText('Free slots')).toBeVisible();

    await freeSlots.first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/Book this slot/i)).toBeVisible();

    // Booking through the dialog, patient search and all.
    await page.getByPlaceholder('Search the registry').fill('Lakshmi');
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /Lakshmi/i }).first().click();
    await page.getByRole('button', { name: /^Book \d+ min$/ }).click();

    // The dialog closes and the grid now holds the appointment: three free
    // slots, not four. This is the assertion that fails if the booking landed
    // on the wrong day — which is what a timezone slip looks like from here.
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(await page.getByRole('button', { name: /— free$/ }).count()).toBe(3);

    expect(problems, 'the calendar reported problems').toEqual([]);
  } finally {
    // The appointment goes with the clinic at teardown; the schedule is removed
    // explicitly so a re-run against a surviving tenant starts clean.
    await signIn(page, 'OWNER_ADMIN');
    await page.request.post(`/api/availability/schedules/${scheduleId}/remove`);
  }
});

/**
 * Live updates: a booking at the front desk reaching the doctor's calendar.
 *
 * TWO BROWSER CONTEXTS, because that is the only way to test this. One tab
 * cannot prove that an event crossed between sessions, and a single-context
 * test passes on the local cache invalidation alone — which is exactly what was
 * broken here. Three separate things had to be wrong at once for the feature to
 * fail silently:
 *
 *   - the server never emitted on a new booking (every other transition did),
 *   - the client's `EVENT_TYPES` list had no `appointment-changed` entry, so
 *     `EventSource` had no listener for it and dropped it on arrival,
 *   - and the 60-second poll hid all of it, so the screen did update, eventually.
 *
 * The assertion is therefore specifically about the window BEFORE that poll
 * could fire. A `waitFor` with a generous timeout would pass on the poll and
 * prove nothing.
 */
test('a booking at the front desk reaches the doctor’s calendar live', async ({ browser }) => {
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await signIn(adminPage, 'OWNER_ADMIN');

  const staff = await adminPage.request.get('/api/practitioners');
  const doctor = (await staff.json()).items.find(
    (row: { fullName: string }) => row.fullName === 'Dr Test Doctor',
  ) as { id: string };

  // A Thursday this time, so this test cannot collide with the one above. UTC
  // throughout, for the reason given on the calendar test.
  const target = utcWeekdayAfter(30, 4);
  const date = target.toISOString().slice(0, 10);

  const saved = await adminPage.request.post('/api/availability/schedules', {
    data: {
      practitionerId: doctor.id,
      weekday: 4,
      startsAt: '11:00',
      endsAt: '12:00',
      slotMinutes: 15,
    },
  });
  expect(saved.ok(), `saving a schedule failed: ${await saved.text()}`).toBe(true);
  const scheduleId = (await saved.json()).id as string;

  const doctorContext = await browser.newContext();
  const frontDesk = await browser.newContext();

  try {
    const doctorPage = await doctorContext.newPage();
    const problems = watchConsole(doctorPage);
    await signIn(doctorPage, 'DOCTOR');
    await doctorPage.goto(`/calendar?view=day&date=${date}`);
    await doctorPage.waitForTimeout(2000);

    const free = doctorPage.getByRole('button', { name: /— free$/ });
    await expect(free.first()).toBeVisible({ timeout: 15_000 });
    expect(await free.count(), 'four slots before anything is booked').toBe(4);

    // The front desk books, in a different session, over the API — which is
    // what the booking dialog does, and keeps this test about the stream rather
    // than about the dialog (covered above).
    const frontDeskPage = await frontDesk.newPage();
    await signIn(frontDeskPage, 'RECEPTIONIST');
    const patients = await frontDeskPage.request.get('/api/patients/search?q=Lakshmi');
    const patientId = (await patients.json()).items[0].id as string;

    const start = new Date(`${date}T11:00:00`);
    const booked = await frontDeskPage.request.post('/api/appointments', {
      data: {
        patientId,
        practitionerId: doctor.id,
        scheduledStart: start.toISOString(),
        scheduledEnd: new Date(start.getTime() + 15 * 60_000).toISOString(),
      },
    });
    expect(booked.ok(), `booking failed: ${await booked.text()}`).toBe(true);

    /*
     * Eight seconds, not sixty.
     *
     * The calendar polls every 60s, so any timeout at or above that proves
     * nothing about the live stream — it proves the poll works. This window is
     * comfortably long for an SSE round trip and comfortably short of the poll.
     */
    await expect(async () => {
      expect(await doctorPage.getByRole('button', { name: /— free$/ }).count()).toBe(3);
    }).toPass({ timeout: 8_000 });

    expect(problems, 'the live update reported problems').toEqual([]);
  } finally {
    await adminPage.request.post(`/api/availability/schedules/${scheduleId}/remove`);
    await doctorContext.close();
    await frontDesk.close();
    await admin.close();
  }
});

/**
 * The Stage D checkpoint: one consultation capturing everything, by keyboard.
 *
 * A server-side suite cannot see any of this. The vitals grid computes BMI from
 * two boxes as they are typed, the diagnosis picker has to offer free text
 * alongside its matches rather than only when the search fails, and the dosage
 * dialog has to open at all — the screen used to write `1-0-1`, `AFTER_FOOD`,
 * `5 days` straight to the server the moment a drug was chosen, and no API test
 * would notice, because the request was perfectly well formed. It was just
 * never what the doctor meant.
 */
test('a consultation records vitals, both kinds of diagnosis and a dosed drug', async ({
  page,
}) => {
  const problems = watchConsole(page);
  await signIn(page, 'DOCTOR');

  const search = await page.request.get('/api/patients/search?q=Arjun');
  const patientId = (await search.json()).items[0]?.id as string;
  expect(patientId, 'the fixture patient with no allergies is present').toBeTruthy();

  // Opened through the API: starting it by pressing the button is covered by the
  // test above, and doing it twice only makes this one slower to fail.
  const opened = await page.request.post('/api/encounters', { data: { patientId } });
  expect(opened.ok(), `opening a consultation failed: ${await opened.text()}`).toBe(true);
  const encounterId = (await opened.json()).id as string;

  await page.goto(`/encounters/${encounterId}`);
  await page.waitForTimeout(1500);

  /* ---- Vitals, including the derived BMI ---- */
  await page.getByRole('button', { name: /^Record$/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  // A systolic well outside the range has to be called out differently from one
  // merely above it — 145 is high and ordinary, 210 is somebody who should not
  // be sent back to the waiting room.
  await page.locator('#vital-8480-6').fill('210');
  await expect(page.getByText(/Well outside the usual range/i)).toBeVisible();

  // BMI appears only once BOTH numbers are present, and is calculated, never
  // typed. 72kg at 170cm is 24.9, which is "Overweight" on the Asian cut-offs
  // and "Normal" on the WHO international ones — this clinic is in India.
  await page.locator('#vital-29463-7').fill('72');
  await page.locator('#vital-8302-2').fill('170');
  await expect(page.getByText('24.9')).toBeVisible();
  await expect(page.getByText('Overweight')).toBeVisible();

  await page.getByRole('button', { name: /Save vitals/i }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
  await page.waitForTimeout(1200);

  // Read back from the server, so this asserts what was STORED rather than what
  // the dialog had in its boxes. The interpretation is derived server-side.
  const vitals = await page.request.get(`/api/patients/${patientId}/snapshot`);
  const latest = (await vitals.json()).latestVitals as {
    code: string;
    interpretation: string | null;
  }[];
  const systolic = latest.find((v) => v.code === '8480-6');
  expect(systolic?.interpretation, 'a systolic of 210 is stored as CRITICAL').toBe(
    'CRITICAL',
  );

  /* ---- A coded diagnosis, then a free-text one ---- */
  const diagnosisBox = page.getByLabel(/Search diagnoses/i);

  await diagnosisBox.fill('urti');
  await page.waitForTimeout(900);
  // Enter takes the highlighted match, which the word-boundary ranking puts on
  // J06.9 rather than on urticaria.
  await diagnosisBox.press('Enter');
  await page.waitForTimeout(1200);
  await expect(page.getByText('J06.9')).toBeVisible();

  // FREE TEXT IS OFFERED ALONGSIDE the matches, not only when there are none.
  // The commonest case is a doctor whose phrasing is close to a listed code but
  // who means something more specific, and hiding this whenever there are
  // results would make the nearest wrong code the path of least resistance.
  await diagnosisBox.fill('Viral URTI with secondary otitis, left');
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /Record .* as typed/i }).click();
  await page.waitForTimeout(1200);
  await expect(page.getByText(/secondary otitis/i)).toBeVisible();

  /* ---- A drug, with the dose actually asked for ---- */
  await page.getByLabel(/Search the drug catalogue/i).fill('azithral');
  await page.waitForTimeout(900);
  await page.getByLabel(/Search the drug catalogue/i).press('Enter');

  // The dialog that did not exist. Selecting a drug used to commit the line
  // immediately with three hardcoded values.
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '0-0-1', exact: true }).click();
  await page.getByRole('button', { name: '3d', exact: true }).click();

  // The quantity is arithmetic the prescriber should not be doing: one a day for
  // three days is three.
  await expect(page.locator('#dose-quantity')).toHaveValue('3');

  await page.getByRole('button', { name: /Add to prescription/i }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
  await page.waitForTimeout(1200);

  // Asserted against the server, because the whole bug was that the screen
  // displayed values the doctor never chose.
  const rx = await page.request.get(`/api/encounters/${encounterId}/prescriptions`);
  const lines = (await rx.json()) as {
    frequency: string;
    durationDays: number | null;
    quantity: number | null;
  }[];
  expect(lines).toHaveLength(1);
  expect(lines[0]?.frequency, 'the frequency chosen, not the old default').toBe('0-0-1');
  expect(lines[0]?.durationDays, 'the duration chosen, not five').toBe(3);
  expect(lines[0]?.quantity).toBe(3);

  /* ---- Changing a dose without deleting the line ---- */
  await page.getByRole('button', { name: /Change dose/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // It opens on what is recorded, not on the defaults.
  await expect(page.locator('#dose-frequency')).toHaveValue('0-0-1');
  await page.getByRole('button', { name: '1-0-1', exact: true }).click();
  await page.getByRole('button', { name: /Add to prescription/i }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
  await page.waitForTimeout(1200);

  const revised = await page.request.get(`/api/encounters/${encounterId}/prescriptions`);
  const after = (await revised.json()) as { frequency: string }[];
  expect(after, 'revising edits the line rather than adding another').toHaveLength(1);
  expect(after[0]?.frequency).toBe('1-0-1');

  expect(problems, 'the consultation screen reported problems').toEqual([]);
});

/* -------------------------------------------------------------------------- *
 * The three panels that had no render coverage at all
 *
 * Twenty-five screens — ten pharmacy, six analytics, nine platform — shipped
 * with nothing checking that they render. That is the gap these tests close, and
 * it is worth stating why a render check is not a trivial test here: every
 * screen in this product is gated on a session that resolves client-side, so the
 * HTML the server returns is a loading spinner. A page whose component throws
 * still answers 200 with plausible markup. Only a real browser, with any console
 * error failing the run, can tell the difference.
 * -------------------------------------------------------------------------- */

const PHARMACY_ROUTES = [
  '/pharmacy',
  '/pharmacy/clarifications',
  '/pharmacy/stock',
  '/pharmacy/products',
  '/pharmacy/suppliers',
  '/pharmacy/purchases',
  '/pharmacy/sales',
  '/pharmacy/alerts',
  '/pharmacy/reports',
];

const ANALYTICS_ROUTES = [
  '/analytics',
  '/analytics/cohorts',
  '/analytics/explorer',
  '/analytics/quality',
  '/analytics/dictionary',
  '/analytics/exports',
];

const PLATFORM_ROUTES = [
  '/platform',
  '/platform/tenants',
  '/platform/plans',
  '/platform/operators',
  '/platform/settings',
  '/platform/audit',
  '/platform/health',
];

test('Pharmacist opens every counter screen', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'PHARMACIST');
  for (const path of PHARMACY_ROUTES) await visit(page, path, problems);
});

test('Research analyst opens every analytics screen', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'RESEARCH_ANALYST');
  for (const path of ANALYTICS_ROUTES) await visit(page, path, problems);
});

/**
 * The operations console.
 *
 * A DIFFERENT SESSION ENTIRELY — a platform operator is not a clinic user, holds
 * a token with its own audience, and signs in at its own endpoint. That
 * separation is the point of the console, so the test has to honour it rather
 * than reusing a clinic cookie.
 */
test('Platform operator opens every console screen', async ({ page }) => {
  const problems = watchConsole(page);

  const email = process.env.VERIFY_OPERATOR_EMAIL;
  const password = process.env.VERIFY_OPERATOR_PASSWORD;
  expect(
    email && password,
    'Set VERIFY_OPERATOR_EMAIL and VERIFY_OPERATOR_PASSWORD — fixtures.mjs prints them.',
  ).toBeTruthy();

  const signedIn = await page.request.post('/api/platform/auth/login', {
    data: { email, password },
  });
  expect(
    signedIn.ok(),
    `platform sign-in failed: ${signedIn.status()} ${await signedIn.text()}`,
  ).toBe(true);

  for (const path of PLATFORM_ROUTES) await visit(page, path, problems);
});

/**
 * The console's login page, unauthenticated.
 *
 * Separate from the walk above because it is the one route in the set that must
 * render WITHOUT a session — and a redirect loop here would lock every operator
 * out of the console with no way back in.
 */
test('the operations console login renders without a session', async ({ browser }) => {
  const anonymous = await browser.newContext();
  try {
    const page = await anonymous.newPage();
    const problems = watchConsole(page);
    await visit(page, '/platform/login', problems);
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  } finally {
    await anonymous.close();
  }
});

/* -------------------------------------------------------------------------- *
 * The one-time password has to survive long enough to be read
 *
 * Only a real browser can catch what went wrong here, and the chain is worth
 * writing down because every link in it looked correct on its own:
 *
 *   1. The admin creates a staff member. The server mints a random password and
 *      returns it; the dialog puts it on screen.
 *   2. The mutation invalidates the session query — reasonably, so an
 *      administrator who renames someone sees their own sidebar update.
 *   3. The session provider reported `isLoading` while that refetch was in
 *      flight, because the condition included `fetchStatus === 'fetching'`.
 *   4. The authenticated layout replaces the ENTIRE APP with a spinner while
 *      `isLoading` is true. The dialog unmounted, taking its React state with
 *      it — and the password is argon2-hashed before the row is written, so the
 *      only plaintext copy in existence was the one just discarded.
 *
 * Nothing threw. No request failed. The password appeared for a few hundred
 * milliseconds and then both it and the dialog were gone, which from the
 * outside is indistinguishable from no password being generated at all — which
 * is how it was reported.
 *
 * So the assertion is not "a password is rendered" but "a password is STILL
 * rendered after the refetch that used to destroy it". A unit test covers the
 * predicate; this covers the four links joined together.
 * -------------------------------------------------------------------------- */

test('a new staff account shows a password that stays on screen', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'OWNER_ADMIN');
  await visit(page, '/settings/users', problems);

  await page.getByRole('button', { name: /add a staff member/i }).first().click();

  // A unique email per run: the server returns 409 on a duplicate, and this
  // suite runs repeatedly against the same clinic.
  const unique = `verify.staff.${Date.now()}@example.test`;
  await page.getByLabel(/full name/i).fill('Password Reveal Check');
  await page.getByLabel(/^email/i).fill(unique);

  await page.getByRole('button', { name: /create account/i }).click();

  // The reveal, by its heading rather than its text — the wording is allowed to
  // change, the fact that one appears is not.
  const reveal = page.getByText(/write this down now/i);
  await expect(reveal).toBeVisible({ timeout: 10_000 });

  /*
   * The password itself. Read from the <code> element rather than asserted
   * against a pattern, because the point is that SOMETHING readable is there —
   * an empty or whitespace-only element would satisfy a visibility check.
   */
  const secret = page.locator('code').filter({ hasText: /\S/ }).first();
  await expect(secret).toBeVisible();
  const shown = (await secret.innerText()).trim();
  expect(shown.length, `the password element was empty: ${JSON.stringify(shown)}`)
    .toBeGreaterThan(7);

  /*
   * THE ACTUAL REGRESSION. Wait out the session refetch and the app remount it
   * used to trigger. If the layout blanks, the dialog is gone by now.
   */
  await page.waitForTimeout(2500);

  await expect(
    reveal,
    'the password dialog was unmounted before it could be read — the session ' +
      'refetch is blanking the app again',
  ).toBeVisible();
  expect(
    (await secret.innerText()).trim(),
    'the dialog survived but the password changed or emptied',
  ).toBe(shown);

  // Still no console errors, and the app is still rendered rather than spinning.
  expect(problems, 'the staff screen reported problems').toEqual([]);

  await page.getByRole('button', { name: /^done$/i }).click();

  // And the account is actually in the list afterwards.
  await expect(page.getByText('Password Reveal Check')).toBeVisible();
});

test('issuing a new password shows it and keeps it visible', async ({ page }) => {
  const problems = watchConsole(page);
  await signIn(page, 'OWNER_ADMIN');
  await visit(page, '/settings/users', problems);

  // Reset somebody else's — the suite's own doctor fixture. Resetting the
  // signed-in administrator's would invalidate the session this test is using.
  // By EMAIL, not by role name. The role badge text is presentational and the
  // admin's own row could match a loose pattern — resetting the signed-in
  // administrator's password would invalidate the session this test runs on.
  const row = page
    .locator('li')
    .filter({ hasText: `doctor@${DOMAIN}` })
    .first();
  await row.getByRole('button', { name: /reset password/i }).click();

  await page.getByRole('button', { name: /issue a new password/i }).click();

  const reveal = page.getByText(/write this down now/i);
  await expect(reveal).toBeVisible({ timeout: 10_000 });

  const secret = page.locator('code').filter({ hasText: /\S/ }).first();
  const shown = (await secret.innerText()).trim();
  expect(shown.length, 'the issued password was not displayed').toBeGreaterThan(7);

  // The same wait, for the same reason as the invite test above.
  await page.waitForTimeout(2500);
  await expect(
    reveal,
    'the issued password vanished before it could be read',
  ).toBeVisible();
  expect((await secret.innerText()).trim()).toBe(shown);

  expect(problems, 'the reset dialog reported problems').toEqual([]);
});

/* -------------------------------------------------------------------------- *
 * The password reveal, on every panel that has one
 *
 * Asserted on the `type` attribute rather than on the icon, because the icon
 * swapping while the input stays masked is exactly the failure that would look
 * right in a screenshot and help nobody.
 *
 * The toggle also has to NOT submit the form. A button inside a form defaults
 * to `type="submit"`, so getting that wrong would attempt a sign-in with a
 * half-typed password and burn a failed-login attempt against the lockout
 * counter on every click — so the test types a deliberately wrong password,
 * toggles, and checks it is still sitting on the sign-in screen.
 * -------------------------------------------------------------------------- */

for (const panel of [
  { name: 'the clinic sign-in', path: '/login' },
  { name: 'the operations console sign-in', path: '/platform/login' },
]) {
  test(`${panel.name} can reveal the password without submitting`, async ({ browser }) => {
    const anonymous = await browser.newContext();
    try {
      const page = await anonymous.newPage();
      const problems = watchConsole(page);
      await visit(page, panel.path, problems);

      const field = page.locator('input[type="password"], input[name="password"]').first();
      await field.fill('deliberately-wrong-password');

      // Masked to begin with. A reveal that defaults to visible is not a reveal.
      await expect(field).toHaveAttribute('type', 'password');

      const toggle = page.getByRole('button', { name: /show password/i });
      await expect(toggle).toBeVisible();
      await toggle.click();

      const revealed = page.locator('input[name="password"], input#op-password').first();
      await expect(revealed).toHaveAttribute('type', 'text');
      await expect(revealed).toHaveValue('deliberately-wrong-password');

      // It did not submit: still on the sign-in screen, nothing errored.
      expect(page.url()).toContain(panel.path);
      expect(problems, `${panel.path} reported problems`).toEqual([]);

      // And it goes back.
      await page.getByRole('button', { name: /hide password/i }).click();
      await expect(revealed).toHaveAttribute('type', 'password');
    } finally {
      await anonymous.close();
    }
  });
}
