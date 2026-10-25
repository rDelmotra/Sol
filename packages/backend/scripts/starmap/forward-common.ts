// ============================================================
// SPIKE — not production. Pieces shared by the S5 and S6 screeners (screen-forward.ts, screen-s6.ts) and their checks:
// output paths, the exclusion constants, recent-manoeuvre flags from the DB, and the batch's usable objects.
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { makeProp, type Prop } from './runs.js';
import { posAt, DB_URL, type CatFull } from './events.js';
import { causalCatalog, type CausalCatalog } from './forward-lib.js';

export const FORWARD_DIR = fileURLToPath(new URL('../../data/forward/', import.meta.url));
export const batchFile = (day: string, tag = '', ext = 'jsonl.gz') => `${FORWARD_DIR}batch-${day}${tag ? '-' + tag : ''}.${ext}`;
export const FENCED_IDS = new Set([54922]);
export const CA_KM = 5;
export const FORM_KM = 50;
export const FORM_FRAC = 0.5;
export const secs = (t: number) => +((Date.now() - t) / 1000).toFixed(2);

export async function recentJumps(t0: number): Promise<{ set: Set<number>; ok: boolean }> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 4000 });
  try {
    await c.connect();
    const r = await c.query("SELECT DISTINCT subjects[1] AS id FROM starmap.event WHERE kind = 'elements.jump' AND t_end <= to_timestamp($1 / 1000.0) AND t_end > to_timestamp($2 / 1000.0)", [t0, t0 - 7 * 86_400_000]);
    return { set: new Set((r.rows as Array<{ id: number }>).map((x) => x.id)), ok: true };
  } catch { return { set: new Set(), ok: false }; } finally { await c.end().catch(() => undefined); }
}

export interface BatchObjects { cc: CausalCatalog; objs: CatFull[]; props: Prop[]; fenced: number; unusable: number; garbage: number; sgp4Calls: number }
/** Usable objects of a batch: the S5 rule (fenced ids, unusable satrec, garbage orbit = radius outside 6340 km..1e6 km at start, middle or end). */
export function loadBatchObjects(day: string, t0: number, t1: number): BatchObjects {
  const cc = causalCatalog(day);
  const objs: CatFull[] = [], props: Prop[] = [];
  let fenced = 0, unusable = 0, garbage = 0, calls = 0;
  for (const o of cc.objs) {
    if (FENCED_IDS.has(o.noradId)) { fenced++; continue; }
    const p = makeProp(o.omm);
    if (!p) { unusable++; continue; }
    let bad = false;
    for (const t of [t0, (t0 + t1) / 2, t1]) { calls++; const r = posAt(p, t); if (!r) { bad = true; break; } const rad = Math.hypot(r[0], r[1], r[2]); if (rad < 6340 || rad > 1e6) { bad = true; break; } }
    if (bad) { garbage++; continue; }
    objs.push(o); props.push(p);
  }
  return { cc, objs, props, fenced, unusable, garbage, sgp4Calls: calls };
}

/** Write lines as concatenated gzip members (a batch can hold more text than one JS string can: 1M events). gunzip reads them as one stream. */
export function writeLines(file: string, lines: string[]): void {
  const parts: Buffer[] = [];
  for (let i = 0; i < lines.length; i += 20_000) parts.push(gzipSync(lines.slice(i, i + 20_000).join('\n') + '\n'));
  writeFileSync(file, Buffer.concat(parts));
}
/** Lines of a file written by writeLines (or a plain gzipped text file), without building one giant string. */
export function readLines(file: string): string[] {
  const buf = gunzipSync(readFileSync(file));
  const out: string[] = [];
  let a = 0;
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, a)) { if (i > a) out.push(buf.toString('utf8', a, i)); a = i + 1; }
  if (a < buf.length) out.push(buf.toString('utf8', a));
  return out;
}
