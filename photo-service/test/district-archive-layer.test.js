import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const districtPages = readdirSync(new URL('../../districts/', import.meta.url))
  .filter((name) => name.endsWith('.html') && !['index.html', 'review.html'].includes(name));

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
