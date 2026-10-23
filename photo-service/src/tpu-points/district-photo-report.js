import { DISTRICTS } from './validation.js';

const dateText = (value) => (value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '');

export function summarizeDistrictPhotos({ points = [], generatedAt = new Date() } = {}) {
  const districts = new Map([...DISTRICTS].map((district) => [district, { district, acceptedPoints: 0, pointsWithPhotos: 0, photos: 0, lastPhotoAt: null }]));
  for (const point of points) {
    const row = districts.get(point.district);
    if ((point.review_status || 'accepted') === 'accepted') row.acceptedPoints += 1;
    const count = Number(point.photo_count || 0);
    row.photos += count;
    if (count) row.pointsWithPhotos += 1;
    if (point.last_photo_at) {
      const stamp = new Date(point.last_photo_at).toISOString();
      if (!row.lastPhotoAt || stamp > row.lastPhotoAt) row.lastPhotoAt = stamp;
    }
  }
  const districtRows = [...districts.values()].sort((a, b) => a.district.localeCompare(b.district, 'ru'));
  const total = {
    district: 'Итого',
    acceptedPoints: districtRows.reduce((sum, row) => sum + row.acceptedPoints, 0),
    pointsWithPhotos: districtRows.reduce((sum, row) => sum + row.pointsWithPhotos, 0),
    photos: districtRows.reduce((sum, row) => sum + row.photos, 0),
    lastPhotoAt: districtRows.map((row) => row.lastPhotoAt).filter(Boolean).sort().at(-1) || null,
  };
  const pointRows = [...points].sort((a, b) =>
    String(a.district).localeCompare(String(b.district), 'ru')
    || String(a.label).localeCompare(String(b.label), 'ru', { numeric: true }));
  return { generatedAt, districtRows, total, pointRows };
}

const HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123A32' } };

function headerRow(sheet, titles, widths) {
  sheet.columns = titles.map((header, index) => ({ header, width: widths[index] }));
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER;
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 32;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

export async function buildDistrictPhotosReport(summary, { mapUrl = 'https://hainox.github.io/karta-sao/districts/' } = {}) {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'Фотослужба САО';
  book.created = summary.generatedAt;

  const overview = book.addWorksheet('Сводка по районам');
  headerRow(overview, ['Район', 'Принятых точек', 'Точек с фото', 'Загружено фото', 'Последнее фото'], [24, 18, 16, 18, 20]);
  overview.spliceRows(1, 0, [`Сводка по фото на ${dateText(summary.generatedAt)}`], []);
  overview.getRow(1).font = { bold: true, size: 14 };
  overview.views = [{ state: 'frozen', ySplit: 3 }];
  for (const row of [...summary.districtRows, summary.total]) {
    const excelRow = overview.addRow([row.district, row.acceptedPoints, row.pointsWithPhotos, row.photos, dateText(row.lastPhotoAt)]);
    if (row.district === 'Итого') excelRow.font = { bold: true };
  }

  const detail = book.addWorksheet('Фото по точкам');
  headerRow(detail, ['Район', 'Точка', 'Статус точки', 'Количество фото', 'Последнее фото', 'Карта района'], [24, 14, 20, 16, 20, 18]);
  const slugs = {
    Аэропорт: 'aeroport', Беговой: 'begovoy', Бескудниковский: 'beskudnikovskiy', Войковский: 'voykovskiy',
    'Восточное Дегунино': 'vostochnoe-degunino', Головинский: 'golovinskiy', Дмитровский: 'dmitrovskiy',
    'Западное Дегунино': 'zapadnoe-degunino', Коптево: 'koptevo', Левобережный: 'levoberezhnyy',
    Молжаниновский: 'molzhaninovskiy', Савеловский: 'savelovskiy', Сокол: 'sokol',
    Тимирязевский: 'timiryazevskiy', Ховрино: 'hovrino', Хорошевский: 'horoshevskiy',
  };
  for (const point of summary.pointRows) {
    const status = { pending: 'На проверке', accepted: 'Принята', rework: 'На доработке' }[point.review_status] || 'Принята';
    const row = detail.addRow([point.district, point.label, status, Number(point.photo_count || 0), dateText(point.last_photo_at), { text: 'Открыть', hyperlink: `${mapUrl}${slugs[point.district] || ''}.html` }]);
    row.getCell(6).font = { color: { argb: 'FF0C5AA6' }, underline: true };
  }
  detail.autoFilter = { from: 'A1', to: 'F1' };
  return Buffer.from(await book.xlsx.writeBuffer());
}