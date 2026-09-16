import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { databasePoolOptions } from './lib/database-config.js';
import { notifyClientFromEnv } from './lib/notify.js';
import { createRepository, migrate } from './lib/repository.js';
import { routeReport, routeReportCsv, routeReportCsvName, routeReportSummary } from './lib/route-report.js';
import { DISTRICTS } from './lib/validation.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const jwtSecret = process.env.JWT_SECRET;
const databaseOptions = databasePoolOptions();
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET не задан или слишком короткий.');

const pool = new Pool({ ...databaseOptions, max: 10, ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined });
await migrate(pool);
const boundary = JSON.parse(await fs.readFile(path.resolve(root, '../odh-map/layers/sao_boundary_wgs84.geojson'), 'utf8'));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:8766,https://hainox.github.io').split(',').map((value) => value.trim()).filter(Boolean);
const notifier = notifyClientFromEnv();
const repository = createRepository(pool);
const app = createApp({ repository, boundary, jwtSecret, allowedOrigins, notifier });
const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`ODH SAO exchange API listens on ${port}${notifier.enabled ? ', оповещения включены' : ''}`));

/**
 * Отчёт о состоянии отрисовки маршрутов ОДХ: префектуре уходит сообщение с
 * итогами и CSV-выгрузка того же среза. Сбой отчёта не должен трогать API,
 * поэтому всё обёрнуто в try/catch, а ошибка уходит отдельным оповещением —
 * как в sendHourlyDigest фотослужбы.
 */
async function sendRouteReport() {
  try {
    const report = routeReport(await repository.routeReportRows(), { districtNames: [...DISTRICTS] });
    const text = routeReportSummary(report);
    const filename = routeReportCsvName(report);
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
    await notifier.document({ file: Buffer.from(routeReportCsv(report), 'utf8').toString('base64'), filename, caption: text });
    console.log(`Отчёт по маршрутам ОДХ: ${report.totals.routes} маршрутов, выгрузка ${filename}`);
  } catch (error) {
    console.error('route report failed:', error.message);
    notifier.event({
      kind: 'error',
      level: 'warning',
      service: 'odh-api',
      title: 'Отчёт по отрисовке маршрутов не отправлен',
      text: error.message
    });
  }
}

// Запуск ровно в 00:00, 03:00, 06:00 … — каждые три часа, круглосуточно.
function scheduleRouteReport() {
  const intervalMs = 3 * 60 * 60 * 1000;
  setTimeout(async () => {
    await sendRouteReport();
    scheduleRouteReport();
  }, intervalMs - (Date.now() % intervalMs));
}

if (String(process.env.ODH_ROUTE_REPORT_ENABLED || '').toLowerCase() === 'true') {
  scheduleRouteReport();
  console.log('Отчёт по отрисовке маршрутов ОДХ включён (каждые 3 часа)');
}
