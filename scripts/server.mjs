import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fs.realpathSync(fileURLToPath(new URL('../dist', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function insideRoot(file) { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }

export function createServer() {
  return http.createServer(async (req, res) => {
    const security = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    const reply = (status, message, headers = {}) => { res.writeHead(status, { ...security, 'Content-Type': 'text/plain; charset=utf-8', ...headers }); res.end(req.method === 'HEAD' ? undefined : message); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    let relative;
    try { relative = decodeURIComponent((req.url || '/').split('?')[0]); } catch { return reply(400, 'Invalid URL'); }
    if (relative.includes('\0') || relative.includes('\\')) return reply(400, 'Invalid path');
    if (relative.split('/').some(part => part === '..' || part.startsWith('.'))) return reply(403, 'Forbidden');
    if (relative === '/__cinecut/health') { res.writeHead(200, { ...security, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ app: 'cinecut', version: '1.0.0' })); }
    let file = path.resolve(root, '.' + relative);
    if (!insideRoot(file)) return reply(403, 'Forbidden');
    if (relative.endsWith('/')) file = path.join(file, 'index.html');
    try {
      file = await fs.promises.realpath(file);
      if (!insideRoot(file)) return reply(403, 'Forbidden');
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return reply(404, 'Not found');
      const range = parseRange(req.headers.range, stat.size);
      if (range === false) return reply(416, 'Range not satisfiable', { 'Content-Range': `bytes */${stat.size}` });
      const headers = { ...security, 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Content-Length': range ? range.end - range.start + 1 : stat.size };
      if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file, range || undefined);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { reply(404, 'Not found'); }
  });
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open this address in your browser: ${url}`));
  child.unref();
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT must be between 1 and 65535.'); process.exit(1); }
  const url = `http://127.0.0.1:${port}`;
  const server = createServer();
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
      try {
        const r = await fetch(url + '/__cinecut/health', { signal: AbortSignal.timeout(2000) });
        if (r.ok && (await r.json()).app === 'cinecut') { console.log(`CineCut is already running: ${url}`); if (process.argv.includes('--open')) openBrowser(url); return; }
      } catch {}
      console.error(`Port ${port} is occupied. Set PORT to another free port.`);
    } else console.error(`Unable to start CineCut: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => { console.log(`CineCut is running at ${url}\nLocal files stay on this computer. Press Ctrl+C to stop.`); if (process.argv.includes('--open')) openBrowser(url); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
