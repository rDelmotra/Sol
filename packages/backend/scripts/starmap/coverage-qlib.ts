// ============================================================
// SPIKE — not production. Shared pieces of the Layer 2 query path (moved out of coverage-query.ts so that
// ask.ts can use exactly the same merge / window / unindexed-object logic; no behaviour change).
// ============================================================
import { readFileSync } from 'node:fs';
import { COVERAGE_DIR, DAY_MS } from './coverage-lib.js';
import { readCoverage, findCell, forEachId, type CoverageDay } from './coverage-codec.js';

const secs = (t0: number) => (performance.now() - t0) / 1000;

export function readDay(day: string, gran: string): CoverageDay {
  return readCoverage(new Uint8Array(readFileSync(`${COVERAGE_DIR}${day}.${gran}.bin`)));
}

export interface Merge {
  cand: Uint8Array; // n * P
  openS: number; mergeS: number; lists: number; bytes: number; ids: number; cells: number;
}
export function mergeCover(cov: CoverageDay, openS: number, order: number, P: number, coverOf: (p: number) => number[]): Merge {
  const cfg = cov.configs.find((c) => c.order === order)!;
  const cand = new Uint8Array(cov.n * P);
  const t0 = performance.now();
  let lists = 0, bytes = 0, ids = 0, cells = 0;
  for (let p = 0; p < P; p++) {
    const cs = coverOf(p); cells += cs.length;
    for (const cell of cs) {
      const i = findCell(cfg, cell * P + p);
      if (i < 0) continue;
      lists++; bytes += cfg.lens[i]!;
      forEachId(cov.buf, cfg.offs[i]!, cfg.lens[i]!, cfg.tags[i]!, (id) => { cand[id * P + p] = 1; ids++; });
    }
  }
  return { cand, openS, mergeS: secs(t0), lists, bytes, ids, cells };
}

/** windows (flat [startMs,endMs,...]) per object index from a candidate mask at P periods. */
export function windowsOf(cand: Uint8Array, n: number, P: number, dayStart: number, minObj?: Uint8Array): Map<number, number[]> {
  const per = DAY_MS / P, out = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    let w: number[] | null = null, p = 0;
    while (p < P) {
      if (!cand[i * P + p] && !(minObj && minObj[i * P + p])) { p++; continue; }
      let q = p; while (q < P && (cand[i * P + q] || (minObj && minObj[i * P + q]))) q++;
      (w ??= []).push(dayStart + p * per, dayStart + q * per);
      p = q;
    }
    if (w) out.set(i, w);
  }
  return out;
}
export const expandTo144 = (cand: Uint8Array, n: number, P: number, into: Uint8Array): void => {
  const per = 144 / P;
  for (let i = 0; i < n; i++) for (let p = 0; p < P; p++) if (cand[i * P + p]) for (let k = 0; k < per; k++) into[i * 144 + p * per + k] = 1;
};

/** Objects the build could not index (flip cells constantly: per-day row cap). They are ALWAYS candidates. */
export function unindexedNorads(day: string): Set<number> {
  const out = new Set<number>();
  for (const l of readFileSync(COVERAGE_DIR + 'report.jsonl', 'utf8').trim().split('\n')) {
    const r = JSON.parse(l) as { day: string; dropped: string[] };
    if (r.day === day) { out.clear(); for (const s of r.dropped) out.add(Number(s.split('(')[0])); }
  }
  return out;
}
