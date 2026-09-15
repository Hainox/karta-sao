import Busboy from 'busboy';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
// The optional preview attached to a photo is deliberately small: the export
// embeds it into the workbook and never the original file.
const MAX_THUMBNAIL_BYTES = 512 * 1024;
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

function accept(buffer, info, code) {
  if (buffer.length === 0) return null;
  const declaredMime = String(info.mimeType || '').toLowerCase();
  const actualMime = magicMime(buffer);
  if (!ALLOWED_MIME.has(declaredMime) || actualMime !== declaredMime) {
    throw Object.assign(new Error(code), { code });
  }
  return { ...info, mimeType: actualMime, buffer };
}

export function parseMultipart(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: request.headers, limits: { fileSize: MAX_FILE_BYTES, files: 2, fields: 24 } });
    } catch {
      reject(Object.assign(new Error('invalid_multipart'), { code: 'invalid_multipart' }));
      return;
    }
    const fields = {};
    const chunks = [];
    const thumbnailChunks = [];
    let fileInfo = null;
    let thumbnailInfo = null;
    let fileTooLarge = false;
    let thumbnailTooLarge = false;
    let failed = false;

    parser.on('field', (name, value) => {
      if (!(name in fields)) fields[name] = value;
    });

    parser.on('file', (name, stream, info) => {
      if (name !== 'file' && name !== 'thumbnail') {
        stream.resume();
        return;
      }
      const isThumbnail = name === 'thumbnail';
      if (isThumbnail) thumbnailInfo = { filename: safeFilename(info.filename), mimeType: info.mimeType };
      else fileInfo = { filename: safeFilename(info.filename), mimeType: info.mimeType };
      let size = 0;
      stream.on('limit', () => { if (isThumbnail) thumbnailTooLarge = true; else fileTooLarge = true; });
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (isThumbnail) {
          if (size > MAX_THUMBNAIL_BYTES) { thumbnailTooLarge = true; return; }
          thumbnailChunks.push(chunk);
          return;
        }
        chunks.push(chunk);
      });
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
      if (thumbnailTooLarge) {
        reject(Object.assign(new Error('thumbnail_too_large'), { code: 'thumbnail_too_large' }));
        return;
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) {
        reject(Object.assign(new Error('file_too_large'), { code: 'file_too_large' }));
        return;
      }
      let file;
      let thumbnail;
      try {
        file = accept(buffer, fileInfo, 'unsupported_image');
        thumbnail = thumbnailInfo ? accept(Buffer.concat(thumbnailChunks), thumbnailInfo, 'unsupported_thumbnail') : null;
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ fields, file, thumbnail });
    });
    request.pipe(parser);
  });
}

export { ALLOWED_MIME, MAX_FILE_BYTES, MAX_THUMBNAIL_BYTES, magicMime };
