import Busboy from 'busboy';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function safeFilename(value) {
  const normalized = typeof value === 'string' ? value.replace(/[^a-zA-Z0-9._-]/g, '_') : 'photo';
  return normalized.slice(0, 120) || 'photo';
}

function magicMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function parseMultipart(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: request.headers, limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 24 } });
    } catch {
      reject(Object.assign(new Error('invalid_multipart'), { code: 'invalid_multipart' }));
      return;
    }
    const fields = {};
    const chunks = [];
    let fileInfo = null;
    let fileTooLarge = false;
    let failed = false;
    parser.on('field', (name, value) => {
      if (!(name in fields)) fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file') {
        stream.resume();
        return;
      }
      fileInfo = { filename: safeFilename(info.filename), mimeType: info.mimeType };
      stream.on('limit', () => { fileTooLarge = true; });
      stream.on('data', (chunk) => chunks.push(chunk));
    });
    parser.on('error', () => {
      failed = true;
      reject(Object.assign(new Error('invalid_multipart'), { code: 'invalid_multipart' }));
    });
    parser.on('finish', () => {
      if (failed) return;
      if (fileTooLarge || !fileInfo) {
        reject(Object.assign(new Error(fileTooLarge ? 'file_too_large' : 'file_required'), { code: fileTooLarge ? 'file_too_large' : 'file_required' }));
        return;
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) {
        reject(Object.assign(new Error('file_too_large'), { code: 'file_too_large' }));
        return;
      }
      const declaredMime = String(fileInfo.mimeType || '').toLowerCase();
      const actualMime = magicMime(buffer);
      if (!ALLOWED_MIME.has(declaredMime) || actualMime !== declaredMime) {
        reject(Object.assign(new Error('unsupported_image'), { code: 'unsupported_image' }));
        return;
      }
      resolve({ fields, file: { ...fileInfo, mimeType: actualMime, buffer } });
    });
    request.pipe(parser);
  });
}

export { ALLOWED_MIME, MAX_FILE_BYTES, magicMime };
