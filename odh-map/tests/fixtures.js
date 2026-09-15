// Общая фикстура: тайлы подложки не запрашиваются у внешних серверов.
//
// Иначе тесты зависят от доступности Яндекс.Карт и OpenStreetMap: медленный
// ответ чужого сервера валит ожидание загрузки страницы.
import { test as base, expect } from '@playwright/test';

const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const TILE_HOSTS = /https:\/\/([a-z0-9.-]*\.)?(core-renderer-tiles\.maps\.yandex\.net|basemaps\.cartocdn\.com|tile\.openstreetmap\.org)\//;

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(TILE_HOSTS, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
    await use(page);
  }
});

export { expect };
