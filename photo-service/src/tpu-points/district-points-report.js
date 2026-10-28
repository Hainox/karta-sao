// Сводка по точкам съёмки районных карт («эталонные фото») для префектуры.
// Отдельный построитель: точки привязаны к районам напрямую, без каталога объектов.
import { DISTRICTS } from './validation.js';

const dateText = (value) => (value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '');

export const REPORT_KINDS_DISTRICT = {
  district: { title: 'точек съёмки районов', file: 'Svodka_Tochki_Semki_SAO' },
};

/** Чистый расчёт: статусы точек по 16 районам и итого. */
export function summarizeDistrictPoints({ points = [], generatedAt = new Date() } = {}) {
  const rows = new Map([...DISTRICTS].map((district) => [district, { district, points: 0, arrows: 0, pending: 0, accepted: 0, rework: 0 }]));
  const ensure = (district) => {
    return rows.get(district);
  };
  for (const point of points) {
    const row = ensure(point.district);
    row.points += 1;
    if (point.heading != null) row.arrows += 1;
    if (point.review_status === 'pending') row.pending += 1;
    else if (point.review_status === 'rework') row.rework += 1;
    else row.accepted += 1;
  }
  const districtRows = [...rows.values()].sort((a, b) => a.district.localeCompare(b.district, 'ru'));
  const total = {
    district: 'Итого',
    points: districtRows.reduce((s, r) => s + r.points, 0),
    arrows: districtRows.reduce((s, r) => s + r.arrows, 0),
    pending: districtRows.reduce((s, r) => s + r.pending, 0),
    accepted: districtRows.reduce((s, r) => s + r.accepted, 0),
    rework: districtRows.reduce((s, r) => s + r.rework, 0),
  };
  const pointRows = [...points].sort((a, b) =>
    String(a.district).localeCompare(String(b.district), 'ru')
    || String(a.label).localeCompare(String(b.label), 'ru', { numeric: true })
    || String(a.created_at).localeCompare(String(b.created_at)));
  return { generatedAt, districtRows, total, pointRows };
}

const HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123A32' } };
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
  headerRow(overview, ['Район', 'Точек на проверке', 'Принято точек', 'На доработке', 'Всего точек'], [22, 16, 16, 16, 14]);
  overview.spliceRows(1, 0, [`Сводка точек съёмки районов САО на ${dateText(summary.generatedAt)}`], []);
  overview.getRow(1).font = { bold: true, size: 14 };
  overview.views = [{ state: 'frozen', ySplit: 3 }];
  for (const r of [...summary.districtRows, summary.total]) {
    const row = overview.addRow([r.district, r.pending, r.accepted, r.rework, r.points]);
    if (r.district === 'Итого') row.font = { bold: true };
  }
  const pointsSheet = book.addWorksheet('Точки');
  headerRow(pointsSheet, ['Район', 'Точка', 'Статус приёмки', 'Комментарий префектуры', 'Широта', 'Долгота', 'Направление, °', 'На карте'], [22, 12, 20, 48, 11, 11, 13, 12]);
  for (const p of summary.pointRows) {
    const slug = { 'Аэропорт': 'aeroport', 'Беговой': 'begovoy', 'Бескудниковский': 'beskudnikovskiy', 'Войковский': 'voykovskiy', 'Восточное Дегунино': 'vostochnoe-degunino', 'Головинский': 'golovinskiy', 'Дмитровский': 'dmitrovskiy', 'Западное Дегунино': 'zapadnoe-degunino', 'Коптево': 'koptevo', 'Левобережный': 'levoberezhnyy', 'Молжаниновский': 'molzhaninovskiy', 'Савеловский': 'savelovskiy', 'Сокол': 'sokol', 'Тимирязевский': 'timiryazevskiy', 'Ховрино': 'hovrino', 'Хорошевский': 'horoshevskiy' }[p.district];
    const status = { pending: 'На проверке', accepted: 'Принята', rework: 'На доработке' }[p.review_status] || 'Принята';
    const row = pointsSheet.addRow([p.district, p.label, status, p.review_comment || '', Number(p.latitude), Number(p.longitude), p.heading == null ? '' : Math.round(Number(p.heading)), { text: 'Открыть', hyperlink: `${mapUrl}${slug}.html` }]);
    row.getCell(8).font = { color: { argb: 'FF0C5AA6' }, underline: true };
  }
  pointsSheet.autoFilter = { from: 'A1', to: 'H1' };

  return Buffer.from(await book.xlsx.writeBuffer());
}
