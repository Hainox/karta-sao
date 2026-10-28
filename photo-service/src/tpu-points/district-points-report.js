// Сводка по точкам съёмки районных карт («эталонные фото») для префектуры.
// Отдельный построитель: точки привязаны к районам напрямую, без каталога объектов.
import { DISTRICTS } from './validation.js';

const dateText = (value) => (value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '');

export const REPORT_KINDS_DISTRICT = {
  district: { title: 'точек съёмки районов', file: 'Svodka_Tochki_Semki_SAO' },
};

/** Чистый расчёт: статусы точек по 16 районам и итого. */
export function summarizeDistrictPoints({ points = [], generatedAt = new Date() } = {}) {
  const rows = new Map([...DISTRICTS].map(district => [district, { district, points: 0, accepted: 0, empty: 0, pending: 0, rework: 0 }]));
  for (const p of points) {
    const row = rows.get(p.district);
    if (!row) throw new Error('Неизвестный район точки: ' + p.district);
    const state = p.photo_state || 'empty';
    if (!['accepted', 'empty', 'pending', 'rework'].includes(state)) throw new Error('Неизвестный статус фото: ' + state);
    row.points++;
    row[state]++;
  }
  const districtRows = [...rows.values()].sort((a,b) => a.district.localeCompare(b.district,'ru'));
  const total = { district: 'Итого по САО' };
  for (const key of ['points','accepted','empty','pending','rework']) total[key] = districtRows.reduce((sum,r)=>sum+r[key],0);
  return { generatedAt, districtRows, total, pointRows: [...points].sort((a,b)=>String(a.district).localeCompare(String(b.district),'ru') || String(a.label).localeCompare(String(b.label),'ru',{numeric:true})) };
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
  book.creator = 'Фотослужба САО'; book.created = summary.generatedAt;
  const overview = book.addWorksheet('Свод по районам');
  overview.columns = [25,16,17,17,19,19,14].map(width => ({width}));
  overview.mergeCells('A1:G1'); overview.getCell('A1').value = 'Свод по фото въездных групп САО на ' + dateText(summary.generatedAt);
  overview.mergeCells('A2:G2'); overview.getCell('A2').value = 'Одна точка — один фотослот. Принято — фото проверено префектурой.';
  for (const n of [1,2]) { const row=overview.getRow(n); row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF2CC'}}; row.height=n===1?24:22; }
  overview.getRow(1).font={bold:true,size:14};
  const head=overview.getRow(4); head.values=['Район','Всего точек','Принято фото','Без фото','На проверке','На доработке','% принято']; head.fill=HEADER; head.font={bold:true,color:{argb:'FFFFFFFF'}};head.height=32;head.alignment={vertical:'middle',wrapText:true};
  for (const r of [...summary.districtRows,summary.total]) { const row=overview.addRow([r.district,r.points,r.accepted,r.empty,r.pending,r.rework,r.points ? r.accepted/r.points : 0]); row.getCell(7).numFmt='0.0%';if(r===summary.total)row.font={bold:true}; }
  overview.views=[{state:'frozen',ySplit:4}];
  overview.eachRow((row,n)=>{if(n>=4)row.eachCell(c=>{c.border={top:{style:'thin',color:{argb:'FFBFC9C4'}},bottom:{style:'thin',color:{argb:'FFBFC9C4'}},left:{style:'thin',color:{argb:'FFBFC9C4'}},right:{style:'thin',color:{argb:'FFBFC9C4'}}};});});
  const sheet=book.addWorksheet('Точки');
  headerRow(sheet,['Район','Точка','Статус фото','Широта','Долгота','Направление, °'],[24,16,20,16,16,18]);
  const labels={pending:'На проверке',accepted:'Принято',rework:'На доработке',empty:'Без фото'};
  for (const p of summary.pointRows) sheet.addRow([p.district,p.label,labels[p.photo_state || 'empty'],Number(p.latitude),Number(p.longitude),p.heading == null ? '' : Math.round(Number(p.heading))]);
  sheet.autoFilter={from:'A1',to:'F1'};
  return Buffer.from(await book.xlsx.writeBuffer());
}
