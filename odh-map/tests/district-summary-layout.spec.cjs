const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');

for (const [width, height] of [[390, 740], [360, 570], [640, 360], [1280, 800]]) {
  test(`карточка и сводка района доступны одновременно, ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const base = 'http://127.0.0.1:8766/';
    // Используем код страницы и сводки, заменяя сетевые источники и проекцию Яндекса.
    const source = readFileSync(path.resolve(__dirname, '../../districts/aeroport.html'), 'utf8');
    const markup = source.slice(0, source.lastIndexOf('  createMap().catch'))
      .replace(/<script>\s*window\.ymaps3Ready[\s\S]*?<\/script>/, '')
      + 'window.summaryForTest = state.summary;})();</script></body></html>';
    await page.route('**/*', route => {
      if (route.request().url().endsWith('/districts/aeroport.html')) {
        return route.fulfill({ contentType: 'text/html', body: markup });
      }
      if (route.request().url().startsWith(base) && !route.request().url().includes('/object-photo-points')) return route.continue();
      return route.fulfill({ contentType: 'application/json', body: '{"points":[]}' });
    });
    await page.goto(base + 'districts/aeroport.html');
    await page.evaluate(() => {
      summaryForTest.setVisible(true);
      const mapElement = document.getElementById('map');
      const card = document.getElementById('card');
      const marker = document.createElement('button');
      marker.textContent = 'Выбрать точку';
      mapElement.style.position = 'relative';
      const locationStyle = 'position:absolute;right:50px;top:' + (innerWidth <= 360 ? '50%' : '55px');
      marker.style.cssText = locationStyle;
      mapElement.append(marker);
      window.ymaps3 = { YMapMarker: class {
        constructor(options, el) {
          this.el = el;
          el.style.cssText = locationStyle;
        }
      } };
      const map = { addChild(m) { mapElement.append(m.el); }, removeChild(m) { m.el.remove(); } };
      const popover = createPointPopover({ map, mapElement, card });
      marker.onclick = () => {
        card.innerHTML = '<p>Направление кадра</p>'.repeat(18) + '<button>Сохранить</button>';
        popover.open({ coordinates: [37.5, 55.8], kind: 'path', title: 'Дорожка', editing: true });
      };
    });
    const summary = page.locator('.hud-summary');
    const collapse = summary.locator('[data-collapse]');
    if (await collapse.getAttribute('aria-expanded') === 'false') await collapse.click();
    const marker = page.getByRole('button', { name: 'Выбрать точку' });
    const original = await marker.boundingBox();
    // Карточку также можно открыть из списка, даже когда сводка перекрывает маркер.
    await marker.dispatchEvent('click');
    const dialog = page.getByRole('dialog', { name: 'Дорожка' });
    const assertSeparate = async () => {
      await expect.poll(async () => {
        const a = await dialog.boundingBox(), b = await summary.boundingBox();
        return a && b && (a.x + a.width <= b.x || b.x + b.width <= a.x ||
          a.y + a.height <= b.y || b.y + b.height <= a.y);
      }, { timeout: 2500 }).toBe(true);
    };
    await assertSeparate();
    await collapse.click();
    await assertSeparate();
    await collapse.click();
    await assertSeparate();
    await expect(summary.getByText('Въездные группы', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await dialog.getByRole('button', { name: 'Закрыть карточку' }).click();
    await expect(dialog).toBeHidden();
    expect(await marker.boundingBox()).toEqual(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
