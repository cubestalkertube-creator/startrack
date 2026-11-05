import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.env.WEB_DIR || fileURLToPath(new URL('../../web', import.meta.url)));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.mp3':'audio/mpeg', '.json':'application/json', '.webmanifest':'application/manifest+json' };
export function serveWeb(req,res,url) {
  if (!['GET','HEAD'].includes(req.method) || url.pathname.startsWith('/api/') || url.pathname === '/ws') return false;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
  if (pathname.includes('\0') || pathname.includes('\\')) return false;
  const file = path.resolve(root, '.' + (pathname === '/' || pathname === '/app' || pathname === '/app/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type':types[ext] || 'application/octet-stream', 'Content-Length':stat.size,
    'Cache-Control':pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin',
    'Permissions-Policy':'camera=(self), microphone=(self), display-capture=(self)' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}
