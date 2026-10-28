import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDistrictPoints, buildDistrictPointsReport } from '../src/tpu-points/district-review-excel.js';

test('свод считает один фотослот и статусы по районам', async () => {
  const points = ['accepted','pending','rework','empty'].map((photo_state, i) => ({
    district: 'Аэропорт', label: String(i), photo_state, latitude: 55.8, longitude: 37.5
  }));
  const report = summarizeDistrictPoints({ points });
  assert.equal(report.districtRows.length, 16);
  assert.deepEqual([report.total.points, report.total.accepted, report.total.pending, report.total.rework, report.total.empty], [4, 1, 1, 1, 1]);
  const bytes = await buildDistrictPointsReport(report);
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet('Свод по районам');
  const total = sheet.getRow(21);
  assert.equal(total.getCell(1).value, 'Итого по САО');
  assert.equal(total.getCell(2).value, 4);
  assert.equal(total.getCell(7).value, 0.25);
  assert.equal(workbook.getWorksheet('Точки').rowCount, 5);
});
