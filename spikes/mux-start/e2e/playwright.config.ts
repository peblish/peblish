import { defineConfig, devices } from '@playwright/test';

// BASE_URL selects the server under test: the TanStack Start production container by
// default, or the React Router container (18120) or a dev server (18111).
// ARTIFACT_PREFIX keeps each target's evidence apart under artifacts/.
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 4,
  reporter: [['list'], ['json', { outputFile: `artifacts/${process.env.ARTIFACT_PREFIX ?? 'start'}/results.json` }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:18110',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  // Chromium only. @playwright/test is pinned to 1.58.2 because its Chromium 145 headless
  // shell (revision 1208) is already in the local browser cache.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
