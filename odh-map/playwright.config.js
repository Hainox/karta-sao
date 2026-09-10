import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: { browserName: 'chromium', channel: 'msedge', headless: true },
  webServer: {
    command: 'node tests/static-server.mjs',
    url: 'http://127.0.0.1:8766/odh-map/',
    reuseExistingServer: true,
    timeout: 30_000
  }
});
