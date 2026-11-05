import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createCanvas } from '@napi-rs/canvas';
import { selectAcceptedPhotos, buildAcceptedPhotoWorkbook } from '../src/tpu-points/accepted-photo-export.js';

const source = { point_id: 'point-1', object_id: '907426296', district: 'Дмитровский', kind: 'dp', label: 'Софьи Ковалевской ул. 2 к.2', latitude: 55.88, longitude: 37.54, uploaded_at: '2026-11-05T09:30:00Z', photo_status: 'accepted', photo_id: 'photo-1' };

test('export excludes pending photos, other kinds and other districts', () => {
  const result = selectAcceptedPhotos([source, { ...source, photo_status: 'pending' },
    { ...source, district: 'Коптево' }, { ...source, kind: 'sp' }],
    { district: 'Дмитровский', kind: 'dp', from: '2026-11-05', to: '2026-11-05' });
  assert.deepEqual(result, [source]);
});

test('Excel embeds the accepted photo and its source ID in a filterable row', async () => {
  const photo = createCanvas(16, 16).toBuffer('image/png');
  const buffer = await buildAcceptedPhotoWorkbook([source], async () => photo, 'Площадки');
  const parsed = new ExcelJS.Workbook();
  await parsed.xlsx.load(buffer);
  const sheet = parsed.getWorksheet('Принятые фото');
  assert.equal(sheet.getCell('C2').value, '907426296');
  assert.equal(sheet.getCell('D2').value, source.label);
  assert.equal(sheet.getImages().length, 1);
  assert.ok(sheet.autoFilter);
});
