// ============================================================
// History backfill, pre-1980: merge the Space-Track mirror's per-day element sets (convert.py) with McDowell's archive
// (convert-mcdowell.py) and drop outliers; or compare sources / variants with the chain check.
//
//   tsx merge-history.ts --merge --mirror DIR --jcm DIR --objects FILE --out DIR [--to 1979-12-31] [--rule matched|available|union]
//                        [--jcm-last-year 1972] [--filter-k 1] [--max-gap-days 5] [--link] [--force]
//   tsx merge-history.ts --compare --sources mirror=DIR,jcm=DIR[,label=DIR...] [--ids-from FILE] [--years 1959-1985] [--max-gap-days 5]
//                        [--propagator era|sgp4] [--filter-k K] [--json FILE]
//
// --merge writes OUT/elsets/YYYY/YYYY-MM-DD.jsonl.gz (same layout as convert.py) and OUT/objects.jsonl.gz:
//   * days up to --to (default 1979-12-31): per object and calendar year up to --jcm-last-year (default 1972) McDowell's version of the
//     mirror's sets where McDowell has the object-year (rule 'matched', merge.ts), else (and 1973-1979) the mirror's sets; then the outlier filter (k x the year's chain p95 of the merged
//     sets, measured in this run; default k = 1; --filter-k 0 = off). Lines are the sources'
//     own JSON objects (McDowell's carry HIST_SRC 'jcm' + provenance), ordered by (NORAD id, epoch).
//   * days after --to: the mirror's day files unchanged (hard links with --link, else byte copies) -> 1980+ outputs are byte-identical.
//   * objects.jsonl.gz: the mirror's objects file; objects only McDowell has are appended (name 'NORAD n', type unknown); for objects in
//     both, firstEpoch / lastEpoch / nSets are recomputed only when the change stays before the cut (an object first seen after the cut
//     keeps its line byte-identical; counted 'firstEpochKept').
//   Restartable per year (OUT/.work/merge-YYYY.json markers); --force redoes.
// --compare: chain check (set propagated to the next set of the same object, next set <= max-gap-days, and <= 1 d) per year and
//   source, restricted to the objects in --ids-from (an objects.jsonl.gz, e.g. McDowell's: the downloaded sample) or to the objects
//   every source has. Propagation: the era policy per set (propagator-policy.ts, with the per-set source metadata).
// ============================================================
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { eraFor, ERA_TABLE } from '../../src/ssa/history/era.js';
import { isoDayOf } from '../../src/ssa/history/catalog-files.js';
import { readElsetDay, elsetDayPath, type Elset, type ObjectMeta } from '../../src/ssa/history/elset-files.js';
import { chainPairs, quantile, summarizeChain } from '../../src/ssa/history/chain.js';
import { propagatorFor } from '../../src/ssa/history/propagator-policy.js';
import { filterOutliers, mergeSources, type KindOf, type MergeRule } from '../../src/ssa/history/merge.js';

interface Args { [k: string]: string | boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (!t.startsWith('--')) throw new Error(`unexpected argument ${t}`);
    const nx = argv[i + 1];
    if (nx === undefined || nx.startsWith('--')) a[t.slice(2)] = true; else { a[t.slice(2)] = nx; i++; }
  }
  return a;
}
const str = (a: Args, k: string): string => { const v = a[k]; if (typeof v !== 'string') throw new Error(`--${k} is required`); return v; };
const opt = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const num = (a: Args, k: string, d: number): number => { const v = opt(a, k); if (v === undefined) return d; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`--${k}: not a number`); return n; };
const DAY = 86_400_000;

function parseYears(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [x, y] = part.split('-').map(Number) as [number, number | undefined];
    for (let v = x; v <= (y ?? x); v++) out.push(v);
  }
  return out;
}

function daysOfYear(y: number): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += DAY) out.push(isoDayOf(t));
  return out;
}

/** All sets of calendar year y in a per-day tree, optionally only some objects. */
function readYear(dir: string, y: number, ids?: ReadonlySet<number>): Elset[] {
  const out: Elset[] = [];
  for (const d of daysOfYear(y)) for (const s of readElsetDay(dir, d)) if (!ids || ids.has(s.noradId)) out.push(s);
  return out;
}

