import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { databasePoolOptions } from '../lib/database-config.js';
import { notifyClientFromEnv } from '../lib/notify.js';
import { createRepository } from '../lib/repository.js';
import { routeReport, routeReportCsv, routeReportCsvName, routeReportSummary } from '../lib/route-report.js';
import { DISTRICTS } from '../lib/validation.js';

// Разовый отчёт по отрисовке маршрутов ОДХ. Без --out уходит в Telegram
// сообщением и CSV-файлом, с --out рядом сохраняется только выгрузка. Сводку
// печатаем всегда — тот же текст, что уходит в чат.
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex === -1 ? null : resolve(args[outIndex + 1] || 'odh-routes.csv');

const pool = new Pool({ ...databasePoolOptions(), max: 2 });
try {
  const report = routeReport(await createRepository(pool).routeReportRows(), { districtNames: [...DISTRICTS] });
  const csv = routeReportCsv(report);
  const filename = routeReportCsvName(report);
  const text = routeReportSummary(report);

  if (outPath) {
    writeFileSync(outPath, csv, 'utf8');
    console.log(`Выгрузка сохранена: ${outPath} (${report.totals.routes} маршрутов)`);
  } else {
    const notifier = notifyClientFromEnv();
    if (!notifier.enabled) throw new Error('Не задан NOTIFY_URL — отправлять некуда.');
    await notifier.event({
      kind: 'service',
      title: 'Отрисовка маршрутов ОДХ',
      text,
      fields: {
        Маршрутов: report.totals.routes,
        Зон: report.totals.zones,
        Точек: report.totals.points,
        'Без маршрутов': report.lagging.length ? report.lagging.join(', ') : '—'
      }
    });
    await notifier.document({ file: Buffer.from(csv, 'utf8').toString('base64'), filename, caption: text });
    console.log(`Отчёт отправлен: ${filename}, ${report.totals.routes} маршрутов`);
  }
  console.log(text);
} finally {
  await pool.end();
}
