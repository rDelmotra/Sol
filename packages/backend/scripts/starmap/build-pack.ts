// ============================================================
// SPIKE — not production. Browser pack builder (P5): the offline "Perceptor pack".
//
// Writes a versioned, chunked pack into packages/backend/data/pack/<version>/ (gitignored):
//   manifest.json                 version, window, every file with sizes and sha256, slots for U5 / S5
//   params.json                   India polygon (from coverage-lib.ts) so the page uses the same shape
//   live.tsv.gz                   the live catalog (names, type, regime + elements), one row per object
//   elsets-<date>.tsv.gz          unique element sets seen in the window's daily history files, split by the
//                                 UTC date of the set's EPOCH (so a window that slides forward leaves old chunks alone)
//   starmap-<day>.day.bin.gz      the T1 star-map list file for that day (whole-day granularity, orders 2/3/4)
//   uncertainty.json.gz / conjunction.json.gz   only when U5 / S5 output exists at build time; else null slots
// A pack day (history catalog) is not stored: it is rebuilt from the element-set chunks (pack-format.reconstructDay).
// This script CHECKS that rebuild equals every real history day file and fails if not.
//
// Daily delta (--delta-from <previous pack dir>) writes data/pack/delta-<from>-to-<to>/ with only the files that are
// new or changed, plus live.delta.tsv.gz (live rows that changed) and delta.json (what to remove).
//
// Usage (repo root):
//   npx tsx packages/backend/scripts/starmap/build-pack.ts [--to 2026-10-18] [--days 14] [--live <json|history:YYYY-MM-DD>]
//                                                          [--delta-from <dir>] [--out <dir>]
// ============================================================
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { gzipSync, gunzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadCatalog, parseArgs } from './catalog.js';
import { listDays, COVERAGE_DIR, INDIA_POLY } from './coverage-lib.js';
import { rowFromCatalog, rowsToText, parseRows, reconstructDay, applyLiveDelta, type ElsetRow } from './pack-format.js';

const DATA = fileURLToPath(new URL('../../data/', import.meta.url));
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const gz = (b: Uint8Array | string): Buffer => gzipSync(b, { level: 9 });
const br = (b: Uint8Array | string): number => brotliCompressSync(b, { params: { [zc.BROTLI_PARAM_QUALITY]: 9, [zc.BROTLI_PARAM_SIZE_HINT]: typeof b === 'string' ? b.length : b.length } }).length;

export interface PackFile { path: string; component: string; day?: string; rawBytes: number; gzBytes: number; brBytes: number; sha256: string; rawSha256: string }
export interface Manifest {
  format: 1; version: string; builtAt: string; asOf: string;
  window: { from: string; to: string; days: string[] };
  live: { source: string; objects: number };
  files: PackFile[];
  slots: { uncertainty: string | null; conjunction: string | null };
  checks: { daysReconstructed: number; daysExact: number };
}

const args = parseArgs(process.argv.slice(2));
const to = args.get('to') ?? '2026-10-18';
const nDays = Number(args.get('days') ?? 14);
const liveArg = args.get('live') ?? DATA + 'tle-cache.json';
const outRoot = args.get('out') ?? DATA + 'pack';
const deltaFrom = args.get('delta-from');

function addFile(files: PackFile[], dir: string, path: string, component: string, raw: Uint8Array | string, day?: string): Buffer {
  const rawBuf = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const z = gz(rawBuf);
  writeFileSync(dir + '/' + path, z);
  files.push({ path, component, day, rawBytes: rawBuf.length, gzBytes: z.length, brBytes: br(rawBuf), sha256: sha(z), rawSha256: sha(rawBuf) });
  return z;
}

