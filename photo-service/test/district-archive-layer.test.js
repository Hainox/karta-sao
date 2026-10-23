import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const districtPages = readdirSync(new URL('../../districts/', import.meta.url))
  .filter((name) => name.endsWith('.html') && !['index.html', 'review.html', 'acceptance.html'].includes(name));

test('all district maps have a prefecture-only hideable archive layer and valid inline script', () => {
  assert.equal(districtPages.length, 16);
  for (const page of districtPages) {
    const html = readFileSync(new URL(`../../districts/${page}`, import.meta.url), 'utf8');
    assert.equal((html.match(/id="prefectureArchiveRow"/g) || []).length, 1, page);
    assert.match(html, /id="prefectureArchiveToggle"/);
    assert.match(html, /prefecture-archive\?district=/);
    assert.match(html, /if \(!isPrefecture\(\) && state\.prefectureArchiveOn\) setPrefectureArchiveLayer\(false\)/);
    assert.match(html, /\.shoot-marker\.archive \.shoot-dot\{background:#7b61a8/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    for (const source of scripts) new Script(source, { filename: page });
  }
});

test('imported layers and markup mode are prefecture-only on district maps and in the template', () => {
  const sources = districtPages.map((page) => [
    page,
    readFileSync(new URL(`../../districts/${page}`, import.meta.url), 'utf8'),
  ]);
  sources.push(['district_page_template.html', readFileSync(new URL('../../work/district_page_template.html', import.meta.url), 'utf8')]);
  for (const [name, html] of sources) {
    // Строки служебных слоёв не видны до входа префектуры.
    assert.match(html, /<label class="layer-row off" id="shootLayerRow" hidden>/, name);
    assert.match(html, /<label class="layer-row" id="gpkgLayerRow" hidden>/, name);
    assert.match(html, /\$\('shootLayerRow'\)\.hidden = !isPrefecture\(\) && !isDistrictEditor\(\)/, name);
    assert.doesNotMatch(html, /ПРОБНЫЙ ИМПОРТ/, name);
    assert.match(html, /\$\('gpkgLayerRow'\)\.hidden = !isPrefecture\(\)/, name);
    assert.match(html, /\$\('shootToggle'\)\.hidden = !isPrefecture\(\)/, name);
    // Импортные точки — только префектуре; район после входа видит свои точки
    // без галочек, без входа точки не показываются.
    assert.match(html, /if \(isGpkgPoint\(point\)\) return isPrefecture\(\) && state\.gpkgLayerOn;/, name);
    assert.match(html, /if \(isPrefecture\(\)\) return state\.shootLayerOn;\n    return isDistrictEditor\(\) && state\.shootLayerOn;/, name);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    for (const source of scripts) new Script(source, { filename: name });
  }
  // Архивный слой есть и в шаблоне: пересборка страниц его не потеряет.
  const template = sources[sources.length - 1][1];
  assert.equal((template.match(/id="prefectureArchiveRow"/g) || []).length, 1);
  assert.match(template, /prefecture-archive\?district=/);
});
