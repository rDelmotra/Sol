// ============================================================
// Coverage files on a volume directory (SSA_COVERAGE_DIR). One directory per UTC day:
//
//   <dir>/<day>/manifest.json   codec version, day, object index -> NORAD table, unindexed (row-capped) objects, build stats, layers
//   <dir>/<day>/day.o3.bin      daily layer, order 3   (kept forever)
//   <dir>/<day>/day.o4.bin      daily layer, order 4   (kept forever)
//   <dir>/<day>/hour.o4.bin     hourly layer, order 4  (rolling window, pruned by the job)
//
// A day is written into a temporary directory and swapped in with renames (tmp + rename), so a reader sees the old day or the new
// day, never half of each. The day exists for queries iff its manifest exists.
// ============================================================
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLayer, type Layer } from './codec.js';
import { CODEC_VERSION } from './codec.js';
import { LAYERS, layerName, type LayerId } from './consts.js';

export interface LayerInfo { file: string; bytes: number; lists: number; pairs: number; /** shell index range present in the data (order of the layer) */ nkLo: number; nkHi: number }
export interface Manifest {
  version: number;
  day: string;
  dayStartMs: number;
  builtAt: string;
  objects: number;
  /** object index -> NORAD id */
  norad: number[];
  /** NORAD ids the build could not index (over the row cap): ALWAYS candidates */
  unindexed: number[];
  /** objects not built, by reason (fenced, bad-elements, ...) */
  skipped: Record<string, number>;
  layers: Record<string, LayerInfo>;
  build: Record<string, number>;
}

export const dayDir = (dir: string, day: string): string => join(dir, day);
export const manifestPath = (dir: string, day: string): string => join(dir, day, 'manifest.json');
export const layerPath = (dir: string, day: string, l: LayerId): string => join(dir, day, `${layerName(l)}.bin`);

export function hasDay(dir: string, day: string): boolean { return existsSync(manifestPath(dir, day)); }

/** Write a built day atomically (replacing an earlier build of the same day). */
export function writeDay(dir: string, manifest: Manifest, files: Map<string, Uint8Array>): void {
  mkdirSync(dir, { recursive: true });
  const final = dayDir(dir, manifest.day);
  const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
  const old = `${final}.old-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  try {
    for (const [name, bytes] of files) writeFileSync(join(tmp, name), bytes);
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest)); // last: the day exists once its manifest does
    if (existsSync(final)) renameSync(final, old);
    renameSync(tmp, final);
    rmSync(old, { recursive: true, force: true });
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(old) && !existsSync(final)) renameSync(old, final);
    throw err;
  }
}

const manifests = new Map<string, { sig: string; m: Manifest }>();
export function readManifest(dir: string, day: string): Manifest | null {
  const p = manifestPath(dir, day);
  let st;
  try { st = statSync(p); } catch { return null; }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = manifests.get(p);
  if (hit && hit.sig === sig) return hit.m;
  const m = JSON.parse(readFileSync(p, 'utf8')) as Manifest;
  if (m.version !== CODEC_VERSION) throw new Error(`coverage manifest ${day}: unsupported version ${m.version}`);
  manifests.set(p, { sig, m });
  return m;
}

export function hasLayer(dir: string, day: string, l: LayerId): boolean { return existsSync(layerPath(dir, day, l)); }

// A parsed hourly layer is ~70 MB of bytes plus ~20 MB of directory arrays: keep only a few.
const layerCache = new Map<string, Layer>();
const LAYER_CACHE_MAX = 3;
export function openLayer(dir: string, day: string, l: LayerId): Layer {
  const p = layerPath(dir, day, l);
  const hit = layerCache.get(p);
  if (hit) { layerCache.delete(p); layerCache.set(p, hit); return hit; }
  const buf = readFileSync(p);
  const layer = readLayer(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
  layerCache.set(p, layer);
  while (layerCache.size > LAYER_CACHE_MAX) layerCache.delete(layerCache.keys().next().value as string);
  return layer;
}
export function clearStoreCaches(): void { layerCache.clear(); manifests.clear(); }

/** Days (YYYY-MM-DD) that have a manifest, ascending. */
export function listDays(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && existsSync(manifestPath(dir, n))).sort();
}

/**
 * Retention: the hourly layer of every day older than `keepDays` before `todayMs` is deleted (the manifest is rewritten without it,
 * atomically). Daily layers are kept forever. Returns the days pruned. Stray tmp / old directories of crashed writes are removed too.
 */
export function pruneHourly(dir: string, keepDays: number, todayMs: number): string[] {
  const pruned: string[] = [];
  if (!existsSync(dir)) return pruned;
  const cutoff = new Date(todayMs - keepDays * 86_400_000).toISOString().slice(0, 10);
  for (const n of readdirSync(dir)) if (/\.(tmp|old)-\d+-\d+$/.test(n)) {
    // a writer of this very moment would be < a minute old; anything older is debris
    const ts = Number(n.slice(n.lastIndexOf('-') + 1));
    if (Number.isFinite(ts) && Date.now() - ts > 3_600_000) rmSync(join(dir, n), { recursive: true, force: true });
  }
  for (const day of listDays(dir)) {
    if (day >= cutoff) continue;
    const hour = layerPath(dir, day, { gran: 'hour', order: 4 });
    if (!existsSync(hour)) continue;
    const m = readManifest(dir, day)!;
    delete m.layers[layerName({ gran: 'hour', order: 4 })];
    const tmp = manifestPath(dir, day) + `.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(m));
    renameSync(tmp, manifestPath(dir, day));
    rmSync(hour, { force: true });
    layerCache.delete(hour);
    manifests.delete(manifestPath(dir, day));
    pruned.push(day);
  }
  return pruned;
}

export { LAYERS };
