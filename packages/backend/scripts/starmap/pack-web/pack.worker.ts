// ============================================================
// SPIKE — not production. Browser pack (P5) worker: keeps the pack in the Origin Private File System (OPFS),
// reopens it without the network, and answers the three questions with SGP4 running right here in the worker.
//
// OPFS layout (root/orbitpack/):  <rawSha256>.gz  one blob per pack file (content-addressed, so a new pack version
// only adds the blobs that changed)  |  manifest-<version>.json  |  current.json {version}.
// Same shape as the app's sgp4.worker.ts: a worker that gets messages, owns the satrecs, replies with results.
// ============================================================
import { parseRows, rowsToText, applyLiveDelta, reconstructDay, type ElsetRow } from '../pack-format.js';
import { makeSat, overPolygon, pathOf, boxMembers, sgp4Burst, type Sat } from '../pack-query.js';

interface SyncHandle { getSize(): number; read(b: Uint8Array, o: { at: number }): number; write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void }
interface FileEntry { path: string; component: string; day?: string; rawBytes: number; gzBytes: number; sha256: string; rawSha256: string }
interface Manifest { version: string; asOf: string; window: { from: string; to: string; days: string[] }; files: FileEntry[]; slots: { uncertainty: string | null; conjunction: string | null }; live: { objects: number } }

const now = (): number => performance.now();
const ROOT = 'orbitpack';
const FILE_CONCURRENCY = 4;

async function rootDir(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}
async function writeFile(d: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const fh = await d.getFileHandle(name, { create: true });
  const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
  try { h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); } finally { h.close(); }
}
async function readFile(d: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  let fh: FileSystemFileHandle;
  try { fh = await d.getFileHandle(name); } catch { return null; }
  const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
  try { const b = new Uint8Array(h.getSize()); h.read(b, { at: 0 }); return b; } finally { h.close(); }
}
async function hasFile(d: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await d.getFileHandle(name); return true; } catch { return false; }
}
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (b: Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', b as unknown as BufferSource));
async function pipe(b: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as unknown as BlobPart]).stream().pipeThrough(t as unknown as ReadableWritablePair)).arrayBuffer());
}
const gunzip = (b: Uint8Array): Promise<Uint8Array> => pipe(b, new DecompressionStream('gzip'));
const gzip = (b: Uint8Array): Promise<Uint8Array> => pipe(b, new CompressionStream('gzip'));
const dec = new TextDecoder(), enc = new TextEncoder();
const blobName = (f: { rawSha256: string }): string => f.rawSha256 + '.gz';

async function currentManifest(d: FileSystemDirectoryHandle): Promise<Manifest | null> {
  const c = await readFile(d, 'current.json');
  if (!c) return null;
  const v = JSON.parse(dec.decode(c)).version as string;
  const m = await readFile(d, `manifest-${v}.json`);
  return m ? (JSON.parse(dec.decode(m)) as Manifest) : null;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

/** Delete blobs and manifests that the current manifest no longer references. */
async function gc(d: FileSystemDirectoryHandle, m: Manifest): Promise<number> {
  const keep = new Set<string>(['current.json', `manifest-${m.version}.json`, ...m.files.map(blobName)]);
  const drop: string[] = [];
  for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) if (!keep.has(k)) drop.push(k);
  for (const k of drop) await d.removeEntry(k);
  return drop.length;
}

async function commit(d: FileSystemDirectoryHandle, m: Manifest): Promise<number> {
  await writeFile(d, `manifest-${m.version}.json`, enc.encode(JSON.stringify(m)));
  await writeFile(d, 'current.json', enc.encode(JSON.stringify({ version: m.version })));
  return gc(d, m);
}

// ---------------- install / update ----------------

async function install(manifestUrl: string): Promise<unknown> {
  const t0 = now();
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  const d = await rootDir();
  const tm = now();
  const m = (await (await fetch(manifestUrl, { cache: 'no-store' })).json()) as Manifest;
  const manifestMs = now() - tm;
  const todo: FileEntry[] = [];
  for (const f of m.files) if (!(await hasFile(d, blobName(f)))) todo.push(f);
  let bytes = 0, fetchMs = 0, hashMs = 0, writeMs = 0;
  await pool(todo, FILE_CONCURRENCY, async (f) => {
    const a = now();
    const buf = new Uint8Array(await (await fetch(base + f.path, { cache: 'no-store' })).arrayBuffer());
    const b = now();
    if (buf.length !== f.gzBytes || (await sha256(buf)) !== f.sha256) throw new Error(`bad download ${f.path}`);
    const c = now();
    await writeFile(d, blobName(f), buf);
    const e = now();
    bytes += buf.length; fetchMs += b - a; hashMs += c - b; writeMs += e - c;
  });
  const w = now();
  const removed = await commit(d, m);
  return { version: m.version, totalMs: now() - t0, manifestMs, filesDownloaded: todo.length, filesReused: m.files.length - todo.length, bytes, sumFetchMs: fetchMs, sumHashMs: hashMs, sumWriteMs: writeMs, commitGcMs: now() - w, gcRemoved: removed, concurrency: FILE_CONCURRENCY };
}

