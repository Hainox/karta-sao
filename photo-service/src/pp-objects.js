/**
 * Объекты ОДХ в источнике заданы координатными записями: у одной улицы много
 * точек с общим `odh_id`. Раньше объект дробился на пары «odh_id + район», и
 * если пограничная точка попадала в соседний район, появлялся второй объект:
 * у Коптево выходило 129 ПП вместо 128.
 *
 * Теперь один `odh_id` — ровно один объект, а район выбирается по большинству
 * его записей: так объект не «переезжает» из-за одной случайной точки.
 */
export function groupPpRecords(records, resolveDistrict) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array of source rows');
  if (typeof resolveDistrict !== 'function') throw new TypeError('resolveDistrict must be a function');

  const groups = new Map();
  for (const record of records) {
    const odhId = String(record.properties?.odh_id ?? record.id);
    let group = groups.get(odhId);
    if (!group) {
      group = { odhId, records: [] };
      groups.set(odhId, group);
    }
    group.records.push(record);
  }

  return [...groups.values()].map((group) => ({
    odhId: group.odhId,
    district: majorityDistrict(group.records, resolveDistrict),
    records: group.records,
  }));
}

/** Район по большинству записей; при равенстве голосов район важнее «без района». */
export function majorityDistrict(records, resolveDistrict) {
  const votes = new Map();
  for (const record of records) {
    const district = resolveDistrict(record) ?? null;
    votes.set(district, (votes.get(district) || 0) + 1);
  }
  const ranked = [...votes.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    if (left[0] === null) return 1;
    if (right[0] === null) return -1;
    return String(left[0]).localeCompare(String(right[0]), 'ru');
  });
  return ranked[0]?.[0] ?? null;
}

/** Ключ описания объекта для пары «номер ОДХ + район» — как в импорте. */
export function ppReportKey(odhId, district) {
  return `${odhId}|${district || 'unassigned'}`;
}
