import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from '../src/config.js';
import { loadReportRows, reportPayload } from '../src/reports.js';
import { headquartersBoard } from '../src/headquarters.js';
import { renderHeadquartersImage } from '../src/digest.js';
import { notifyClientFromEnv } from '../src/notify.js';

// Сводка для штаба: картинка второй таблицы листа «На штаб» и текст комментария.
// Без --out отправляет в Telegram, с --out просто сохраняет картинку рядом.
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex === -1 ? null : resolve(args[outIndex + 1] || 'sao-photo-digest.png');

const pool = new Pool({ ...photoServiceDatabaseConfig(process.env), max: 2 });
try {
  const rows = await loadReportRows(pool, { role: 'prefecture_admin' }, undefined);
  const board = headquartersBoard(reportPayload(rows));
  const { png, caption } = renderHeadquartersImage(board, { generatedAt: new Date() });

  if (outPath) {
    writeFileSync(outPath, png);
    console.log(`Сводка сохранена: ${outPath} (${(png.length / 1024).toFixed(1)} КБ)`);
  } else {
    const notify = notifyClientFromEnv();
    if (!notify.enabled) throw new Error('Не задан NOTIFY_URL — отправлять некуда.');
    const result = await notify.photo({ caption, png });
    if (!result) throw new Error('Служба оповещений не приняла сводку.');
    console.log(`Сводка отправлена: ${result.delivered} получателям, ${board.percent} % выполнения`);
  }
  console.log(caption);
} finally {
  await pool.end();
}
