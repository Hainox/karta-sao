import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExcel, buildPdf } from '../src/exports.js';
import { objectTypeLabel, percentLabel, statusBandLabel } from '../src/labels.js';

function reportRow(objectType, district, confirmed, pending = 0) {
  return {
    object_key: `${objectType}|${district}|1`,
    dataset_id: 'sao_stops',
    object_type: objectType,
    report_key: '1',
    source_ids: ['stop:1'],
    district,
    label: 'Объект',
    reference_points: [],
    properties: {},
    source_version: 'embedded-map-2026-09-15',
    confirmedPhotos: confirmed,
    pendingReviewPhotos: pending,
    geoRisk: false,
    photos: [],
  };
}

test('report labels are Russian words, not internal codes', () => {
  assert.equal(objectTypeLabel('stop'), 'Остановки');
  assert.equal(objectTypeLabel('pp'), 'ПП');
  assert.equal(objectTypeLabel('entrance'), 'Подъезды');
  assert.equal(objectTypeLabel('unknown'), 'unknown');

  assert.equal(statusBandLabel('low'), 'Красный');
  assert.equal(statusBandLabel('middle'), 'Жёлтый');
  assert.equal(statusBandLabel('high'), 'Зелёный');
  assert.equal(statusBandLabel(null), 'нет данных');

  assert.equal(percentLabel(33.3333333), '33,3 %');
  assert.equal(percentLabel(0), '0,0 %');
  assert.equal(percentLabel(null), 'нет данных');
});

test('the PDF embeds a Cyrillic font with a ToUnicode map', async () => {
  const pdf = await buildPdf([reportRow('stop', 'Аэропорт', 1), reportRow('pp', 'Аэропорт', 0)]);
  const raw = pdf.toString('latin1');

  // A standard PDF font is written with WinAnsi and no ToUnicode table: the report
  // then renders and copies as garbage. Both markers must be present instead.
  assert.match(raw, /\/FontFile2/);
  assert.match(raw, /\/ToUnicode/);
  assert.equal(raw.includes('/Helvetica'), false);
});

test('the PDF is produced for a district scope without photos', async () => {
  const pdf = await buildPdf([reportRow('entrance', 'Сокол', 0), reportRow('entrance', 'Сокол', 0, 1)]);
  assert.ok(pdf.subarray(0, 5).toString('latin1') === '%PDF-');
  assert.match(pdf.toString('latin1'), /\/Type\s*\/Page/);
});
