// ============================================================
// The history backfill on disk as the app reads it (SSA_HISTORY_DIR, see config.ts historyDir):
//
//   <root>/elsets/YYYY/<day>.jsonl.gz   per-day element sets          (elset-files.ts)
//   <root>/objects.jsonl.gz             object metadata               (elset-files.ts loadObjects)
//   <root>/coverage/<day>/...           star-map coverage files       (coverage/store.ts; the passes API falls back to them)
//   <root>/events/YYYY/<day>.jsonl.gz   change events                 (imported into ssa_event by scripts/history/import-events.ts)
//   <root>/cache/catalog/<day>-<sig>.json.gz   (written here) the gzipped /api/history/catalog answer of a day
//
// HistoryStore answers "the catalog as of the END of day D" with exactly the rule of the build (catalog-files.ts FileCatalog + the
// era's staleness window + the era's propagator policy), so the sets and the objects equal those of that day's coverage manifest.
// One store per root (getHistoryStore); the rolling FileCatalog makes a replay (increasing days) read one day file per step, a jump
// back or far ahead re-reads the era window (30-93 files).
// ============================================================
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { HistoryCatalog, HistoryCatalogObject, HistoryOmm, HistoryRange } from '@orbitwatch/contracts';
import type { ChangeObject } from '../events/types.js';
import { listDays, readManifest } from '../coverage/store.js';
import { FileCatalog } from './catalog-files.js';
import { ERA_TABLE, eraFor, validateEraTable, type EraSettings } from './era.js';
import { historyPathsFrom, type HistoryPaths } from '../config.js';
import { readFileSync as readText } from 'node:fs';
import { propagatorFor } from './propagator-policy.js';
import { loadObjects, type ObjectMeta } from './elset-files.js';

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isRealDay = (s: string): boolean => { if (!DAY_RE.test(s)) return false; const t = Date.parse(s + 'T00:00:00Z'); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s; };

const CATALOG_LRU = 24; // gzipped answers kept in memory (~1.3 MB each for a 13k-object day)
const DAYCAT_LRU = 3; // parsed catalogs kept for the pass refine
const EXTENT_TTL_MS = 60_000;
const FORMAT = 1; // part of the disk-cache signature: bump when the answer's shape changes

export interface CatalogBuild { gz: Buffer; rawBytes: number; /** object count; absent when read from the disk cache */ objects?: number; ms: number; source: 'memory' | 'disk' | 'built' }

const yearDirs = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((n) => /^\d{4}$/.test(n)).sort() : []);
function dayFiles(dir: string): string[] {
  const out: string[] = [];
  for (const y of yearDirs(dir)) for (const f of readdirSync(join(dir, y))) { const m = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(f); if (m) out.push(m[1]!); }
  return out.sort();
}

export class HistoryStore {
  readonly elsetsDir: string;
  readonly objectsFile: string;
  readonly coverageDir: string;
  readonly eventsDir: string;
  private readonly cacheDir: string;
  private readonly eraFile: string | null;
  private era: { sig: string; table: readonly EraSettings[] } | null = null;
  private objs: { sig: string; map: Map<number, ObjectMeta> } | null = null;
  private fc: FileCatalog | null = null;
  private readonly dayCats = new Map<string, ChangeObject[]>();
  private readonly gzLru = new Map<string, CatalogBuild>();
  private ext: { at: number; v: HistoryRange; elsetFirst: string | null; elsetLast: string | null } | null = null;
  /** write the gz answers next to the data (<cache root>/cache/catalog); off in tests that must not touch the data */
  diskCache = true;

  constructor(readonly paths: HistoryPaths) {
    this.elsetsDir = paths.elsets ?? join(paths.coverage ?? '.', '..', 'elsets-none');
    this.objectsFile = paths.objects ?? join(paths.root ?? '.', 'objects.jsonl.gz');
    this.coverageDir = paths.coverage ?? join(paths.root ?? '.', 'coverage-none');
    this.eventsDir = paths.events ?? join(paths.root ?? '.', 'events-none');
    this.eraFile = paths.eraFile;
    // the gz cache sits next to the data when there is a root, else next to the element sets
    this.cacheDir = join(paths.root ?? join(this.elsetsDir, '..'), 'cache', 'catalog');
  }

