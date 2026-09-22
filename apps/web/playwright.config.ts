import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests.
 *
 * These exist because a server-side check cannot see this application break.
 * Every screen is gated on a session that resolves client-side, so the HTML
 * the server returns is a loading spinner — a page whose component throws on
 * render still answers 200 with plausible-looking markup. Checking status
 * codes proved exactly nothing, and a real render error shipped past it.
 *
 * So: a real browser, and any console error fails the run.
 *
 * They run against the REAL API and the REAL seeded database — `docker compose
 * up` first. There used to be a mock BFF behind these tests, and it made them
 * worth less than they looked: they proved the screens rendered against data
 * shaped the way the frontend expected, which is not the same as data the
 * server actually returns.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // Generous, because the dev server compiles each route on first visit and
  // the admin walk covers twenty-seven of them.
  timeout: 240_000,
  use: {
    baseURL: 'http://localhost:3210',
    ...devices['Desktop Chrome'],
    // A clinic desktop is 1366×768 — the stated primary design target, not a
    // developer's laptop. Set after the device preset so it wins.
    viewport: { width: 1366, height: 768 },
  },
  webServer: {
    // `next dev` rather than the production build, for the error overlay and
    // readable stack traces. It talks to the containerised API, so the data is
    // the same data the shipped image serves.
    command: 'npx next dev -p 3210',
    url: 'http://localhost:3210/login',
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      API_BASE_URL: process.env.API_BASE_URL ?? 'http://localhost:4000',
    },
  },
});
