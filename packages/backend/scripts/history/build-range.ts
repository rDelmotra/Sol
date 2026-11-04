// ============================================================
// History backfill: per-day star-map coverage (daily order 3 + 4, NO hourly) and lifecycle / change events for a range of UTC days,
// from the per-day element-set files written by convert.py. Output is FILES only, in the formats production reads:
//
//   <out>/coverage/<day>/manifest.json + day.o3.bin + day.o4.bin      (coverage/store.ts writeDay: the volume layout of SSA_COVERAGE_DIR)
//   <out>/events/YYYY/YYYY-MM-DD.jsonl.gz                             (one ssa_event row per line: day, kind, subjects, t_start, t_end, payload)
//   <out>/done/<part>/YYYY/<day>.json                                 (completion marker + stats of a day / part; a restart skips them)
//
//   tsx build-range.ts --elsets DIR --objects FILE --out DIR --from 2020-01-01 --to 2020-12-31 --workers 24 --parts coverage,changes [--shard 0/8]
//   tsx build-range.ts --check-chain --elsets DIR [--years 1965,1985,2005,2025] [--sample 400] [--window-days 14] [--max-gap-days 5] [--json FILE]
//
// Options
//   --workers N         coverage worker threads of THIS process (default: cores); the change detection runs in 1 more worker thread
//   --shard k/n         process the days with (day index) % n == k, so n processes can split a range (round robin; every process
//                       reads the same element-set files, the output files are disjoint)
//   --era-file FILE     JSON array replacing the ERA_TABLE of src/ssa/history/era.ts (fromYear, windowDays, jumpDposKm, jumpDaKm)
//   --window-days N     force one staleness window for every day (overrides the era table)
//   --min-objects N     a day with fewer objects in its catalog builds no coverage (default 1)
//   --skip-formation    no close.formation pass
//   --force             redo days that have a marker
//   --step-s N          coverage sampling step in seconds (default 10: production)
// ============================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WorkerPool } from '../../src/ssa/pool.js';
import { buildDay } from '../../src/ssa/coverage/build.js';
import { writeDay } from '../../src/ssa/coverage/store.js';
import { DAY_MS } from '../../src/ssa/coverage/consts.js';
import { ERA_TABLE, eraFor, validateEraTable, type EraSettings } from '../../src/ssa/history/era.js';
import { FileCatalog, dayMs, firstSeenOf, isoDayOf, toOmmObjects } from '../../src/ssa/history/catalog-files.js';
import { loadObjects, readElsetDay, type Elset } from '../../src/ssa/history/elset-files.js';
import { eventLine } from '../../src/ssa/history/derive-files.js';
import { chainPairs, summarizeChain } from '../../src/ssa/history/chain.js';
import type { ChangesOut, ChangesTask } from '../../src/ssa/history/changes-worker.js';
import type { ChangeObject } from '../../src/ssa/events/types.js';

type Part = 'coverage' | 'changes';
interface Args { [k: string]: string | boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (!t.startsWith('--')) throw new Error(`unexpected argument ${t}`);
    const k = t.slice(2);
    const nx = argv[i + 1];
    if (nx === undefined || nx.startsWith('--')) a[k] = true; else { a[k] = nx; i++; }
  }
  return a;
}
const str = (a: Args, k: string): string => { const v = a[k]; if (typeof v !== 'string') throw new Error(`--${k} is required`); return v; };
const opt = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const num = (a: Args, k: string, d: number): number => { const v = opt(a, k); if (v === undefined) return d; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`--${k}: not a number`); return n; };

const markerPath = (out: string, part: Part, day: string): string => join(out, 'done', part, day.slice(0, 4), `${day}.json`);
function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const a = dayMs(from), b = dayMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) throw new Error(`bad range ${from}..${to}`);
  for (let t = a; t <= b; t += DAY_MS) out.push(isoDayOf(t));
  return out;
}
export function shardOf(days: string[], k: number, n: number): string[] {
  if (!(n >= 1 && k >= 0 && k < n)) throw new Error(`bad shard ${k}/${n}`);
  return days.filter((_, i) => i % n === k);
}

const rssMB = (): number => Math.round(process.resourceUsage().maxRSS / 1024);

