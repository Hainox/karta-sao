import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Страницы подгружают Leaflet и шрифты с внешних CDN: сами проверки занимают
  // около секунды, а запас нужен на случай медленного ответа чужого сервера.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Локально используем установленный Edge, в CI — Chromium, который ставит Playwright.
  use: { browserName: 'chromium', channel: process.env.CI ? undefined : 'msedge', headless: true },
  retries: process.env.CI ? 1 : 0,
  webServer: {
    command: 'node tests/static-server.mjs',
    url: 'http://127.0.0.1:8766/odh-map/',
    reuseExistingServer: true,
    timeout: 30_000
  }
});
