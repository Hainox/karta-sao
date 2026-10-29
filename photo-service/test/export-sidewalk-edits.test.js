import assert from 'node:assert/strict';
import test from 'node:test';
import { editLine } from '../scripts/export-sidewalk-edits.js';

test('строка правки: номер, координаты, направление и отметки', () => {
  assert.equal(editLine({ point_no: 'Т1.12', longitude: 37.5, latitude: 55.8, heading: 90, moved: true, rotated: true, retired_at: null, role: 'угол', has_photo: true }),
    'Т1.12;37.500000;55.800000;90;MRP');
  assert.equal(editLine({ point_no: 'Т2.400', longitude: 37.51, latitude: 55.79, heading: 0, moved: false, rotated: false, retired_at: new Date(), role: 'добавлена префектурой', has_photo: false }),
    'Т2.400;37.510000;55.790000;0;DA');
});
