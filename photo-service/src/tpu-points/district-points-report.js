// Сводка по точкам съёмки районных карт («эталонные фото») для префектуры.
// Отдельный построитель: точки привязаны к районам напрямую, без каталога объектов.
const MOSCOW = 3 * 60 * 60 * 1000;

const moscowDate = (value) => new Date(new Date(value).getTime() + MOSCOW).toISOString().slice(0, 10);
const dateText = (value) => (value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '');

export const REPORT_KINDS_DISTRICT = {
  district: { title: 'точек съёмки районов', file: 'Svodka_Tochki_Semki_SAO' },
};

/** Чистый расчёт: строки по 16 районам + итого, динамика за 14 дней. */
export function summarizeDistrictPoints({ points = [], daily = [], generatedAt = new Date(), days = 14 } = {}) {
  const rows = new Map();
  const ensure = (district) => {
    if (!rows.has(district)) rows.set(district, { district, points: 0, arrows: 0, shot: 0, lastPhotoAt: null });
    return rows.get(district);
  };
  for (const point of points) {
    const row = ensure(point.district);
    row.points += 1;
    if (point.heading != null) row.arrows += 1;
    if (Number(point.photo_count) > 0) row.shot += 1;
    if (point.last_photo_at) {
      const iso = new Date(point.last_photo_at).toISOString();
      if (!row.lastPhotoAt || iso > row.lastPhotoAt) row.lastPhotoAt = iso;
    }
  }
  const districtRows = [...rows.values()].sort((a, b) => a.district.localeCompare(b.district, 'ru'));
  const total = {
    district: 'Итого',
    points: districtRows.reduce((s, r) => s + r.points, 0),
    arrows: districtRows.reduce((s, r) => s + r.arrows, 0),
    shot: districtRows.reduce((s, r) => s + r.shot, 0),
    lastPhotoAt: districtRows.map((r) => r.lastPhotoAt).filter(Boolean).sort().at(-1) || null,
  };
  const pointRows = [...points].sort((a, b) =>
    String(a.district).localeCompare(String(b.district), 'ru')
    || String(a.label).localeCompare(String(b.label), 'ru', { numeric: true })
    || String(a.created_at).localeCompare(String(b.created_at)));
  const end = Date.parse(moscowDate(generatedAt));
  const counts = new Map(daily.map((d) => [typeof d.day === 'string' ? d.day.slice(0, 10) : moscowDate(d.day), d]));
  const dynamics = Array.from({ length: days }, (_, i) => {
    const date = new Date(end - (days - 1 - i) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = counts.get(date);
    return { date, photos: Number(row?.photos || 0), points: Number(row?.points || 0) };
  });
  return { generatedAt, districtRows, total, pointRows, dynamics };
}

const HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123A32' } };
const percent = (part, whole) => (whole ? part / whole : 0);

function headerRow(sheet, titles, widths) {
  sheet.columns = titles.map((header, i) => ({ header, width: widths[i] }));
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER;
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 32;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

export async function buildDistrictPointsReport(summary, { mapUrl = 'https://hainox.github.io/karta-sao/districts/' } = {}) {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  book.created = summary.generatedAt;

  const overview = book.addWorksheet('Сводка');
  headerRow(overview, ['Район', 'Точек съёмки', 'Стрелок задано', 'Отснято точек', '% отснято', 'Последнее фото'], [22, 12, 12, 12, 10, 18]);
  overview.spliceRows(1, 0, [`Сводка точек съёмки районов САО на ${dateText(summary.generatedAt)}`], []);
  overview.getRow(1).font = { bold: true, size: 14 };
  overview.views = [{ state: 'frozen', ySplit: 3 }];
  for (const r of [...summary.districtRows, summary.total]) {
    const row = overview.addRow([r.district, r.points, r.arrows, r.shot, percent(r.shot, r.points), dateText(r.lastPhotoAt)]);
    row.getCell(5).numFmt = '0%';
    if (r.district === 'Итого') row.font = { bold: true };
  }
  overview.addConditionalFormatting({ ref: 'E4:E' + overview.rowCount, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FF0C7A5A' } }] });

  const pointsSheet = book.addWorksheet('Точки');
  headerRow(pointsSheet, ['Район', 'Точка', 'Широта', 'Долгота', 'Направление, °', 'Фото текущего ракурса', 'Последнее фото', 'Назначена', 'На карте'], [22, 12, 11, 11, 13, 14, 18, 18, 12]);
  for (const p of summary.pointRows) {
    const slug = { 'Аэропорт': 'aeroport', 'Беговой': 'begovoy', 'Бескудниковский': 'beskudnikovskiy', 'Войковский': 'voykovskiy', 'Восточное Дегунино': 'vostochnoe-degunino', 'Головинский': 'golovinskiy', 'Дмитровский': 'dmitrovskiy', 'Западное Дегунино': 'zapadnoe-degunino', 'Коптево': 'koptevo', 'Левобережный': 'levoberezhnyy', 'Молжаниновский': 'molzhaninovskiy', 'Савеловский': 'savelovskiy', 'Сокол': 'sokol', 'Тимирязевский': 'timiryazevskiy', 'Ховрино': 'hovrino', 'Хорошевский': 'horoshevskiy' }[p.district];
    const row = pointsSheet.addRow([p.district, p.label, Number(p.latitude), Number(p.longitude), p.heading == null ? '' : Math.round(Number(p.heading)), Number(p.photo_count) > 0 ? 'Да' : 'Нет', dateText(p.last_photo_at), dateText(p.created_at), { text: 'Открыть', hyperlink: `${mapUrl}${slug}.html` }]);
    row.getCell(9).font = { color: { argb: 'FF0C5AA6' }, underline: true };
  }
  pointsSheet.autoFilter = { from: 'A1', to: 'I1' };

  const dynamics = book.addWorksheet('Динамика');
  headerRow(dynamics, ['Дата', 'Загружено фото', 'Точек с новыми фото'], [14, 16, 20]);
  for (const d of summary.dynamics) dynamics.addRow([d.date.split('-').reverse().join('.'), d.photos, d.points]);

  return Buffer.from(await book.xlsx.writeBuffer());
}
