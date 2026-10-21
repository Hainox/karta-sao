import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../object-maps/photo-slots.js');

test('префектура добавляет и убирает слот; число сохраняется после открытия, район не видит кнопок', async ({ page }) => {
  let required = 2;
  let occupied = false;
  await page.route('**/test-slots/**', async route => {
    const request = route.request();
    const url = request.url();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      if (occupied && body.required < required) return route.fulfill({ status: 409, json: { error: 'В удаляемых слотах есть фотографии.' } });
      expect(body.expectedRequired).toBe(required);
      required = body.required;
      return route.fulfill({ json: { required } });
    }
    const state = { required, filled: 0, accepted: 0, status: 'empty', slots: Array.from({ length: required }, (_, i) => ({ slot: i + 1, photo: null, rejected: null })) };
    return route.fulfill({ json: url.endsWith('/public') ? { objects: [{ object_key: 'parking:test', ...state }] } : state });
  });
  async function open(role) {
    await page.goto('http://127.0.0.1:8766/odh-map/');
    await page.setContent('<main><div id="slotPanel"></div><div id="notice"></div></main>');
    await page.evaluate(role => {
      window.TpuPhotoApi = {
        user: () => ({ role, district: 'Коптево' }),
        request: async (url, options) => {
          const response = await fetch('/test-slots/' + url.split('/slots/')[1], options);
          if (!response.ok) throw new Error((await response.json()).error);
          return response;
        },
      };
    }, role);
    await page.addScriptTag({ path: script });
    await page.evaluate(() => {
      window.slots = SaoPhotoSlots.mount({ notify: text => document.getElementById('notice').textContent = text });
      window.slots.open({ id: 'parking:test', group: 'Коптево', properties: { 'Фото по заданию': 2 } });
    });
  }
  await open('prefecture_admin');
  await expect(page.locator('.slot-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Добавить слот', exact: true }).click();
  await expect(page.locator('.slot-card')).toHaveCount(3);
  await open('prefecture_admin');
  await expect(page.locator('.slot-card')).toHaveCount(3);
  occupied = true;
  await page.getByRole('button', { name: 'Убрать слот', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('есть фотографии');
  await expect(page.locator('.slot-card')).toHaveCount(3);
  occupied = false;
  await page.getByRole('button', { name: 'Убрать слот', exact: true }).click();
  await expect(page.locator('.slot-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Убрать слот', exact: true }).click();
  await expect(page.locator('.slot-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Убрать слот', exact: true })).toBeDisabled();
  await open('district_editor');
  await expect(page.locator('.slot-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Добавить слот', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Убрать слот', exact: true })).toHaveCount(0);
});
