import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const districtPages = readdirSync(new URL('../../districts/', import.meta.url))
  .filter((name) => name.endsWith('.html') && !['index.html', 'review.html', 'acceptance.html'].includes(name));

test('районные карты не загружают дополнительные точечные слои и имеют корректный JavaScript', () => {
  assert.equal(districtPages.length, 16);
  for (const page of districtPages) {
    const html = readFileSync(new URL(`../../districts/${page}`, import.meta.url), 'utf8');
    assert.equal((html.match(/id="shootLayerToggle"/g) || []).length, 1, page);
    assert.doesNotMatch(html, /id="prefectureArchiveToggle"|id="gpkgLayerToggle"/);
    assert.doesNotMatch(html, /prefecture-archive\?district=|SaoDistrictDirections.mount/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    for (const source of scripts) new Script(source, { filename: page });
  }
});

test('импортные точки скрыты, а разметка доступна только префектуре на страницах и в шаблоне', () => {
  const sources = districtPages.map((page) => [
    page,
    readFileSync(new URL(`../../districts/${page}`, import.meta.url), 'utf8'),
  ]);
  sources.push(['district_page_template.html', readFileSync(new URL('../../work/district_page_template.html', import.meta.url), 'utf8')]);
  for (const [name, html] of sources) {
    // Карта содержит один рабочий точечный слой и прежние права разметки.
    assert.match(html, /<label class="layer-row off" id="shootLayerRow" hidden>/, name);
    assert.doesNotMatch(html, /id="gpkgLayerRow"/, name);
    assert.match(html, /\$\('shootLayerRow'\)\.hidden = !isPrefecture\(\) && !isDistrictEditor\(\)/, name);
    assert.doesNotMatch(html, /ПРОБНЫЙ ИМПОРТ/, name);

    assert.match(html, /\$\('shootToggle'\)\.hidden = !isPrefecture\(\)/, name);
    // Импортные точки не отображаются; район после входа видит свои точки
    // без галочек, без входа точки не показываются.
    assert.match(html, /if \(isGpkgPoint\(point\)\) return false;/, name);
    assert.match(html, /if \(isPrefecture\(\)\) return state\.shootLayerOn;\n    return isDistrictEditor\(\) && state\.shootLayerOn;/, name);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    for (const source of scripts) new Script(source, { filename: name });
  }
  // Шаблон не должен вернуть удалённые слои при пересборке.
  const template = sources[sources.length - 1][1];
  assert.equal((template.match(/id="prefectureArchiveRow"/g) || []).length, 0);
  assert.doesNotMatch(template, /prefecture-archive\?district=/);
});