// ------------------------------------------------------------------ chain check
function runChainCheck(a: Args): void {
  const dir = str(a, 'elsets');
  const years = (opt(a, 'years') ?? '1962,1970,1980,1990,2000,2010,2020,2025').split(',').map(Number);
  const sample = num(a, 'sample', 400), windowDays = num(a, 'window-days', 14), maxGap = num(a, 'max-gap-days', 5);
  const start = opt(a, 'start') ?? '06-01';
  const report: Record<string, unknown>[] = [];
  console.log('year  sets read  objects   pairs  failed  gap(med d)  dpos median km   p95 km   p99 km');
  for (const y of years) {
    const sets: Elset[] = [];
    const t0 = dayMs(`${y}-${start}`);
    for (let k = 0; k < windowDays; k++) sets.push(...readElsetDay(dir, isoDayOf(t0 + k * DAY_MS)));
    if (!sets.length) { console.log(`${y}  no element sets in ${y}-${start} + ${windowDays} d`); continue; }
    // a deterministic sample of objects (hash of the id), roughly `sample` of them
    const ids = [...new Set(sets.map((s) => s.noradId))];
    const keep = new Set(ids.filter((id) => ((id * 2654435761) >>> 0) % ids.length < sample));
    const chosen = sets.filter((s) => keep.has(s.noradId));
    const { pairs, failed } = chainPairs(chosen, maxGap);
    const s = summarizeChain(pairs, failed);
    const short = summarizeChain(pairs.filter((p) => p.gapDays <= 1), 0);
    console.log(`${y}  ${String(sets.length).padStart(9)} ${String(keep.size).padStart(8)} ${String(s.pairs).padStart(7)} ${String(s.failed).padStart(7)}  ${s.medianGapDays.toFixed(2).padStart(9)}  ${s.medianKm.toFixed(3).padStart(14)} ${s.p95Km.toFixed(2).padStart(8)} ${s.p99Km.toFixed(2).padStart(8)}   (gap <= 1 d: ${short.pairs} pairs, median ${short.medianKm.toFixed(3)} km, p95 ${short.p95Km.toFixed(2)} km)`);
    report.push({ year: y, sets: sets.length, objects: keep.size, ...s, gapLe1d: short });
  }
  const j = opt(a, 'json');
  if (j) writeFileSync(j, JSON.stringify(report, null, 1));
}

