import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:49371',
    browserName: 'chromium',
    launchOptions: { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node test/web/fixtures/e2e-server.mjs',
    url: 'http://127.0.0.1:49371/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
