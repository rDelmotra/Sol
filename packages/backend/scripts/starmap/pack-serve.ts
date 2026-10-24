// SPIKE — not production. Static server for the pack prototype (localhost only).
//   /            the built page (data/pack/web/)
//   /pack/<p>    pack files from data/pack/<p>  (no-store; optional per-connection throttle)
//   /pack/latest/<f>  alias for the pack directory given by --latest
//   /__log       JSON list of requests since the last /__log/reset (so a test can prove "no pack download happened")
// Usage: npx tsx packages/backend/scripts/starmap/pack-serve.ts --latest 2026-10-18.xxxxxxxx [--port 8123] [--mbps 100]
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './catalog.js';

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.get('port') ?? 8123);
const MBPS = Number(args.get('mbps') ?? 0);
const LATEST = args.get('latest') ?? '';
const PACK = resolve(fileURLToPath(new URL('../../data/pack/', import.meta.url)));
const WEB = resolve(PACK, 'web');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.gz': 'application/octet-stream' };
const log: Array<{ t: number; url: string; bytes: number }> = [];

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/__log') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(log)); return; }
  if (p === '/__log/reset') { log.length = 0; res.end('ok'); return; }
  let file: string; let throttle = false;
  if (p.startsWith('/pack/')) {
    p = p.slice(6).replace(/^latest\//, LATEST + '/');
    file = resolve(PACK, '.' + sep + p); throttle = true;
    if (!file.startsWith(PACK + sep) || file.startsWith(WEB + sep)) { res.statusCode = 403; res.end(); return; }
  } else {
    file = resolve(WEB, '.' + (p === '/' ? '/index.html' : p));
    if (!file.startsWith(WEB + sep)) { res.statusCode = 403; res.end(); return; }
  }
  if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end('not found'); return; }
  const size = statSync(file).size;
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.setHeader('content-length', size);
  res.setHeader('cache-control', 'no-store');
  if (throttle) log.push({ t: Date.now(), url: url.pathname, bytes: size });
  const rs = createReadStream(file, { highWaterMark: 64 * 1024 });
  if (!(throttle && MBPS > 0)) { rs.pipe(res); return; }
  // throttle: each connection gets MBPS megabit/s
  const bytesPerMs = (MBPS * 1e6) / 8 / 1000;
  const t0 = Date.now(); let sent = 0;
  rs.on('data', (chunk: string | Buffer) => {
    const c = chunk as Buffer;
    res.write(c); sent += c.length;
    const wait = sent / bytesPerMs - (Date.now() - t0);
    if (wait > 1) { rs.pause(); setTimeout(() => rs.resume(), wait); }
  });
  rs.on('end', () => res.end());
}).listen(PORT, '127.0.0.1', () => console.log(`pack server http://127.0.0.1:${PORT}/  latest=${LATEST || '(none)'} throttle=${MBPS || 'off'} Mbit/s per connection`));