const readGzLines = (file: string): string[] => (file.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file)).toString('utf8').split('\n').filter((l) => l.length > 0);

function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** The era propagation model per set (SGP for B* = 0 sets where the era says so; source metadata first, see propagator-policy.ts). */
const eraKind = (era = ERA_TABLE): KindOf => (s: Elset) => propagatorFor(s.omm, eraFor(isoDayOf(s.epochMs), era).sgp);

/** Per-year chain p95 (km) of a set of sets (pairs <= maxGap days); NaN without pairs. */
function yearP95(sets: readonly Elset[], maxGap: number, kindOf: KindOf): number {
  const { pairs } = chainPairs(sets, maxGap, kindOf);
  const d = pairs.map((p) => p.dposKm).sort((x, y) => x - y);
  return quantile(d, 0.95);
}

// ------------------------------------------------------------------ --compare
function runCompare(a: Args): void {
  const sources = str(a, 'sources').split(',').map((kv) => { const i = kv.indexOf('='); return { label: kv.slice(0, i), dir: kv.slice(i + 1) }; });
  const years = parseYears(opt(a, 'years') ?? '1959-1985');
  const maxGap = num(a, 'max-gap-days', 5);
  const k = num(a, 'filter-k', 0);
  const kindOf: KindOf | undefined = opt(a, 'propagator') === 'sgp4' ? undefined : eraKind();
  const idsFile = opt(a, 'ids-from');
  const ids = idsFile ? new Set(readGzLines(idsFile).map((l) => (JSON.parse(l) as ObjectMeta).noradId)) : undefined;
  const report: Record<string, unknown>[] = [];
  console.log(`chain check, next set <= ${maxGap} d (and <= 1 d); objects: ${ids ? `${ids.size} from ${idsFile}` : 'all'}; propagation ${kindOf ? 'era policy' : 'SGP4'}${k ? `; outlier filter k = ${k}` : ''}`);
  console.log(`year  ${sources.map((s) => `${s.label.padEnd(10)}  pairs  med km   p95 km |  <=1d: pairs med p95`).join('  ||  ')}`);
  for (const y of years) {
    const row: Record<string, unknown> = { year: y };
    const cells: string[] = [];
    for (const s of sources) {
      let sets = readYear(s.dir, y, ids);
      let dropped = 0;
      if (k > 0 && sets.length) {
        const p95 = yearP95(sets, maxGap, kindOf ?? (() => undefined));
        const r = filterOutliers(sets, () => k * p95, maxGap, kindOf);
        dropped = r.dropped.length;
        sets = r.kept;
      }
      const { pairs, failed } = chainPairs(sets, maxGap, kindOf);
      const all = summarizeChain(pairs, failed), d1 = summarizeChain(pairs.filter((p) => p.gapDays <= 1), 0);
      row[s.label] = { sets: sets.length, dropped, ...all, gapLe1d: d1 };
      const f = (v: number): string => (Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : '-');
      cells.push(`${s.label.padEnd(10)} ${String(all.pairs).padStart(6)} ${f(all.medianKm).padStart(7)} ${f(all.p95Km).padStart(8)} | ${String(d1.pairs).padStart(5)} ${f(d1.medianKm).padStart(5)} ${f(d1.p95Km).padStart(6)}${k ? ` (-${dropped})` : ''}`);
    }
    console.log(`${y}  ${cells.join('  ||  ')}`);
    report.push(row);
  }
  const j = opt(a, 'json');
  if (j) writeFileSync(j, JSON.stringify(report, null, 1));
}