// ------------------------------------------------------------------ range build
interface DayStats { [k: string]: unknown }

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (a['check-chain']) { runChainCheck(a); return; }
  const elsets = str(a, 'elsets'), objectsFile = str(a, 'objects'), out = str(a, 'out');
  const from = str(a, 'from'), to = str(a, 'to');
  const parts = (opt(a, 'parts') ?? 'coverage,changes').split(',').map((s) => s.trim()) as Part[];
  for (const p of parts) if (p !== 'coverage' && p !== 'changes') throw new Error(`unknown part '${p}'`);
  const workers = Math.max(1, num(a, 'workers', cpus().length));
  const [sk, sn] = (opt(a, 'shard') ?? '0/1').split('/').map(Number) as [number, number];
  const force = a.force === true;
  const minObjects = num(a, 'min-objects', 1);
  const forcedWindow = opt(a, 'window-days') ? num(a, 'window-days', 30) : undefined;
  const stepMs = num(a, 'step-s', 10) * 1000;
  const era: readonly EraSettings[] = opt(a, 'era-file') ? validateEraTable(JSON.parse(readFileSync(str(a, 'era-file'), 'utf8')) as EraSettings[]) : ERA_TABLE;
  const settingsOf = (day: string): EraSettings => (forcedWindow ? { ...eraFor(day, era), windowDays: forcedWindow } : eraFor(day, era));

  const allDays = daysBetween(from, to);
  const days = shardOf(allDays, sk, sn);
  const todo = days.filter((d) => parts.some((p) => force || !existsSync(markerPath(out, p, d))));
  console.log(`range ${from}..${to}: ${allDays.length} days, shard ${sk}/${sn}: ${days.length} days, ${todo.length} to do (parts ${parts.join('+')}), ${workers} coverage workers`);
  if (!todo.length) return;

  const objects = loadObjects(objectsFile);
  console.log(`objects: ${objects.size}`);
  const cat = new FileCatalog(elsets, objects);
  let covPool: WorkerPool | null = null, chPool: WorkerPool | null = null;
  if (parts.includes('coverage')) { covPool = new WorkerPool(workers, 'coverage/worker'); await covPool.start({ kind: 'init' }); }
  if (parts.includes('changes')) { chPool = new WorkerPool(1, 'history/changes-worker'); await chPool.start({ kind: 'init' }); }

  const T0 = Date.now();
  let done = 0, failed = 0, lastLog = 0;
  const log = (final = false): void => {
    const el = (Date.now() - T0) / 1000;
    if (!final && Date.now() - lastLog < 15_000) return;
    lastLog = Date.now();
    const rate = done / (el / 3600);
    const eta = done ? ((todo.length - done) / rate) : NaN;
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${done}/${todo.length} days  ${Number.isFinite(rate) ? rate.toFixed(1) : '-'} days/h  ETA ${Number.isFinite(eta) ? eta.toFixed(2) + ' h' : '-'}  peak RSS ${rssMB()} MB${failed ? `  FAILED ${failed}` : ''}`);
  };

  try {
    for (const day of todo) {
      const need = (p: Part): boolean => parts.includes(p) && (force || !existsSync(markerPath(out, p, day)));
      const s = settingsOf(day);
      const t = Date.now();
      try {
        const prevDay = isoDayOf(dayMs(day) - DAY_MS);
        const prev: ChangeObject[] | null = need('changes') ? cat.asOf(prevDay, settingsOf(prevDay).windowDays) : null;
        const cur = cat.asOf(day, s.windowDays);
        const jobs: Promise<void>[] = [];

        if (need('coverage')) {
          jobs.push((async () => {
            const T = Date.now();
            if (cur.length < minObjects) {
              writeAtomic(markerPath(out, 'coverage', day), JSON.stringify({ status: 'skipped', reason: `no-catalog (${cur.length} objects)`, objects: cur.length }));
              return;
            }
            const built = await buildDay(day, dayMs(day), toOmmObjects(cur), { pool: covPool!, hourly: false, stepMs });
            writeDay(join(out, 'coverage'), built.manifest, built.files);
            const m = built.manifest;
            const st: DayStats = {
              status: 'done', objects: m.objects, unindexed: m.unindexed.length, skipped: m.skipped, windowDays: s.windowDays, wallS: +((Date.now() - T) / 1000).toFixed(1),
              bytes: Object.fromEntries(Object.entries(m.layers).map(([k, v]) => [k, v.bytes])),
            };
            writeAtomic(markerPath(out, 'coverage', day), JSON.stringify(st));
          })());
        }

        if (need('changes')) {
          jobs.push((async () => {
            const T = Date.now();
            const prevIds = new Set(prev!.map((o) => o.noradId));
            const firstSeen: Array<[number, string]> = [];
            for (const o of cur) if (!prevIds.has(o.noradId)) { const f = firstSeenOf(objects, o.noradId); if (f) firstSeen.push([o.noradId, f]); }
            const task: ChangesTask = { kind: 'changes', day, prev: prev!, cur, firstSeen, jumpDposKm: s.jumpDposKm, jumpDaKm: s.jumpDaKm, ...(a['skip-formation'] ? { skipFormation: true } : {}) };
            const r = (await chPool!.map<ChangesOut>([task]))[0]!;
            const text = r.rows.map((row) => JSON.stringify(eventLine(day, row))).join('\n');
            writeAtomic(join(out, 'events', day.slice(0, 4), `${day}.jsonl.gz`), gzipSync(text ? text + '\n' : ''));
            const st: DayStats = {
              status: 'done', kinds: r.kinds, perKind: r.perKind, prevObjects: prev!.length, curObjects: cur.length, windowDays: s.windowDays,
              ...(r.formationError ? { formationError: r.formationError } : {}), wallS: +((Date.now() - T) / 1000).toFixed(2), changeWallS: r.wallS,
            };
            writeAtomic(markerPath(out, 'changes', day), JSON.stringify(st));
          })());
        }
        await Promise.all(jobs);
        done++;
        if (done <= 3 || (Date.now() - t) > 60_000) console.log(`  ${day}: ${cur.length} objects, window ${s.windowDays} d, ${((Date.now() - t) / 1000).toFixed(1)} s`);
      } catch (err) {
        failed++;
        console.error(`  ${day}: FAILED ${(err as Error).stack ?? err}`);
      }
      log();
    }
  } finally {
    await covPool?.close();
    await chPool?.close();
  }
  log(true);
  console.log(`finished: ${done} days done, ${failed} failed, ${((Date.now() - T0) / 1000).toFixed(0)} s, peak RSS ${rssMB()} MB, element-set files read ${cat.filesRead} (${cat.rebuilds} rebuilds)`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-range.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

