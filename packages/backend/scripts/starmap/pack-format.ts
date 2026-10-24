// ============================================================
// SPIKE — not production. Browser pack (P5): the row format shared by the Node builder and the browser worker.
// No Node imports here, so esbuild can bundle it for the page.
//
// An element-set row is one tab-separated line of text:
//   norad  EPOCH  MEAN_MOTION  ECCENTRICITY  INCLINATION  RA_OF_ASC_NODE  ARG_OF_PERICENTER  MEAN_ANOMALY  BSTAR  MEAN_MOTION_DOT  MEAN_MOTION_DDOT
// A live row adds   name  objectId  objectType  regime  countryCode.
// Numbers are kept as the exact decimal text of the source JSON number (String(n)), so Number(text) gives back
// the identical double and SGP4 in the browser and in Node start from bit-identical inputs.
// ============================================================

export const ELSET_COLS = 11;
export const LIVE_COLS = 16;
/** A history day holds, per object, the latest set with EPOCH >= (end of that day) - 30 d. */
export const HISTORY_SPAN_MS = 30 * 86_400_000;
export const DAY_MS = 86_400_000;

export interface ElsetRow {
  norad: number;
  epoch: string;
  /** MEAN_MOTION, ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, BSTAR, MEAN_MOTION_DOT, MEAN_MOTION_DDOT */
  n: string[];
  name?: string;
  objectId?: string;
  objectType?: string;
  regime?: string;
  country?: string;
}

const NUM_KEYS = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'] as const;

const clean = (s: unknown): string => String(s ?? '').replace(/[\t\r\n]+/g, ' ');

/** Row from a catalog record ({noradId, name, omm, objectType, regime, countryCode}). */
export function rowFromCatalog(o: { noradId: number; name?: string; omm: Record<string, unknown>; objectType?: string; regime?: string; countryCode?: string }, withMeta: boolean): ElsetRow {
  const r: ElsetRow = { norad: o.noradId, epoch: String(o.omm.EPOCH), n: NUM_KEYS.map((k) => String(o.omm[k])) };
  if (withMeta) {
    r.name = clean(o.name ?? o.omm.OBJECT_NAME); r.objectId = clean(o.omm.OBJECT_ID);
    r.objectType = clean(o.objectType); r.regime = clean(o.regime); r.country = clean(o.countryCode);
  }
  return r;
}

export function rowToLine(r: ElsetRow): string {
  const base = `${r.norad}\t${r.epoch}\t${r.n.join('\t')}`;
  return r.name === undefined ? base : `${base}\t${r.name}\t${r.objectId}\t${r.objectType}\t${r.regime}\t${r.country}`;
}

export function lineToRow(line: string): ElsetRow {
  const f = line.split('\t');
  const r: ElsetRow = { norad: Number(f[0]), epoch: f[1]!, n: f.slice(2, 11) };
  if (f.length >= LIVE_COLS) { r.name = f[11]; r.objectId = f[12]; r.objectType = f[13]; r.regime = f[14]; r.country = f[15]; }
  return r;
}

export function parseRows(text: string): ElsetRow[] {
  const out: ElsetRow[] = [];
  let p = 0;
  while (p < text.length) {
    let q = text.indexOf('\n', p);
    if (q < 0) q = text.length;
    if (q > p) out.push(lineToRow(text.slice(p, q)));
    p = q + 1;
  }
  return out;
}

export const rowsToText = (rows: ElsetRow[]): string => rows.map(rowToLine).join('\n') + (rows.length ? '\n' : '');

/** OMM-shaped object for satellite.js json2satrec. */
export function rowToOmm(r: ElsetRow): Record<string, unknown> {
  const o: Record<string, unknown> = { NORAD_CAT_ID: r.norad, EPOCH: r.epoch };
  for (let i = 0; i < NUM_KEYS.length; i++) o[NUM_KEYS[i]!] = Number(r.n[i]);
  return o;
}

export const epochMs = (epoch: string): number => Date.parse(epoch.endsWith('Z') ? epoch : epoch + 'Z');

/**
 * Rebuild the catalog of history day `dayStartMs` from all sets seen up to that day: per object the set with the
 * greatest EPOCH <= end of day and >= end of day - 30 d. The builder checks this rule against every real day file.
 */
export function reconstructDay(sets: ElsetRow[], dayStartMs: number): ElsetRow[] {
  const hi = dayStartMs + DAY_MS, lo = hi - HISTORY_SPAN_MS;
  const best = new Map<number, { r: ElsetRow; t: number }>();
  for (const r of sets) {
    const t = epochMs(r.epoch);
    if (t > hi || t < lo) continue;
    const b = best.get(r.norad);
    if (!b || t > b.t) best.set(r.norad, { r, t });
  }
  return [...best.values()].map((b) => b.r).sort((a, b) => a.norad - b.norad);
}

/** Apply a live delta: rows replace/insert by norad, `removed` norads are dropped. Result sorted by norad. */
export function applyLiveDelta(base: ElsetRow[], delta: ElsetRow[], removed: number[]): ElsetRow[] {
  const m = new Map<number, ElsetRow>();
  for (const r of base) m.set(r.norad, r);
  for (const x of removed) m.delete(x);
  for (const r of delta) m.set(r.norad, r);
  return [...m.values()].sort((a, b) => a.norad - b.norad);
}
