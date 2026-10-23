import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';

const districtPages = join(import.meta.dirname, '../../districts');

test('все карты районов скрывают архивный слой от районных учёток и сохраняют отдельный переключатель', async () => {
  const pages = (await readdir(districtPages)).filter((name) => name.endsWith('.html') && !['index.html', 'review.html', 'acceptance.html'].includes(name));
  assert.equal(pages.length, 16);

  for (const page of pages) {
    const html = await readFile(join(districtPages, page), 'utf8');
    assert.equal((html.match(/id="prefectureArchiveRow"/g) || []).length, 1, `${page}: отдельная строка архивного слоя`);
    assert.equal((html.match(/id="prefectureArchiveToggle"/g) || []).length, 1, `${page}: один переключатель архивного слоя`);
    assert.match(html, /prefectureArchiveRow'\)\.hidden = !isPrefecture\(\)/, `${page}: слой показывается только префектуре`);
    assert.match(html, /prefecture-archive\?district=/, `${page}: архив загружается отдельным запросом`);
    assert.match(html, /point\.prefectureArchive \? ' archive' : ''/, `${page}: архивные точки имеют отдельное оформление`);

    const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((script) => script.trim());
    for (const source of inlineScripts) assert.doesNotThrow(() => new Script(source), `${page}: синтаксис встроенного JavaScript`);
  }
});
