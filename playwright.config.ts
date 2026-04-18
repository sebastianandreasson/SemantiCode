import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  outputDir: 'test-results/playwright',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  testDir: './tests/visual',
  testMatch: /.*\.visual\.ts/,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: {
      height: 1_000,
      width: 1_600,
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5174',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: 'http://127.0.0.1:5174/visual-test.html',
  },
})
