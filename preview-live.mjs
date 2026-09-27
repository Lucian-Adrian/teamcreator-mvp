import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import worker from './live-worker.mjs';

const root = path.resolve('dist-live');
const port = Number(process.env.TC_LIVE_PREVIEW_PORT || 5187);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__qa/mobile') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="ro"><title>TeamCreator mobile QA 390 × 844</title><body style="margin:0;background:#eef0f4"><iframe title="TeamCreator 390 × 844" src="/" style="display:block;width:390px;height:844px;border:0;margin:16px auto;background:white"></iframe></body></html>');
      return;
    }
    const assets = { async fetch(req) {
      const pathname = decodeURIComponent(new URL(req.url).pathname);
      let file = path.resolve(root, '.' + pathname);
      if (file !== root && !file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
      let bytes;
      try { bytes = await readFile(file); } catch {
        if (path.extname(pathname)) return new Response('Not found', { status: 404 });
        file = path.join(root, 'index.html'); bytes = await readFile(file);
      }
      return new Response(bytes, { headers: { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' } });
    } };
    const result = await worker.fetch(new Request(url, { method: request.method }), { ASSETS: assets });
    // Only the loopback preview allows its same-origin responsive QA frame.
    result.headers.delete('X-Frame-Options');
    result.headers.set('Content-Security-Policy', (result.headers.get('Content-Security-Policy') || '').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500); response.end('Preview unavailable. Run npm run build:live first.');
  }
}).listen(port, '127.0.0.1', () => console.log(`TeamCreator public preview http://127.0.0.1:${port}`));