  /** Era table in force: the era file (SSA_HISTORY_ERA_FILE / <root>/era.json, build-range --era-file format) when present, else the built-in. */
  eraTable(): readonly EraSettings[] {
    let sig = 'builtin';
    if (this.eraFile) { try { const st = statSync(this.eraFile); sig = `${st.mtimeMs}:${st.size}`; } catch { /* no era file */ } }
    if (!this.era || this.era.sig !== sig) {
      const table = sig === 'builtin' ? ERA_TABLE : validateEraTable(JSON.parse(readText(this.eraFile!, 'utf8')) as EraSettings[]);
      this.era = { sig, table };
      this.fc = null; this.dayCats.clear(); this.gzLru.clear();
    }
    return this.era.table;
  }

  /** The element-set directory or the coverage directory exists. */
  available(): boolean { return existsSync(this.elsetsDir) || existsSync(this.coverageDir); }

  /** Object metadata by NORAD id (re-read when objects.jsonl.gz changes). Empty when the file is missing. */
  objects(): Map<number, ObjectMeta> {
    let sig = 'none';
    try { const st = statSync(this.objectsFile); sig = `${st.mtimeMs}:${st.size}`; } catch { /* no objects file */ }
    if (!this.objs || this.objs.sig !== sig) {
      this.objs = { sig, map: sig === 'none' ? new Map() : loadObjects(this.objectsFile) };
      this.fc = null; this.dayCats.clear(); this.gzLru.clear();
    }
    return this.objs.map;
  }

  /** The catalog of `day` as the build saw it (ChangeObject, ascending NORAD id, era window and propagators applied). The array is shared: do not mutate. */
  dayCatalog(day: string): ChangeObject[] {
    const objects = this.objects();
    const hit = this.dayCats.get(day);
    if (hit) { this.dayCats.delete(day); this.dayCats.set(day, hit); return hit; }
    const era = eraFor(day, this.eraTable());
    this.fc ??= new FileCatalog(this.elsetsDir, objects);
    // the model of each set: the day's coverage manifest when there is one (what the build used), else the era's policy
    const sgpList = readManifest(this.coverageDir, day)?.propagators?.sgp;
    const sgp = sgpList ? new Set(sgpList) : null;
    const cat = this.fc.asOf(day, era.windowDays).map((o) => ((sgp ? sgp.has(o.noradId) : propagatorFor(o.omm, era.sgp)) ? { ...o, propagator: 'sgp' as const } : o));
    this.dayCats.set(day, cat);
    while (this.dayCats.size > DAYCAT_LRU) this.dayCats.delete(this.dayCats.keys().next().value as string);
    return cat;
  }

  /** The answer of GET /api/history/catalog for `day` (gzipped JSON): memory, else the disk cache, else built. */
  catalogGz(day: string): CatalogBuild {
    const t0 = performance.now();
    const mem = this.gzLru.get(day);
    if (mem) { this.gzLru.delete(day); this.gzLru.set(day, mem); return { ...mem, source: 'memory', ms: +(performance.now() - t0).toFixed(1) }; }
    const sig = this.signature(day);
    const file = join(this.cacheDir, `${day}-${sig}.json.gz`);
    let res: CatalogBuild | null = null;
    if (this.diskCache && existsSync(file)) {
      try {
        const gz = readFileSync(file);
        res = { gz, rawBytes: gz.readUInt32LE(gz.length - 4), ms: 0, source: 'disk' }; // gzip trailer: ISIZE (size mod 2^32)
      } catch { res = null; }
    }
    if (!res) {
      const body = this.catalogBody(day);
      const raw = Buffer.from(JSON.stringify(body));
      const gz = gzipSync(raw, { level: 6 });
      res = { gz, rawBytes: raw.length, objects: body.objects.length, ms: 0, source: 'built' };
      if (this.diskCache) this.writeDisk(day, sig, file, gz);
    }
    res.ms = +(performance.now() - t0).toFixed(1);
    this.gzLru.set(day, res);
    while (this.gzLru.size > CATALOG_LRU) this.gzLru.delete(this.gzLru.keys().next().value as string);
    return res;
  }

