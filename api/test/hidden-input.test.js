import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { readHiddenInput } from '../lib/hidden-input.js';

function fakeTerminal() {
  const input = new PassThrough();
  Object.defineProperty(input, 'isTTY', { value: true });
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  Object.defineProperty(output, 'isTTY', { value: true });
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString(); });
  return { input, output, written: () => written };
}

test('hidden input accepts UTF-8 without echoing the password', async () => {
  const terminal = fakeTerminal();
  const password = readHiddenInput('Пароль: ', terminal);
  terminal.input.write(Buffer.from('сек'));
  terminal.input.write(Buffer.from('рет\n'));

  assert.equal(await password, 'секрет');
  assert.equal(terminal.written(), 'Пароль: \n');
  assert.equal(terminal.input.isRaw, false);
});
