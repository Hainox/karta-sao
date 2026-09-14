import { StringDecoder } from 'node:string_decoder';

export function readHiddenInput(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Скрытый ввод доступен только в интерактивном терминале.'));
  }

  output.write(prompt);
  const previousRawMode = input.isRaw;
  const decoder = new StringDecoder('utf8');
  const characters = [];

  return new Promise((resolve, reject) => {
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(previousRawMode ?? false);
      output.write('\n');
      if (error) reject(error);
      else resolve(characters.join(''));
    };

    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003' || character === '\u0004') return finish(new Error('Ввод пароля отменён.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') characters.pop();
        else if (character >= ' ') characters.push(character);
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
