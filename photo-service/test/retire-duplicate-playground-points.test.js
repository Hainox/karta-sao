import assert from 'node:assert/strict';
import test from 'node:test';
import { duplicatePlan } from '../scripts/retire-duplicate-playground-points.js';

test('на площадке остаётся точка с фото, без фото — ближайшая к центру; точки с фото не снимаются', () => {
  const groups = [
    { keys: ['a:1', 'a:2', 'a:3', 'a:4'], contour_id: 1 },
    { keys: ['b:1', 'b:2'], contour_id: 2 },
    { keys: ['c:1', 'c:2'], contour_id: 3 },
    { keys: ['d:1', 'd:2'], contour_id: 4 },
  ];
  const rows = [
    { source_key: 'a:1', state: 'empty' }, { source_key: 'a:2', state: 'accepted' },
    { source_key: 'a:3', state: 'rework' }, { source_key: 'a:4', state: 'empty' },
    { source_key: 'b:1', state: 'empty' }, { source_key: 'b:2', state: 'empty' },
    { source_key: 'c:1', state: 'accepted' }, { source_key: 'c:2', state: 'pending' },
    { source_key: 'd:1', state: 'empty', retired_at: new Date() }, { source_key: 'd:2', state: 'empty' },
  ];
  const plan = duplicatePlan(groups, rows);
  assert.deepEqual(plan.retire.map((row) => [row.source_key, row.keep]).sort(), [['a:1', 'a:2'], ['a:3', 'a:2'], ['a:4', 'a:2'], ['b:2', 'b:1']]);
  assert.deepEqual(plan.keptWithPhoto.map((row) => row.source_key), ['c:2'], 'вторая точка с фото на проверке остаётся');
  assert.equal(plan.groups, 3, 'группа, где уже осталась одна точка, не трогается');
});
