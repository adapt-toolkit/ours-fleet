import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:49371',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
      },
    },
    { name: 'firefox', use: { browserName: 'firefox' } },
    {
      name: 'webkit',
      use: {
        browserName: 'webkit',
        launchOptions: {
          env: {
            LD_LIBRARY_PATH: '/tmp/ours-fleet-playwright-deps/usr/lib/x86_64-linux-gnu',
          },
        },
      },
    },
  ],
  webServer: {
    command: 'node test/web/fixtures/e2e-server.mjs',
    url: 'http://127.0.0.1:49371/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
