import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
const read = spawnSync('python', ['-c', 'import openpyxl,json,sys; print(json.dumps([{ "login":r[1],"password":r[2],"role":r[3],"district":r[0]} for r in list(openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=True).worksheets[0].values)[1:] if r[1]]))', process.argv[2]], { encoding:'utf8' });
assert.equal(read.status, 0);
const users = JSON.parse(read.stdout); read.stdout = '';
const base = 'https://obhod-sao.ru/photo-api';
async function login(user) {
  const response = await fetch(base + '/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({login:user.login,password:user.password}) });
  assert.equal(response.status, 200, 'login status');
  return (await response.json()).token;
}
const prefecture = users.find(u => u.role === 'Префектура');
if (process.argv.includes('--password-stdin')) {
  console.log('Waiting for password on stdin (not echoed).');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    prefecture.password = await new Promise(resolve => {
      let value = '';
      const onData = chunk => {
        const text = chunk.toString();
        if (text.includes('\r') || text.includes('\n')) {
          process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); resolve(value + text.split(/[\r\n]/)[0]);
        } else value += text;
      };
      process.stdin.on('data', onData);
    });
  } else {
    const input = createInterface({ input: process.stdin });
    prefecture.password = await new Promise(resolve => input.once('line', resolve));
    input.close();
  }
}
const token = await login(prefecture);
const district = process.argv.includes('--prefecture-only') ? null : await login(users.find(u => u.district === 'Головинский'));
users.forEach(u => u.password = '');
const call = (path, auth = token, options = {}) => fetch(base + '/object-photo-points/slots' + path, { ...options, headers:{Authorization:'Bearer '+auth, ...options.headers} });
const key = 'parking:930951626';
const response = await call('/objects/' + key);
assert.equal(response.status, 200);
const original = await response.json();
assert.equal(original.required, 19);
assert.equal(original.filled, 0);
const resize = (required, expectedRequired, auth = token) => call('/objects/'+key+'/count', auth, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({required,expectedRequired}) });
let changed = false;
try {
  assert.equal((await resize(20,19)).status, 200); changed = true;
  assert.equal((await (await call('/objects/'+key)).json()).required, 20);
  assert.equal((await resize(21,19)).status, 409);
  if (district) assert.equal((await resize(21,20,district)).status, 403);
  const summary = await (await call('/public')).json();
  assert.equal(summary.objects.find(o=>o.object_key===key).required, 20);
} finally { if (changed) assert.equal((await resize(19,20)).status, 200, 'original count restored'); }
assert.equal((await (await call('/objects/'+key,district || token)).json()).required, 19);
console.log('PASS production: prefecture 19→20→19, public counts synchronized, stale edit 409. Original count restored.');

if (process.argv.includes('--browser')) {
  const { chromium } = await import('../../../odh-map/node_modules/@playwright/test/index.mjs');
  const user = (await (await fetch(base + '/auth/me', { headers: { Authorization: 'Bearer ' + token } })).json()).user;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(({ token, user }) => {
      sessionStorage.setItem('tpu-photo-token', token);
      sessionStorage.setItem('tpu-photo-user', JSON.stringify(user));
    }, { token, user });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    await page.goto('https://hainox.github.io/karta-sao/object-maps/tpu-parking.html?object=' + encodeURIComponent(key), { waitUntil: 'domcontentloaded' });
    await page.locator('#slotPanel .slot-card').nth(18).waitFor();
    assert.equal(await page.locator('#slotPanel .slot-card').count(), 19);
    await page.getByRole('button', { name: 'Добавить слот', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#slotPanel .slot-card').length === 20);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#slotPanel .slot-card').nth(19).waitFor();
    await page.getByRole('button', { name: 'Убрать слот', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#slotPanel .slot-card').length === 19);
    console.log('PASS published browser: add slot, reload persists 20 slots, remove restores 19.');
  } finally {
    const state = await (await call('/objects/' + key)).json();
    if (state.required === 20) assert.equal((await resize(19,20)).status, 200);
    await browser.close();
  }
}
