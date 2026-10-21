import assert from 'node:assert/strict';
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
const token = await login(users.find(u => u.role === 'Префектура'));
const district = await login(users.find(u => u.district === 'Головинский'));
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
  assert.equal((await resize(21,20,district)).status, 403);
  const summary = await (await call('/public')).json();
  assert.equal(summary.objects.find(o=>o.object_key===key).required, 20);
} finally { if (changed) assert.equal((await resize(19,20)).status, 200, 'original count restored'); }
assert.equal((await (await call('/objects/'+key,district)).json()).required, 19);
console.log('PASS production: prefecture 19→20→19, public/district counts synchronized, district edit 403, stale edit 409. Original count restored.');
