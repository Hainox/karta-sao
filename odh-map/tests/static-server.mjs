import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mimeTypes = { '.css':'text/css; charset=utf-8', '.geojson':'application/geo+json; charset=utf-8', '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };

http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const target = path.resolve(root, `.${relativePath}`);
    if (!target.startsWith(`${root}${path.sep}`)) return response.writeHead(403).end();
    const content = await fs.readFile(target);
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control':'no-store' }).end(content);
  } catch (_) { response.writeHead(404).end(); }
}).listen(8766, '127.0.0.1');
