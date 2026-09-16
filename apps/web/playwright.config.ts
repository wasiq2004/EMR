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
    command: 'npx next dev -p 3210',
    url: 'http://localhost:3210/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
