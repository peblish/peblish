import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against the production build. By default Playwright starts the built web
// server (pnpm build first) on the lane's port; BASE_URL points it at a running server
// instead, such as the Docker image. Chromium only: @playwright/test is pinned to 1.58.2,
// whose Chromium 145 headless shell is what the mux-start spike used.
const port = Number(process.env.E2E_PORT ?? process.env.PORT ?? 18300);
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
/**
 * The lane's database, for the server Playwright starts (scripts/lane.sh prints it, CI sets
 * it). No default, so a lane never uses another's. With BASE_URL nothing is started, no
 * database is needed, and the specs that start their own servers (e2e/server/lifecycle.spec.ts) skip.
 */
function laneDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is unset: run lane_env=$(sh scripts/lane.sh <lane>) && eval "$lane_env" first, or set BASE_URL');
  return url;
}

export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  testMatch: '**/*.spec.ts',
  outputDir: './artifacts/test-results',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: './artifacts/report', open: 'never' }]] : 'list',
  use: { baseURL, locale: 'en-US', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'node packages/web/.output/server/index.mjs',
        cwd: '..',
        url: `${baseURL}/healthz`,
        env: {
          PORT: String(port),
          HOST: '127.0.0.1',
          DATABASE_URL: laneDatabaseUrl(),
          // The component gallery at /kit (the UI specs and the payload budget's font route) answers 404 without it.
          PEBLISH_UI_KIT: '1',
          // A spec that must fail many sign-ins (e2e/auth/flows.spec.ts) names its own client address in
          // X-Forwarded-For, so it does not spend the budget every other spec signs in under.
          PEBLISH_TRUSTED_PROXY: 'traefik',
          // Uploads are scanned against the local hash list only; no scanning provider is called
          // (deploy/README.md). Unset, an upload fails closed with media.scan_unavailable.
          MEDIASCAN_LOCAL_ONLY: '1',
        },
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