function main(): void {
  const t0 = Date.now();
  const all = listDays().filter((d) => d.day <= to);
  const win = all.slice(-nDays);
  if (win.length < nDays) throw new Error(`only ${win.length} history days <= ${to}`);
  const days = win.map((d) => d.day);
  console.log(`window ${days[0]}..${days[days.length - 1]} (${days.length} days)`);

  // --- element sets seen in the window's history files, deduped by (norad, EPOCH), split by epoch date
  const seen = new Set<string>();
  const byDate = new Map<string, ElsetRow[]>();
  const rowsSoFar: ElsetRow[] = [];
  let daysExact = 0;
  for (const d of win) {
    const cat = loadCatalog(d.path);
    const dayRows = cat.map((o) => rowFromCatalog(o, false));
    for (const r of dayRows) {
      const k = r.norad + '|' + r.epoch;
      if (seen.has(k)) continue;
      seen.add(k);
      rowsSoFar.push(r);
      const date = r.epoch.slice(0, 10);
      let a = byDate.get(date); if (!a) byDate.set(date, (a = []));
      a.push(r);
    }
    // check: the pack rule rebuilds exactly this day from the sets seen up to and including it
    const rec = reconstructDay(rowsSoFar, d.startMs);
    const want = new Map(dayRows.map((r) => [r.norad, r.epoch]));
    let ok = rec.length === want.size;
    if (ok) for (const r of rec) if (want.get(r.norad) !== r.epoch) { ok = false; break; }
    if (ok) daysExact++; else console.error(`  RECONSTRUCT MISMATCH on ${d.day}: rebuilt ${rec.length} vs file ${want.size}`);
  }
  if (daysExact !== win.length) throw new Error('pack day rebuild rule does not reproduce the history files');
  console.log(`  ${seen.size} unique element sets, ${byDate.size} epoch-date chunks, day rebuild exact on ${daysExact}/${win.length} days`);

  // --- live catalog
  let liveCat; let liveSrc: string;
  if (liveArg.startsWith('history:')) { const day = liveArg.slice(8); liveCat = loadCatalog(DATA + `history/catalog-${day}.json`); liveSrc = `history ${day}`; }
  else { liveCat = loadCatalog(liveArg); liveSrc = liveArg.split('/').pop()!; }
  const liveMap = new Map<number, ElsetRow>();
  for (const o of liveCat) liveMap.set(o.noradId, rowFromCatalog(o, true));
  const liveRows = [...liveMap.values()].sort((a, b) => a.norad - b.norad);
  const liveText = rowsToText(liveRows);

  // --- files (written to a temp dir first, renamed to the version once the hash is known)
  const tmp = outRoot + '/.building';
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  const files: PackFile[] = [];
  addFile(files, tmp, 'live.tsv.gz', 'live', liveText);
  for (const date of [...byDate.keys()].sort()) {
    const rows = byDate.get(date)!.sort((a, b) => a.norad - b.norad || (a.epoch < b.epoch ? -1 : 1));
    addFile(files, tmp, `elsets-${date}.tsv.gz`, 'elsets', rowsToText(rows), date);
  }
  for (const day of days) addFile(files, tmp, `starmap-${day}.day.bin.gz`, 'starmap', readFileSync(COVERAGE_DIR + `${day}.day.bin`), day);
  const params = JSON.stringify({ indiaPoly: INDIA_POLY, box: { order: 3, cell: 9138 }, iss: 25544 });
  addFile(files, tmp, 'params.json.gz', 'params', params);

  // --- optional slots
  const slots: Manifest['slots'] = { uncertainty: null, conjunction: null };
  const unc = DATA + 'uncertainty/model.json';
  if (existsSync(unc)) { addFile(files, tmp, 'uncertainty.json.gz', 'uncertainty', readFileSync(unc)); slots.uncertainty = 'uncertainty.json.gz'; }
  for (const c of ['conjunction/conjunction.json', 'conjunction.json']) {
    if (existsSync(DATA + c)) { addFile(files, tmp, 'conjunction.json.gz', 'conjunction', readFileSync(DATA + c)); slots.conjunction = 'conjunction.json.gz'; break; }
  }

  const version = `${to}.${sha(files.map((f) => f.sha256).join('')).slice(0, 8)}`;
  const manifest: Manifest = {
    format: 1, version, builtAt: new Date().toISOString(), asOf: to,
    window: { from: days[0]!, to: days[days.length - 1]!, days },
    live: { source: liveSrc, objects: liveRows.length },
    files, slots, checks: { daysReconstructed: win.length, daysExact },
  };
  writeFileSync(tmp + '/manifest.json', JSON.stringify(manifest, null, 1));
  const dir = outRoot + '/' + version;
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);

  // --- sizes report
  const comp = new Map<string, { n: number; raw: number; gz: number; br: number }>();
  for (const f of files) { const c = comp.get(f.component) ?? { n: 0, raw: 0, gz: 0, br: 0 }; c.n++; c.raw += f.rawBytes; c.gz += f.gzBytes; c.br += f.brBytes; comp.set(f.component, c); }
  const tot = { raw: 0, gz: 0, br: 0 };
  console.log('component   files        raw MB      gzip MB   brotli9 MB');
  for (const [k, c] of comp) { tot.raw += c.raw; tot.gz += c.gz; tot.br += c.br; console.log(`${k.padEnd(11)} ${String(c.n).padStart(5)} ${(c.raw / 1e6).toFixed(2).padStart(12)} ${(c.gz / 1e6).toFixed(2).padStart(12)} ${(c.br / 1e6).toFixed(2).padStart(12)}`); }
  console.log(`TOTAL       ${String(files.length).padStart(5)} ${(tot.raw / 1e6).toFixed(2).padStart(12)} ${(tot.gz / 1e6).toFixed(2).padStart(12)} ${(tot.br / 1e6).toFixed(2).padStart(12)}`);
  writeFileSync(dir + '/sizes.json', JSON.stringify({ components: Object.fromEntries(comp), total: tot }, null, 1));
  console.log(`slots: uncertainty=${slots.uncertainty ?? 'EMPTY (no data/uncertainty/model.json)'} conjunction=${slots.conjunction ?? 'EMPTY (no conjunction export)'}`);
  console.log(`pack ${version} -> ${dir}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  if (deltaFrom) buildDelta(deltaFrom.replace(/\/$/, ''), dir, manifest, liveRows);
}

function buildDelta(prevDir: string, newDir: string, B: Manifest, liveB: ElsetRow[]): void {
  const A = JSON.parse(readFileSync(prevDir + '/manifest.json', 'utf8')) as Manifest;
  const out = `${outRoot}/delta-${A.version}-to-${B.version}`;
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const have = new Map(A.files.map((f) => [f.path, f.sha256]));
  const add: string[] = [], keep: string[] = [];
  for (const f of B.files) {
    if (f.component === 'live') continue;
    if (have.get(f.path) === f.sha256) { keep.push(f.path); continue; }
    add.push(f.path); copyFileSync(newDir + '/' + f.path, out + '/' + f.path);
  }
  const remove = A.files.filter((f) => !B.files.some((g) => g.path === f.path)).map((f) => f.path);
  // live: rows that changed or are new, plus norads that vanished
  const liveA = parseRows(gunzipText(prevDir + '/live.tsv.gz'));
  const aMap = new Map(liveA.map((r) => [r.norad, r]));
  const changed = liveB.filter((r) => { const a = aMap.get(r.norad); return !a || rowsToText([a]) !== rowsToText([r]); });
  const bSet = new Set(liveB.map((r) => r.norad));
  const removed = liveA.filter((r) => !bSet.has(r.norad)).map((r) => r.norad);
  const deltaText = rowsToText(changed);
  const dz = gz(deltaText); writeFileSync(out + '/live.delta.tsv.gz', dz);
  // prove the delta rebuilds B's live catalog byte for byte
  const rebuilt = rowsToText(applyLiveDelta(liveA, parseRows(deltaText), removed));
  const liveEntry = B.files.find((f) => f.component === 'live')!;
  if (sha(rebuilt) !== liveEntry.rawSha256) throw new Error('live delta does not rebuild the live catalog');
  const delta = {
    from: A.version, to: B.version, add, keep: keep.length, remove,
    live: { file: 'live.delta.tsv.gz', gzBytes: dz.length, rows: changed.length, removed, baseRawSha256: A.files.find((f) => f.component === 'live')!.rawSha256, resultRawSha256: liveEntry.rawSha256 },
  };
  writeFileSync(out + '/delta.json', JSON.stringify(delta));
  copyFileSync(newDir + '/manifest.json', out + '/manifest.json');
  let bytes = dz.length;
  for (const p of add) bytes += B.files.find((f) => f.path === p)!.gzBytes;
  const meta = readFileSync(out + '/delta.json').length + readFileSync(out + '/manifest.json').length;
  console.log(`delta ${A.version} -> ${B.version}: ${add.length} files added/changed, ${remove.length} removed, ${keep.length} unchanged; live rows changed ${changed.length}/${liveB.length}, removed ${removed.length}`);
  console.log(`delta download: ${(bytes / 1e6).toFixed(2)} MB data (+${(meta / 1e3).toFixed(0)} KB manifest/delta.json); live delta ${(dz.length / 1e6).toFixed(2)} MB; day dir ${out}`);
  const per = add.map((p) => `${p}=${(B.files.find((f) => f.path === p)!.gzBytes / 1e6).toFixed(3)}MB`);
  console.log('  added: ' + per.join(' '));
}

function gunzipText(p: string): string { return gunzipSync(readFileSync(p)).toString('utf8'); }

main();
