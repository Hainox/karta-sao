import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';

const districtPages = join(import.meta.dirname, '../../districts');

test('все карты районов сохраняют права редактирования и только один точечный слой', async () => {
  const pages = (await readdir(districtPages)).filter((name) => name.endsWith('.html') && !['index.html', 'review.html', 'acceptance.html'].includes(name));
  assert.equal(pages.length, 16);

  for (const page of pages) {
    const html = await readFile(join(districtPages, page), 'utf8');
    assert.match(html, /function canEditPoint\(point\) \{\s+return isPrefecture\(\) && state.serverOk/, page + ': только префектура правит точки');
    assert.match(html, /\$\('shootToggle'\)\.hidden = !isPrefecture\(\)/, page + ': районы без разметки');
    assert.match(html, /if \(!isPrefecture\(\) \|\| !state.serverOk[^\n]*return;\n\s+const \[lng, lat\] = coordinates;\n\s+if \(!state.shootMode\) return;/, page + ': право на постановку');
    assert.match(html, /Локальная точка не создаётся/, page + ': нет локальной псевдозаписи');
    assert.match(html, /Не создавайте её повторно/, page + ': после POST проверка чтения');
    assert.doesNotMatch(html, /district_photographer/, page + ': нет новой роли');
    assert.equal((html.match(/id="shootLayerToggle"/g) || []).length, 1, `${page}: один рабочий слой`);
    assert.doesNotMatch(html, /id="(?:prefectureArchive|gpkgLayer)(?:Row|Toggle)"/, `${page}: дополнительные слои удалены`);
    assert.doesNotMatch(html, /prefecture-archive\?district=/, `${page}: архив не загружается`);
    assert.match(html, /button.textContent = 'Загрузить фото'/, `${page}: явная кнопка фотослота`);
    assert.doesNotMatch(html, /Статус приёмки точки/, `${page}: проверяются фотографии, не точки`);

    const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((script) => script.trim());
    for (const source of inlineScripts) assert.doesNotThrow(() => new Script(source), `${page}: синтаксис встроенного JavaScript`);
  }
});
