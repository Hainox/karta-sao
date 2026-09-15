// Сохраняет свободный геометрический шрифт с кириллицей и обычным начертанием.
// Вариативные файлы Montserrat, Raleway и Manrope PDFKit берёт в тонком
// начертании, поэтому выбор ограничен теми, где базовый инстанс — Regular.
//
//   node scripts/fetch-font.js
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import * as fontkit from 'fontkit';

const target = process.argv[2] || 'assets/fonts/Jost-Regular.ttf';
const url = 'https://raw.githubusercontent.com/google/fonts/main/ofl/jost/Jost%5Bwght%5D.ttf';

// Символы, которые встречаются в подписях отчёта и на графиках.
const probes = ['А', 'я', 'ё', '№', '«', '»', '·', '%', ',', ':', '(', ')', '—', '–', '/', '0', '9', 'A', 'z'];

const response = await fetch(url);
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const buffer = Buffer.from(await response.arrayBuffer());
const font = fontkit.create(buffer);
const missing = probes.filter((character) => font.glyphForCodePoint(character.codePointAt(0)).id === 0);
console.log(`глифов: ${font.characterSet.length}, нет глифов для: ${missing.join(' ') || '—'}`);

await mkdir(dirname(target), { recursive: true });
await writeFile(target, buffer);
console.log(`сохранено: ${target} (${Math.round(buffer.length / 1024)} КБ)`);
console.log(`sha256: ${createHash('sha256').update(buffer).digest('hex')}`);