// ------------------------------------------------------------------ --merge
function runMerge(a: Args): void {
  const mirror = str(a, 'mirror'), jcm = str(a, 'jcm'), out = str(a, 'out'), objectsFile = str(a, 'objects');
  const to = opt(a, 'to') ?? '1979-12-31';
  const cutYear = Number(to.slice(0, 4)) + 1;
  if (to.slice(5) !== '12-31') throw new Error('--to must be a 31 December (the merge works per calendar year)');
  const rule = (opt(a, 'rule') ?? 'matched') as MergeRule;
  if (!['matched', 'available', 'union'].includes(rule)) throw new Error('--rule must be matched, available or union');
  const k = num(a, 'filter-k', 1), maxGap = num(a, 'max-gap-days', 5);
  const force = a.force === true, link = a.link === true;
  // McDowell's sets are used up to this year: from 1973 they are the mirror's NORAD sets minus some (no Brouwer sets, no cross-tag
  // corrections in the sample) and measured slightly worse (1973 median 8.0 vs 7.9 km, p95 40 vs 37; 1974 8.4/36 vs 8.3/33)
  const jcmLast = num(a, 'jcm-last-year', 1972);
  const kindOf = eraKind();
  const outE = join(out, 'elsets');
  const yearsOf = (dir: string): number[] => (existsSync(dir) ? readdirSync(dir).filter((d) => /^\d{4}$/.test(d)).map(Number).sort((x, y) => x - y) : []);
  const myears = yearsOf(mirror), jyears = yearsOf(jcm);
  const firstYear = Math.min(...[...myears, ...jyears].filter((y) => y < cutYear));
  const T0 = Date.now();
  const firstSeen = new Map<number, string>(), lastSeen = new Map<number, string>(), nSets = new Map<number, number>();
  const summary: Record<string, unknown>[] = [];
  for (let y = firstYear; y < cutYear; y++) {
    const marker = join(out, '.work', `merge-${y}.json`);
    let st: Record<string, unknown>;
    if (!force && existsSync(marker)) {
      st = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
    } else {
      const m = readYear(mirror, y), j = y <= jcmLast ? readYear(jcm, y) : [];
      const merged = mergeSources(m, j, { cutYear, rule });
      let sets = merged.sets, p95 = NaN, dropped: Elset[] = [];
      if (k > 0 && sets.length) {
        p95 = yearP95(sets, maxGap, kindOf);
        const r = filterOutliers(sets, () => k * p95, maxGap, kindOf);
        sets = r.kept; dropped = r.dropped;
      }
      rmSync(join(outE, String(y)), { recursive: true, force: true }); // a recomputed year never keeps day files of an earlier run
      const perDay = new Map<string, Elset[]>();
      for (const s of sets) { const d = isoDayOf(s.epochMs); (perDay.get(d) ?? perDay.set(d, []).get(d)!).push(s); }
      for (const d of daysOfYear(y)) {
        const list = perDay.get(d);
        const p = elsetDayPath(outE, d);
        if (!list) continue;
        list.sort((x, z) => x.noradId - z.noradId || x.epochMs - z.epochMs);
        writeAtomic(p, gzipSync(list.map((s) => JSON.stringify(s.omm)).join('\n') + '\n'));
      }
      const objs: Record<number, [string, string, number]> = {};
      for (const s of sets) {
        const e = String(s.omm.EPOCH), o = objs[s.noradId];
        objs[s.noradId] = o ? [e < o[0] ? e : o[0], e > o[1] ? e : o[1], o[2] + 1] : [e, e, 1];
      }
      st = { year: y, mirrorIn: m.length, jcmIn: j.length, ...merged.stats, out: sets.length, dropped: dropped.length, p95Km: p95, filterK: k, rule, jcmLastYear: jcmLast, objs };
      writeAtomic(marker, JSON.stringify(st));
      console.log(`${y}: mirror ${m.length}, jcm ${j.length} -> ${merged.sets.length} (object-years from jcm ${merged.stats.fromJcm}, mirror ${merged.stats.fromMirror}); outlier filter (k ${k} x p95 ${Number.isFinite(p95) ? p95.toFixed(1) : '-'} km) dropped ${dropped.length} -> ${sets.length}  [${((Date.now() - T0) / 1000).toFixed(0)} s]`);
    }
    for (const [id, v] of Object.entries(st.objs as Record<string, [string, string, number]>)) {
      const n = Number(id);
      if (!firstSeen.has(n) || v[0] < firstSeen.get(n)!) firstSeen.set(n, v[0]);
      if (!lastSeen.has(n) || v[1] > lastSeen.get(n)!) lastSeen.set(n, v[1]);
      nSets.set(n, (nSets.get(n) ?? 0) + v[2]);
    }
    const { objs: _o, ...rest } = st;
    summary.push(rest);
  }
  // days after the cut: the mirror's files unchanged
  let linked = 0;
  for (const y of myears.filter((v) => v >= cutYear)) {
    const src = join(mirror, String(y)), dst = join(outE, String(y));
    mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(src)) {
      if (!f.endsWith('.jsonl.gz')) continue;
      const d = join(dst, f);
      if (existsSync(d)) continue;
      if (link) { try { linkSync(join(src, f), d); linked++; continue; } catch { /* other filesystem: copy */ } }
      copyFileSync(join(src, f), d); linked++;
    }
  }
  // objects: the mirror's lines; pre-cut statistics recomputed where they stay before the cut
  const mirrorPreCut = scanMirrorPreCut(mirror, cutYear);
  const cutIso = `${cutYear}-01-01`;
  let changed = 0, kept = 0, added = 0;
  const lines: string[] = [];
  const seen = new Set<number>();
  for (const l of readGzLines(objectsFile)) {
    const o = JSON.parse(l) as ObjectMeta;
    seen.add(o.noradId);
    const f = firstSeen.get(o.noradId);
    if (f === undefined) { lines.push(l); continue; }
    const oldFirst = o.firstEpoch ?? null;
    if (oldFirst !== null && oldFirst >= cutIso) { lines.push(l); kept++; continue; }  // first seen after the cut: keep byte-identical
    const postCut = Math.max(0, (o.nSets ?? 0) - (mirrorPreCut.get(o.noradId) ?? 0));
    const nObj: ObjectMeta = { ...o, firstEpoch: f, lastEpoch: o.lastEpoch && o.lastEpoch >= cutIso ? o.lastEpoch : lastSeen.get(o.noradId)!, nSets: nSets.get(o.noradId)! + postCut };
    const nl = JSON.stringify(nObj);
    if (nl !== l) changed++;
    lines.push(nl);
  }
  for (const [id, f] of firstSeen) {
    if (seen.has(id)) continue;
    lines.push(JSON.stringify({ noradId: id, name: `NORAD ${id}`, objectType: 'unknown', rcsSize: null, launchDate: null, decayDate: null, intlDesignator: null, owner: null, firstEpoch: f, lastEpoch: lastSeen.get(id), nSets: nSets.get(id) }));
    added++;
  }
  writeAtomic(join(out, 'objects.jsonl.gz'), gzipSync(lines.join('\n') + '\n'));
  writeAtomic(join(out, 'merge-summary.json'), JSON.stringify({ to, rule, filterK: k, maxGapDays: maxGap, years: summary, objects: { changed, firstEpochKept: kept, added }, postCutDayFiles: linked }, null, 1));
  console.log(`objects: ${changed} lines updated, ${kept} kept (first seen after the cut), ${added} added; ${linked} post-cut day files ${link ? 'linked/copied' : 'copied'}; ${((Date.now() - T0) / 1000).toFixed(0)} s`);
}

/** The mirror's set count per object before the cut (one scan of its pre-cut day files): nSets of the merged objects file = merged
 *  pre-cut sets + the mirror's own post-cut count (objects file nSets minus this). */
function scanMirrorPreCut(mirror: string, cutYear: number): Map<number, number> {
  const mirrorPreCut = new Map<number, number>();
  if (!existsSync(mirror)) return mirrorPreCut;
  for (const yd of readdirSync(mirror).filter((d) => /^\d{4}$/.test(d) && Number(d) < cutYear)) {
    for (const f of readdirSync(join(mirror, yd))) {
      if (!f.endsWith('.jsonl.gz')) continue;
      for (const l of readGzLines(join(mirror, yd, f))) {
        const id = Number((JSON.parse(l) as { NORAD_CAT_ID: unknown }).NORAD_CAT_ID);
        mirrorPreCut.set(id, (mirrorPreCut.get(id) ?? 0) + 1);
      }
    }
  }
  return mirrorPreCut;
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  if (a.compare) { runCompare(a); return; }
  if (a.merge) { runMerge(a); return; }
  throw new Error('give --merge or --compare');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('merge-history.ts')) main();