async function update(deltaBase: string): Promise<unknown> {
  const t0 = now();
  const d = await rootDir();
  const cur = await currentManifest(d);
  if (!cur) throw new Error('nothing installed');
  const delta = await (await fetch(deltaBase + 'delta.json', { cache: 'no-store' })).json();
  const m = (await (await fetch(deltaBase + 'manifest.json', { cache: 'no-store' })).json()) as Manifest;
  if (delta.from !== cur.version) throw new Error(`delta is from ${delta.from}, installed ${cur.version}`);
  let bytes = 0;
  await pool(delta.add as string[], FILE_CONCURRENCY, async (p) => {
    const f = m.files.find((x) => x.path === p)!;
    const buf = new Uint8Array(await (await fetch(deltaBase + p, { cache: 'no-store' })).arrayBuffer());
    if ((await sha256(buf)) !== f.sha256) throw new Error(`bad download ${p}`);
    await writeFile(d, blobName(f), buf); bytes += buf.length;
  });
  // live catalog = installed live + delta rows
  const dl = new Uint8Array(await (await fetch(deltaBase + delta.live.file, { cache: 'no-store' })).arrayBuffer());
  bytes += dl.length;
  const oldLive = cur.files.find((f) => f.component === 'live')!;
  const base = parseRows(dec.decode(await gunzip((await readFile(d, blobName(oldLive)))!)));
  const merged = rowsToText(applyLiveDelta(base, parseRows(dec.decode(await gunzip(dl))), delta.live.removed as number[]));
  const raw = enc.encode(merged);
  if ((await sha256(raw)) !== delta.live.resultRawSha256) throw new Error('rebuilt live catalog does not match the manifest hash');
  const newLive = m.files.find((f) => f.component === 'live')!;
  await writeFile(d, blobName(newLive), await gzip(raw));
  const removed = await commit(d, m);
  return { from: delta.from, to: m.version, totalMs: now() - t0, bytes, filesAdded: (delta.add as string[]).length + 1, gcRemoved: removed };
}

// ---------------- open ----------------

let manifest: Manifest | null = null;
let sats: Sat[] = [];
let satByNorad = new Map<number, Sat>();
let poly: Array<[number, number]> = [];
let histRows: ElsetRow[] | null = null;
let root: FileSystemDirectoryHandle | null = null;

async function open(): Promise<unknown> {
  const t0 = now();
  root = await rootDir();
  const m = await currentManifest(root);
  if (!m) return { installed: false };
  const t1 = now();
  const live = m.files.find((f) => f.component === 'live')!;
  const gzLive = (await readFile(root, blobName(live)))!;
  const t2 = now();
  const text = dec.decode(await gunzip(gzLive));
  const t3 = now();
  const rows = parseRows(text);
  const t4 = now();
  sats = []; satByNorad = new Map();
  let bad = 0;
  for (const r of rows) { const s = makeSat(r); if (s) { sats.push(s); satByNorad.set(s.norad, s); } else bad++; }
  const t5 = now();
  const pf = m.files.find((f) => f.component === 'params')!;
  poly = JSON.parse(dec.decode(await gunzip((await readFile(root, blobName(pf)))!))).indiaPoly;
  manifest = m; histRows = null;
  const t6 = now();
  return { installed: true, version: m.version, objects: rows.length, satrecs: sats.length, badElements: bad, totalMs: t6 - t0, manifestMs: t1 - t0, readLiveMs: t2 - t1, gunzipLiveMs: t3 - t2, parseLiveMs: t4 - t3, satrecMs: t5 - t4, paramsMs: t6 - t5 };
}

/** Re-check every stored blob: gunzip and compare the raw sha256 with the manifest. */
async function integrity(): Promise<unknown> {
  const t0 = now();
  if (!root || !manifest) throw new Error('not open');
  let bad = 0, rawBytes = 0;
  for (const f of manifest.files) {
    const b = await readFile(root, blobName(f));
    if (!b) { bad++; continue; }
    const raw = await gunzip(b); rawBytes += raw.length;
    if ((await sha256(raw)) !== f.rawSha256) bad++;
  }
  return { files: manifest.files.length, bad, rawBytes, ms: now() - t0 };
}