  /** The (uncompressed) answer object. */
  catalogBody(day: string): HistoryCatalog {
    const objects = this.objects();
    const era = eraFor(day, this.eraTable());
    const acc = readManifest(this.coverageDir, day)?.accuracy ?? era.accuracy;
    const list: HistoryCatalogObject[] = this.dayCatalog(day).map((o) => {
      const m = objects.get(o.noradId);
      return {
        noradId: o.noradId, name: o.name, objectType: m?.objectType ?? 'unknown',
        intlDesignator: m?.intlDesignator ?? (typeof o.omm.OBJECT_ID === 'string' ? o.omm.OBJECT_ID : null),
        launchDate: m?.launchDate ?? null, decayDate: m?.decayDate ?? null,
        propagator: o.propagator === 'sgp' ? 'sgp' : 'sgp4', omm: o.omm as unknown as HistoryOmm,
      };
    });
    return { day, accuracy: acc ? { medianKm: acc.medianKm, p95Km: acc.p95Km } : null, objects: list };
  }

  private signature(day: string): string {
    const h = createHash('sha1');
    h.update(String(FORMAT));
    this.eraTable();
    h.update(this.era!.sig);
    for (const f of [this.objectsFile, join(this.elsetsDir, day.slice(0, 4), `${day}.jsonl.gz`)]) {
      try { const st = statSync(f); h.update(`${f}:${st.mtimeMs}:${st.size}`); } catch { h.update(`${f}:none`); }
    }
    return h.digest('hex').slice(0, 10);
  }

  private writeDisk(day: string, sig: string, file: string, gz: Buffer): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      for (const n of readdirSync(this.cacheDir)) if (n.startsWith(`${day}-`) && n !== `${day}-${sig}.json.gz`) rmSync(join(this.cacheDir, n), { force: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, gz);
      renameSync(tmp, file);
    } catch { /* read-only volume: serve from memory only */ }
  }

  /** Days and extents (cached for a minute). Coverage days define first / last when there are any, else the element-set days. */
  range(now = Date.now()): HistoryRange {
    if (this.ext && now - this.ext.at < EXTENT_TTL_MS) return this.ext.v;
    const cov = listDays(this.coverageDir);
    const els = dayFiles(this.elsetsDir);
    const ev = dayFiles(this.eventsDir);
    const days = cov.length ? cov : els;
    const v: HistoryRange = {
      firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null, days: days.length,
      eventsFirstDay: ev[0] ?? null, eventsLastDay: ev[ev.length - 1] ?? null, hasCoverage: cov.length > 0,
    };
    this.ext = { at: now, v, elsetFirst: els[0] ?? null, elsetLast: els[els.length - 1] ?? null };
    return v;
  }

  /** First / last day the catalog endpoint answers (the element-set days, else the range). */
  catalogExtent(): { first: string | null; last: string | null } {
    const r = this.range();
    const e = this.ext!;
    const firsts = [r.firstDay, e.elsetFirst].filter((x): x is string => !!x).sort();
    const lasts = [r.lastDay, e.elsetLast].filter((x): x is string => !!x).sort();
    return { first: firsts[0] ?? null, last: lasts[lasts.length - 1] ?? null };
  }

  clear(): void { this.objs = null; this.fc = null; this.dayCats.clear(); this.gzLru.clear(); this.ext = null; }
}

const stores = new Map<string, HistoryStore>();
/** The store for a root directory (environment overrides apply) or for explicit paths. One per distinct configuration. */
export function getHistoryStore(src: string | HistoryPaths): HistoryStore {
  const paths = typeof src === 'string' ? historyPathsFrom(src) : src;
  if (!paths) throw new Error('no history paths configured');
  const key = JSON.stringify(paths);
  let s = stores.get(key);
  if (!s) { s = new HistoryStore(paths); stores.set(key, s); }
  return s;
}
export function clearHistoryStores(): void { stores.clear(); }
