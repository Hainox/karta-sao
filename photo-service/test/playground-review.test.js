// Кабинет приёмки районных карт, режим «ДП и СП»: очередь фото площадок и свод в Excel.
import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createPlaygroundPhotoRouter, playgroundQueueFromRows } from '../src/tpu-points/playground-photo.js';

const rows = [
  { point_id: 'p1', label: 'Ул. Тестовая, 1', district: 'Коптево', kind: 'dp', photo_id: 'f1', photo_status: 'pending', uploaded_at: '2026-10-28T06:00:00Z', photo_filename: 'a.jpg' },
  { point_id: 'p2', label: 'Ул. Тестовая, 2', district: 'Коптево', kind: 'sp', rejected_photo_id: 'f0', rejected_comment: 'Площадка не в кадре', rejected_at: '2026-10-27T10:00:00Z', rejected_uploaded_at: '2026-10-27T08:00:00Z' },
  { point_id: 'p3', label: 'Ул. Тестовая, 3', district: 'Сокол', kind: 'dp', photo_id: 'f3', photo_status: 'accepted', uploaded_at: '2026-10-26T06:00:00Z' },
  { point_id: 'p4', label: 'Ул. Тестовая, 4', district: 'Сокол', kind: 'sp' },
];

test('очередь площадок: счёт по состояниям, вид площадки, без ссылки на отклонённый снимок', () => {
  const queue = playgroundQueueFromRows(rows);
  assert.deepEqual(queue.counts, { total: 4, empty: 1, pending: 1, accepted: 1, rework: 1 });
  assert.equal(queue.pending[0].kind, 'dp');
  assert.equal(queue.rework[0].kind, 'sp');
  assert.equal(queue.rework[0].rejected_comment, 'Площадка не в кадре');
  // Отклонённый снимок площадки сервер не отдаёт — кабинет не должен его запрашивать.
  assert.equal(queue.rework[0].photo_id, null);
});

async function serve(role, run) {
  const pool = { async query() { return { rows } } };
  const app = express();
  app.use('/playgrounds', createPlaygroundPhotoRouter({ pool, authenticate: (req, _res, next) => { req.user = { sub: 'u', role, district: role === 'district_editor' ? 'Коптево' : null }; next(); } }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}/playgrounds`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('очередь и свод ДП/СП доступны только префектуре', async () => {
  await serve('prefecture_admin', async (base) => {
    const queue = await (await fetch(`${base}/queue`)).json();
    assert.equal(queue.counts.total, 4);
    const response = await fetch(`${base}/report.xlsx`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /Svod_foto_DP_SP_SAO_\d{4}-\d{2}-\d{2}\.xlsx/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const overview = book.getWorksheet('Свод по районам');
    assert.match(String(overview.getCell('A1').value), /^Свод по фото детских и спортивных площадок/);
    const kinds = [];
    overview.eachRow((row) => { if (['Детские площадки', 'Спортивные площадки'].includes(row.getCell(1).value)) kinds.push([row.getCell(1).value, row.getCell(2).value]); });
    assert.deepEqual(kinds, [['Детские площадки', 2], ['Спортивные площадки', 2]]);
    assert.deepEqual(book.getWorksheet('На доработке').getRow(2).values.slice(1, 5), ['Коптево', 'Спортивные площадки', 'Ул. Тестовая, 2', 'Площадка не в кадре']);
  });
  for (const role of ['district_editor', 'reviewer']) {
    await serve(role, async (base) => {
      assert.equal((await fetch(`${base}/queue`)).status, 403);
      assert.equal((await fetch(`${base}/report.xlsx`)).status, 403);
    });
  }
});
