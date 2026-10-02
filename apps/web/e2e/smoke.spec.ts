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

const ADMIN_ROUTES = [
  '/patients/merge',
  '/billing',
  '/billing/invoices/new',
  '/reports',
  '/settings/clinic',
  '/settings/locations',
  '/settings/users',
  '/settings/services',
  '/settings/schedules',
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

  // A Wednesday a month out: far enough that no fixture appointment lands on
  // it, and inside the 120-day range the API allows.
  const target = new Date();
  target.setDate(target.getDate() + 30);
  while (target.getDay() !== 3) target.setDate(target.getDate() + 1);
  const date = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(
    target.getDate(),
  ).padStart(2, '0')}`;
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

  // A Thursday this time, so this test cannot collide with the one above.
  const target = new Date();
  target.setDate(target.getDate() + 30);
  while (target.getDay() !== 4) target.setDate(target.getDate() + 1);
  const date = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(
    target.getDate(),
  ).padStart(2, '0')}`;

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