async function loadHistory(): Promise<ElsetRow[]> {
  if (histRows) return histRows;
  if (!root || !manifest) throw new Error('not open');
  const out: ElsetRow[] = [];
  for (const f of manifest.files) if (f.component === 'elsets') out.push(...parseRows(dec.decode(await gunzip((await readFile(root, blobName(f)))!))));
  histRows = out;
  return out;
}

// ---------------- questions ----------------

async function qIndia(tMs: number): Promise<unknown> {
  const a = now();
  const r = overPolygon(sats, tMs, poly);
  return { tMs, ms: now() - a, propagated: r.propagated, failed: r.failed, count: r.hits.length, hits: r.hits };
}
async function qIss(tMs: number, hours: number, stepS: number): Promise<unknown> {
  const s = satByNorad.get(25544);
  if (!s) throw new Error('ISS not in catalog');
  const a = now();
  const p = pathOf(s, tMs, hours, stepS);
  const ms = now() - a;
  return { tMs, ms, n: p.n, failed: p.failed, teme: Array.from(p.teme), lat: Array.from(p.lat), lon: Array.from(p.lon), alt: Array.from(p.alt) };
}
async function qBox(day: string, order: number, cell: number): Promise<unknown> {
  if (!root || !manifest) throw new Error('not open');
  const f = manifest.files.find((x) => x.component === 'starmap' && x.day === day);
  if (!f) throw new Error(`no star-map list for ${day} in this pack`);
  const a = now();
  const gzb = (await readFile(root, blobName(f)))!;
  const b = now();
  const raw = await gunzip(gzb);
  const c = now();
  const ids = boxMembers(raw, order, cell);
  const e = now();
  return { day, order, cell, count: ids.length, norads: ids, readMs: b - a, gunzipMs: c - b, lookupMs: e - c, ms: e - a };
}
async function qBoxAllDays(order: number, cell: number): Promise<unknown> {
  const a = now();
  const per: Array<{ day: string; count: number }> = [];
  const union = new Set<number>();
  for (const day of manifest!.window.days) { const r = (await qBox(day, order, cell)) as { count: number; norads: number[] }; per.push({ day, count: r.count }); for (const n of r.norads) union.add(n); }
  return { ms: now() - a, per, union: union.size };
}
async function qDayCatalog(day: string): Promise<unknown> {
  const a = now();
  const rows = await loadHistory();
  const b = now();
  const cat = reconstructDay(rows, Date.parse(day + 'T00:00:00Z'));
  const c = now();
  const text = cat.map((r) => r.norad + '|' + r.epoch).join('\n');
  return { day, count: cat.length, loadHistoryMs: b - a, rebuildMs: c - b, digest: await sha256(enc.encode(text)), historyRows: rows.length };
}
async function bench(minMs: number): Promise<unknown> {
  const t = Date.UTC(2026, 9, 24, 12, 0, 0);
  sgp4Burst(sats.slice(0, 2000), t, 1, now); // warm-up (JIT)
  let calls = 0, ms = 0, pass = 0;
  while (ms < minMs) { const r = sgp4Burst(sats, t + pass * 600_000, 1, now); calls += r.calls; ms += r.ms; pass++; }
  return { objects: sats.length, passes: pass, calls, ms, callsPerSec: (calls / ms) * 1000, usPerCall: (ms * 1000) / calls };
}
async function clear(): Promise<unknown> {
  await (await navigator.storage.getDirectory()).removeEntry(ROOT, { recursive: true }).catch(() => undefined);
  manifest = null; sats = []; satByNorad = new Map(); histRows = null; root = null;
  return { cleared: true };
}

interface Msg { id: number; op: string; args: Record<string, unknown> }
const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<Msg>) => void) | null };
ctx.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    let result: unknown;
    switch (op) {
      case 'install': result = await install(args.manifestUrl as string); break;
      case 'update': result = await update(args.deltaBase as string); break;
      case 'open': result = await open(); break;
      case 'integrity': result = await integrity(); break;
      case 'india': result = await qIndia(args.tMs as number); break;
      case 'iss': result = await qIss(args.tMs as number, args.hours as number, args.stepS as number); break;
      case 'box': result = await qBox(args.day as string, args.order as number, args.cell as number); break;
      case 'boxAll': result = await qBoxAllDays(args.order as number, args.cell as number); break;
      case 'dayCatalog': result = await qDayCatalog(args.day as string); break;
      case 'bench': result = await bench(args.minMs as number); break;
      case 'clear': result = await clear(); break;
      case 'info': result = manifest ? { version: manifest.version, window: manifest.window, slots: manifest.slots, objects: sats.length } : null; break;
      default: throw new Error('unknown op ' + op);
    }
    ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
