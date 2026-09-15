import assert from 'node:assert/strict';
import test from 'node:test';
import { createActions } from '../src/actions.js';

const config = {
  odh: { apiUrl: 'https://obhod-sao.ru/odh-api', login: 'префектура', password: 'secret' },
  photoService: { apiUrl: '', login: '', password: '' }
};

function fakeFetch({ loginOk = true, patchStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth/login')) {
      return {
        ok: loginOk,
        status: loginOk ? 200 : 401,
        async json() {
          return loginOk ? { token: 'token-1', user: { email: 'префектура' } } : { error: 'Неверный пароль.' };
        }
      };
    }
    return {
      ok: patchStatus === 200,
      status: patchStatus,
      async json() {
        return patchStatus === 200 ? { submission: { status: 'approved', district: 'Аэропорт' } } : { error: 'Отказано.' };
      }
    };
  };
  return { calls, fetchImpl };
}

test('утверждает набор правок от имени префектуры', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const actions = createActions({ config, fetchImpl });
  const result = await actions.run('submission.approve', { submissionId: 'uuid-1', district: 'Аэропорт' });
  assert.match(result, /Аэропорт/);
  const patch = calls.find((call) => call.options.method === 'PATCH');
  assert.equal(patch.url, 'https://obhod-sao.ru/odh-api/api/submissions/uuid-1');
  assert.equal(patch.options.headers.Authorization, 'Bearer token-1');
  assert.equal(JSON.parse(patch.options.body).status, 'approved');
});

test('переиспользует токен вместо повторного входа', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const actions = createActions({ config, fetchImpl });
  await actions.run('submission.approve', { submissionId: 'uuid-1' });
  await actions.run('submission.reject', { submissionId: 'uuid-2' });
  assert.equal(calls.filter((call) => call.url.endsWith('/api/auth/login')).length, 1);
});

test('отказывает в неизвестном действии', async () => {
  const { fetchImpl } = fakeFetch();
  const actions = createActions({ config, fetchImpl });
  assert.equal(actions.has('submission.delete'), false);
  await assert.rejects(() => actions.run('submission.delete', {}), /не разрешено/);
});

test('объясняет, что доступы к API не настроены', async () => {
  const { fetchImpl } = fakeFetch();
  const actions = createActions({ config: { odh: { apiUrl: '', login: '', password: '' }, photoService: {} }, fetchImpl });
  await assert.rejects(() => actions.run('submission.approve', { submissionId: 'uuid-1' }), /Доступы к API не настроены/);
});

test('пробрасывает ошибку входа', async () => {
  const { fetchImpl } = fakeFetch({ loginOk: false });
  const actions = createActions({ config, fetchImpl });
  await assert.rejects(() => actions.run('submission.approve', { submissionId: 'uuid-1' }), /Не удалось войти/);
});
