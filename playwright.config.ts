import { defineConfig, devices } from '@playwright/test'

const PORT = 5199

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    // BASE_URL runs the suite against another server, e.g. the production preview for performance numbers
    baseURL: process.env.BASE_URL ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // locally use the installed Chrome; CI installs Playwright's Chromium
    ...(process.env.CI ? {} : { channel: 'chrome' }),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /(mobile|large)\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
    // timing assertions need an idle machine: the 1M-row test runs after everything else
    { name: 'perf', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testMatch: /large\.spec\.ts/, dependencies: ['desktop', 'mobile'] },
  ],
  webServer: process.env.BASE_URL ? undefined : {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
