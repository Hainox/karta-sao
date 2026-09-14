import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepository } from '../lib/repository.js';

function fakePool({ failOnAudit = false } = {}) {
  const calls = [];
  let connectionId = 0;
  const result = async (sql, values = [], clientId = null) => {
    calls.push({ sql, values, clientId });
    if (failOnAudit && sql.includes('INSERT INTO audit_events')) throw new Error('audit unavailable');
    if (sql.includes('FROM submissions')) return { rows: [{ id: 'submission-1', payload_sha256: 'recorded-hash' }] };
    return { rows: [{ id: 'row-1', status: 'submitted', has_photo: true }] };
  };
  return {
    calls,
    async query(sql, values) { return result(sql, values); },
    async connect() {
      const clientId = ++connectionId;
      return {
        query(sql, values) { return result(sql, values, clientId); },
        release() {}
      };
    }
  };
}

test('submission reads include the SHA-256 used by the review archive', async () => {
  const pool = fakePool();
  const submissions = await createRepository(pool).listSubmissions({ status: 'submitted' });
  assert.match(pool.calls[0].sql, /payload_sha256/);
  assert.equal(submissions[0].payload_sha256, 'recorded-hash');
});

test('all audited writes use one transaction per mutation', async () => {
  const pool = fakePool();
  const repository = createRepository(pool);
  const actorId = '00000000-0000-4000-8000-000000000001';
  const id = '00000000-0000-4000-8000-000000000002';

  await repository.createSubmission({ changeSet: { district: 'Аэропорт', author: 'Иванов' }, createdBy: actorId, originalFilename: 'set.geojson', payloadSha256: 'abc' });
  await repository.reviewSubmission({ id, status: 'approved', reviewerId: actorId, comment: '' });
  await repository.createPhotoMarker({ longitude: 37.5, latitude: 55.8, note: '', legacySourceId: null, createdBy: actorId });
  await repository.updatePhotoMarkerNote({ id, note: 'note', actorId });
  await repository.setPhotoMarkerPhoto({ id, bytes: Buffer.from('photo'), mimeType: 'image/jpeg', filename: 'photo.jpg', actorId });
  await repository.deletePhotoMarkerPhoto({ id, actorId });
  await repository.deletePhotoMarker({ id, actorId });

  const transactions = new Map();
  for (const call of pool.calls) {
    if (call.clientId === null) continue;
    const entries = transactions.get(call.clientId) || [];
    entries.push(call.sql.trim().split(/\s+/).slice(0, 3).join(' '));
    transactions.set(call.clientId, entries);
  }
  assert.equal(transactions.size, 7);
  for (const entries of transactions.values()) {
    assert.equal(entries[0], 'BEGIN');
    assert.ok(entries.some((entry) => entry === 'INSERT INTO audit_events'));
    assert.equal(entries.at(-1), 'COMMIT');
  }
});

test('an audit insert failure rolls the primary write back', async () => {
  const pool = fakePool({ failOnAudit: true });
  const repository = createRepository(pool);

  await assert.rejects(repository.createSubmission({
    changeSet: { district: 'Аэропорт', author: 'Иванов' },
    createdBy: '00000000-0000-4000-8000-000000000001',
    originalFilename: 'set.geojson',
    payloadSha256: 'abc'
  }), /audit unavailable/);

  const commands = pool.calls.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(' '));
  assert.deepEqual(commands, ['BEGIN', 'INSERT INTO submissions', 'INSERT INTO audit_events', 'ROLLBACK']);
  assert.equal(new Set(pool.calls.map(({ clientId }) => clientId)).size, 1);
});
