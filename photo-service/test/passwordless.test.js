import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateMapUser, hashPassword } from '../src/auth.js';
import { DPSP_EDITOR, dpspSessionAllowed } from '../src/tpu-points/dpsp-access.js';

test('active district editor enters without a password using its server-side district', async () => {
  assert.equal(await authenticateMapUser({ active: true, role: 'district_editor', district: 'Коптево' }), true);
  assert.equal(await authenticateMapUser({ active: true, role: 'district_editor', district: 'АвД САО' }, ''), true);
});

test('disabled, missing and unscoped users cannot enter without a password', async () => {
  for (const user of [null, { active: false, role: 'district_editor', district: 'Коптево' }, { active: true, role: 'district_editor', district: null }, { active: true, role: 'district_editor', district: 'unknown' }]) {
    assert.equal(await authenticateMapUser(user), false);
  }
});

test('prefecture and other roles still require their correct password', async () => {
  const password_hash = await hashPassword('prefecture-test-password');
  for (const role of ['prefecture_admin', 'mkd_editor', DPSP_EDITOR, 'unknown']) {
    const user = { active: true, role, district: 'Коптево', password_hash };
    assert.equal(await authenticateMapUser(user), false);
    assert.equal(await authenticateMapUser(user, 'wrong'), false);
    assert.equal(await authenticateMapUser(user, 'prefecture-test-password'), true);
  }
});

test('персональная учётка ДП/СП открывает только свой кабинет и проверку входа', () => {
  const user = { role: DPSP_EDITOR };
  for (const path of ['/auth/me', '/object-photo-points/dpsp/workflow/sites']) {
    assert.equal(dpspSessionAllowed(user, path), true);
  }
  for (const path of ['/photos', '/dashboard/digitization', '/object-photo-points/playgrounds/queue', '/object-photo-points/dpsp-extra/sites']) {
    assert.equal(dpspSessionAllowed(user, path), false);
    assert.equal(dpspSessionAllowed({ role: 'prefecture_admin' }, path), true);
  }
});
