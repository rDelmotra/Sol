// ============================================================
// SPIKE — not production. S6: faster, industry-shaped 36 h screener (called from screen-forward.ts with --mode s6; --mode ref is the reference).
//
// Pipeline of one batch (the catalog, exclusions, Pc and output format are those of S5):
//   1. radius pass     coarse SGP4 sampling of every object -> measured radius range [rlo, rhi] and top speed (padded, s6-lib.ts)
//   2. pre-filter      apogee-perigee test on the measured ranges: pair counts by regime; objects with no partner leave the screen
//   3. coarse stage    adaptive time stepping: SGP4 every dtS s (one class; --slow-factor > 1 adds an experimental slow class for rlo >= 10,000 km,
//                      which did not pay off, see STARMAP.md),
//                      spatial hash with the cell size of THE BOUND (s6-lib.ts), and the conservative window test against the
//                      Space Flight Safety Handbook RIC volume of either object (and/or a 5 km sphere, for comparison with S5)
//   4. formation       as S5 (pairs within 50 km for more than half the window are not conjunctions)
//   5. refinement      per candidate run (adjacent windows merged): sign changes of r.v on a fine grid, polished to 1 ms; the
//                      closest-approach point must lie inside the volume; Pc as S5 (in the workers)
// --mode ref: S5's 5 s grid with a per-pair sphere that contains both volumes, S5's refine, then the same volume test: the recall reference.
// ============================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { EvPool } from './events-pool.js';
import { identicalGroups, type CatFull } from './events.js';
import { batchTimeMs, quantile, type FwdEvent } from './forward-lib.js';
import { FORWARD_DIR, batchFile, FORM_KM, FORM_FRAC, secs, recentJumps, loadBatchObjects, writeLines } from './forward-common.js';
import { SFS_VOLUMES, halfDiagonal, shapeFromOmm, shellCounts, solveCell, volumeIdFor } from './s6-lib.js';
import type { CoarseOut, RadiusTask, Refine6Out, RefGridOut } from './s6-worker.js';

export interface S6Opts {
  day: string; hours: number; dtS: number; slowFactor: number; workers: number; tag: string;
  /** 'sfs' = the eight handbook volumes (plus the sphere if sphereKm > 0); 'sphere' = sphere only */
  volumes: 'sfs' | 'sphere'; sphereKm: number;
  /** slow class: rlo >= this (km) */
  slowRlo: number;
  /** 0 = no pre-filter removal of objects (all objects are propagated) */
  prefilter: boolean;
  /** reference only: widen the linear-closest-approach volume test by this many km (0 = none) */
  pruneKm: number;
  /** formation share: first look at every k-th minute (0 = every minute, as S5) */
  formStride: number;
  /** objects whose top speed exceeds this (km/s) are gathered on a second, coarser grid (0 = off) */
  hotVmax: number;
}
export const S6_DEFAULTS: Omit<S6Opts, 'day' | 'tag'> = { hours: 36, dtS: 60, slowFactor: 1, workers: 3, volumes: 'sfs', sphereKm: 5, slowRlo: 10_000, prefilter: true, pruneKm: 10, formStride: 5, hotVmax: 8.2 };

const REGIMES = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];

export interface Prep {
  N: number; objs: CatFull[]; hu: Float64Array; hv: Float64Array; hw: Float64Array; hr: Float64Array; volId: Uint8Array;
}
export function volumesFor(objs: CatFull[], o: S6Opts): Prep {
  const N = objs.length;
  const hu = new Float64Array(N), hv = new Float64Array(N), hw = new Float64Array(N), hr = new Float64Array(N), volId = new Uint8Array(N);
  const R = o.sphereKm;
  for (let i = 0; i < N; i++) {
    const id = volumeIdFor(shapeFromOmm(objs[i]!.omm));
    volId[i] = id;
    const v = SFS_VOLUMES[id - 1]!;
    if (o.volumes === 'sfs') {
      hu[i] = Math.max(v.u, R); hv[i] = Math.max(v.v, R); hw[i] = Math.max(v.w, R);
      hr[i] = halfDiagonal({ u: hu[i]!, v: hv[i]!, w: hw[i]! });
    } else { hu[i] = R; hv[i] = R; hw[i] = R; hr[i] = R; }
  }
  return { N, objs, hu, hv, hw, hr, volId };
}
const slim = (o: CatFull) => { const { omm: _omm, ...rest } = o as CatFull & { omm: unknown }; void _omm; return rest; };

async function startPool(prep: Prep, group: Int32Array, jumps: Set<number>, workers: number): Promise<EvPool> {
  const pool = new EvPool(workers, './s6-worker-boot.mjs');
  await pool.start({ type: 'init', omm: prep.objs.map((x) => x.omm), group, cats: prep.objs.map(slim), jumps: [...jumps] });
  return pool;
}

// ---------------------------------------------------------------- S6
export async function runS6(o: S6Opts): Promise<void> {
  const T0 = Date.now();
  mkdirSync(FORWARD_DIR, { recursive: true });
  const t0 = batchTimeMs(o.day), t1 = t0 + o.hours * 3_600_000, spanS = o.hours * 3600;
  const timing: Record<string, number> = {};
  const calls: Record<string, number> = {};
  let tm = Date.now();

  const bo = loadBatchObjects(o.day, t0, t1);
  const { objs, props } = bo;
  void props;
  const N = objs.length;
  const prep = volumesFor(objs, o);
  const { group, groups } = identicalGroups(objs);
  const jumps = await recentJumps(t0);
  timing.load = secs(tm);

  tm = Date.now();
  const pool = await startPool(prep, group, jumps.set, o.workers);
  await pool.calls();
  timing.poolInit = secs(tm);

  // ---- 1. radius pass ----
  tm = Date.now();
  const rtasks: RadiusTask[] = [];
  for (let a = 0; a < N; a += 400) rtasks.push({ type: 'radius', o0: a, o1: Math.min(N, a + 400), t0Ms: t0, t1Ms: t1, padKm: 2 });
  const rout = await pool.map<Float64Array>(rtasks);
  const rlo = new Float64Array(N), rhi = new Float64Array(N), vmax = new Float64Array(N), omega = new Float64Array(N);
  let radiusFail = 0, radiusSamples = 0, noRadius = 0, padMax = 0;
  for (let t = 0; t < rtasks.length; t++) {
    const f = rout[t]!, a = rtasks[t]!.o0;
    for (let k = 0; k < f.length / 6; k++) {
      const i = a + k;
      rlo[i] = f[6 * k]!; rhi[i] = f[6 * k + 1]!; vmax[i] = f[6 * k + 2]!; radiusSamples += f[6 * k + 3]! || 0; radiusFail += f[6 * k + 4]! || 0; padMax = Math.max(padMax, f[6 * k + 5]! || 0);
      if (!(rlo[i]! > 0)) { noRadius++; rlo[i] = 0; rhi[i] = 1e9; vmax[i] = 20; }
      omega[i] = (1.05 * vmax[i]!) / Math.max(1, rlo[i]!) + 1e-5;
    }
  }
  calls.radius = await pool.calls();
  timing.radius = secs(tm);

  // ---- 2. pre-filter on the measured radius ranges ----
  tm = Date.now();
  const Rmax = prep.hr.reduce((m, x) => Math.max(m, x), 0);
  const all = shellCounts(rlo, rhi, Rmax);
  const noPartner = new Uint8Array(N);
  let removed = 0;
  for (let i = 0; i < N; i++) if (all.perObject[i]! - 1 <= 0) { noPartner[i] = 1; removed++; }
  let pairsTotal = (N * (N - 1)) / 2, pairsOverlap = 0;
  for (let i = 0; i < N; i++) pairsOverlap += all.perObject[i]! - 1;
  pairsOverlap /= 2;
  // by regime of the catalog (mean-element label): unordered pairs and pairs whose measured radius ranges come within Rmax of each other
  const cls = new Uint8Array(N);
  objs.forEach((x, i) => { cls[i] = Math.max(0, REGIMES.indexOf(String(x.regime))); });
  const regimePairs: Array<{ a: string; b: string; total: number; overlap: number }> = [];
  for (let a = 0; a < REGIMES.length; a++) for (let b = a; b < REGIMES.length; b++) {
    const na = cls.reduce((s, c) => s + (c === a ? 1 : 0), 0), nb = cls.reduce((s, c) => s + (c === b ? 1 : 0), 0);
    if (!na || !nb) continue;
    const sc = shellCounts(rlo, rhi, Rmax, cls, b);
    let cross = 0;
    for (let i = 0; i < N; i++) if (cls[i] === a) cross += sc.perObject[i]!;
    const total = a === b ? (na * (na - 1)) / 2 : na * nb;
    const overlap = a === b ? (cross - na) / 2 : cross;
    regimePairs.push({ a: REGIMES[a]!, b: REGIMES[b]!, total, overlap });
  }
  const slow = new Uint8Array(N);
  if (o.slowFactor > 1) for (let i = 0; i < N; i++) if (rlo[i]! >= o.slowRlo) slow[i] = 1;
  timing.prefilter = secs(tm);

  // ---- bounds to the workers ----
  tm = Date.now();
  await pool.broadcast({ type: 'bounds', rlo, rhi, vmax, omega, hu: prep.hu, hv: prep.hv, hw: prep.hw, hr: prep.hr, volId: prep.volId, slow, sfs: o.volumes === 'sfs', sphereKm: o.sphereKm });
  const active = (i: number) => !(o.prefilter && noPartner[i]);

  // ---- 3. coarse passes ----
  const passes: Array<{ name: string; subset: Int32Array; dtS: number; h: number; L: number; epsCap: number; padCap: number; steps: number }> = [];
  const mkBound = (sel: number[], h: number) => {
    let hrMax = 0, rFloor = Infinity, omegaMax = 0;
    const sp: number[] = [];
    for (const i of sel) { hrMax = Math.max(hrMax, prep.hr[i]!); rFloor = Math.min(rFloor, Math.max(6300, rlo[i]!)); omegaMax = Math.max(omegaMax, omega[i]!); sp.push(vmax[i]!); }
    sp.sort((a, b) => b - a);
    return { hrMax, rFloor, omegaMax, wMax: (sp[0] ?? 0) + (sp[1] ?? 0), ...solveCell({ hrMax, wMax: (sp[0] ?? 0) + (sp[1] ?? 0), rFloor, omegaMax, h }) };
  };
  const fastSel: number[] = [], slowSel: number[] = [];
  for (let i = 0; i < N; i++) if (active(i)) (slow[i] ? slowSel : fastSel).push(i);
  const dtF = o.dtS, dtSlow = o.dtS * o.slowFactor;
  if ((1800 % dtF) || (1800 % dtSlow) || ((spanS % dtF) || (spanS % dtSlow))) throw new Error('step sizes must divide 1800 s and the window');
  const hotSel = o.hotVmax > 0 ? fastSel.filter((i) => vmax[i]! > o.hotVmax) : [];
  const bulkSel = o.hotVmax > 0 ? fastSel.filter((i) => vmax[i]! <= o.hotVmax) : fastSel;
  const bf = mkBound(bulkSel, dtF / 2);
  let hotInfo: { Lh: number; epsCapH: number; padCapH: number; n: number; wMaxH: number } | null = null;
  if (hotSel.length) {
    // a fast mover meets any object: its relative speed is at most its own top speed plus the fastest of all
    const vTop = fastSel.reduce((m, i) => Math.max(m, vmax[i]!), 0), vHot = hotSel.reduce((m, i) => Math.max(m, vmax[i]!), 0);
    const hb = solveCell({ hrMax: bf.hrMax, wMax: vTop + vHot, rFloor: Math.min(...fastSel.map((i) => Math.max(6300, rlo[i]!))), omegaMax: Math.max(...fastSel.map((i) => omega[i]!)), h: dtF / 2 });
    hotInfo = { Lh: hb.L, epsCapH: hb.epsCap, padCapH: hb.padCap, n: hotSel.length, wMaxH: vTop + vHot };
  }
  passes.push({ name: 'fast', subset: Int32Array.from(fastSel), dtS: dtF, h: dtF / 2, L: bf.L, epsCap: bf.epsCap, padCap: bf.padCap, steps: spanS / dtF + 1 });
  if (slowSel.length) {
    const hS = dtSlow / 2, minRloSlow = Math.min(...slowSel.map((i) => rlo[i]!));
    const first = mkBound([...slowSel, ...fastSel.filter((i) => rhi[i]! >= minRloSlow - 4000)], hS);
    const reach = fastSel.filter((i) => rhi[i]! >= minRloSlow - first.L - first.hrMax - 10);
    const bs = mkBound([...slowSel, ...reach], hS);
    passes.push({ name: 'slow', subset: Int32Array.from([...slowSel, ...reach]), dtS: dtSlow, h: hS, L: bs.L, epsCap: bs.epsCap, padCap: bs.padCap, steps: spanS / dtSlow + 1 });
  }
  const cand: Array<{ pass: number; arr: Float64Array }> = [];
  const formArr: Int32Array[] = [];
  const passStats: Array<Record<string, number | string>> = [];
  const SL = 12; // steps per task
  for (let pi = 0; pi < passes.length; pi++) {
    const ps = passes[pi]!;
    const ptm = Date.now();
    const tasks = [];
    const formEvery = 1800 / ps.dtS;
    for (let s = 0; s < ps.steps; s += SL) tasks.push({ type: 'coarse', s0: s, s1: Math.min(ps.steps, s + SL), t0Ms: t0, dtMs: ps.dtS * 1000, subset: ps.subset, slowAny: pi === 1, L: ps.L, h: ps.h, epsCap: ps.epsCap, padCap: ps.padCap, formEvery, formKm: FORM_KM, ...(pi === 0 && hotInfo ? { hot: Int32Array.from(hotSel), Lh: hotInfo.Lh, epsCapH: hotInfo.epsCapH, padCapH: hotInfo.padCapH } : {}) });
    const outs = await pool.map<CoarseOut>(tasks);
    let tests = 0, g = 0, sh = 0, sg = 0, nc = 0, cpu = 0;
    for (const x of outs) { tests += x.tests; g += x.afterGather; sh += x.afterShell; sg += x.afterSegment; nc += x.cand.length / 3; cpu += x.ms / 1000; cand.push({ pass: pi, arr: x.cand }); formArr.push(x.form); }
    passStats.push({ pass: ps.name, hotObjects: pi === 0 && hotInfo ? hotInfo.n : 0, hotCellKm: pi === 0 && hotInfo ? +hotInfo.Lh.toFixed(1) : 0, objects: ps.subset.length, dtS: ps.dtS, windowHalfS: ps.h, cellKm: +ps.L.toFixed(1), epsCapKm: +ps.epsCap.toFixed(3), padCapKm: +ps.padCap.toFixed(3), steps: ps.steps, pairTests: tests, afterGatherRadius: g, afterShellTest: sh, afterSegmentTest: sg, candidateWindows: nc, cpuSeconds: +cpu.toFixed(1), wallSeconds: secs(ptm) });
  }
  calls.coarse = await pool.calls();
  timing.coarse = secs(tm);

  // ---- 4. formation exclusion (as S5) ----
  tm = Date.now();
  const formSet = new Set<number>();
  for (const f of formArr) for (let k = 0; k < f.length; k += 2) formSet.add(f[k]! * N + f[k + 1]!);
  const fp = new Int32Array(formSet.size * 2);
  let q = 0;
  for (const key of formSet) { fp[q++] = Math.floor(key / N); fp[q++] = key % N; }
  const ftasks = [];
  for (let p = 0; p < fp.length; p += 400 * 2) ftasks.push({ type: 'formFrac', pairs: fp.subarray(p, Math.min(fp.length, p + 400 * 2)), t0Ms: t0, t1Ms: t1, stepMs: 60_000, km: FORM_KM, stride: o.formStride });
  const fouts = await pool.map<Float64Array>(ftasks);
  const formation = new Set<number>();
  const formationPairs: Array<[number, number]> = [];
  for (const f of fouts) for (let k = 0; k < f.length; k += 4) if (f[k + 2]! > FORM_FRAC) { formation.add(f[k]! * N + f[k + 1]!); formationPairs.push([objs[f[k]!]!.noradId, objs[f[k + 1]!]!.noradId]); }
  calls.formation = await pool.calls();
  timing.formation = secs(tm);

  // ---- 5. candidate windows -> runs -> refinement ----
  tm = Date.now();
  const SBITS = 16384;
  const runs: number[] = [];
  let nWindows = 0, nWindowsFormation = 0;
  for (let pi = 0; pi < passes.length; pi++) {
    const ps = passes[pi]!;
    let m = 0;
    for (const c of cand) if (c.pass === pi) m += c.arr.length / 3;
    const keys = new Float64Array(m);
    let w = 0;
    for (const c of cand) if (c.pass === pi) for (let k = 0; k < c.arr.length; k += 3) {
      const i = c.arr[k]!, j = c.arr[k + 1]!;
      if (formation.has(i * N + j)) { nWindowsFormation++; continue; }
      keys[w++] = (i * 65536 + j) * SBITS + c.arr[k + 2]!;
    }
    const ks = keys.subarray(0, w).sort();
    nWindows += w;
    const subMs = Math.max(1000, (ps.dtS * 1000) / 6);
    let start = -1, last = -1, pair = -1;
    const flush = () => {
      if (start < 0) return;
      const i = Math.floor(pair / 65536), j = pair % 65536;
      runs.push(i, j, Math.max(t0, t0 + start * ps.dtS * 1000 - ps.h * 1000), Math.min(t1, t0 + last * ps.dtS * 1000 + ps.h * 1000), subMs);
    };
    for (let k = 0; k < ks.length; k++) {
      const key = ks[k]!, s = key % SBITS, pr = (key - s) / SBITS;
      if (pr === pair && s - last <= 1) { last = s; continue; }
      flush();
      pair = pr; start = s; last = s;
    }
    flush();
  }
  const nRuns = runs.length / 5;
  const rftasks = [];
  const RCH = 300;
  for (let p = 0; p < runs.length; p += 5 * RCH) rftasks.push({ type: 'refine6', runs: Float64Array.from(runs.slice(p, p + 5 * RCH)), pc: true });
  const rfouts = await pool.map<Refine6Out>(rftasks);
  let minima = 0, accepted = 0, evalFail = 0;
  const events: FwdEvent[] = [];
  for (const x of rfouts) { minima += x.minima; accepted += x.accepted; evalFail += x.evalFail; for (const e of x.events) events.push(e); }
  calls.refine = await pool.calls();
  await pool.close();
  timing.refine = secs(tm);

  // ---- merge, dedupe, write ----
  tm = Date.now();
  events.sort((a, b) => a.a - b.a || a.b - b.b || a.tca - b.tca);
  const evs: FwdEvent[] = [];
  let dup = 0;
  for (const e of events) {
    const l = evs[evs.length - 1];
    if (l && l.a === e.a && l.b === e.b && Math.abs(l.tca - e.tca) < 10_000) { dup++; continue; }
    evs.push(e);
  }
  writeLines(batchFile(o.day, o.tag), evs.map((e) => JSON.stringify(e)));
  timing.write = secs(tm);

  const below = (x: number) => evs.filter((e) => e.miss < x).length;
  const above = (k: 'pcBal' | 'pcCons' | 'pcMax' | 'pcBalNoFloor') => ({ gt1e6: evs.filter((e) => e[k] > 1e-6).length, gt1e5: evs.filter((e) => e[k] > 1e-5).length, gt1e4: evs.filter((e) => e[k] > 1e-4).length });
  const pcQ = (k: 'pcBal' | 'pcCons' | 'pcMax') => { const s = evs.map((e) => e[k]).sort((a, b) => a - b); return { p50: quantile(s, 0.5), p90: quantile(s, 0.9), p99: quantile(s, 0.99), max: s[s.length - 1] ?? 0 }; };
  const byVol: Record<string, number> = {};
  let inAny = 0, inEll = 0, in5 = 0, inBoth = 0, in5only = 0, volOnly = 0;
  for (const e of evs) {
    const v = e.vol!;
    const inV = v.inA || v.inB, ell = v.ellA || v.ellB;
    if (inV) { inAny++; const id = v.inA ? v.va : v.vb; byVol[id] = (byVol[id] ?? 0) + 1; if (v.inA && v.inB && v.va !== v.vb) byVol[`also${v.vb}`] = (byVol[`also${v.vb}`] ?? 0) + 1; }
    if (ell) inEll++;
    if (v.in5) in5++;
    if (inV && v.in5) inBoth++;
    if (!inV && v.in5) in5only++;
    if (inV && !v.in5) volOnly++;
  }
  const volCounts: Record<string, number> = {};
  for (let i = 0; i < N; i++) volCounts[prep.volId[i]!] = (volCounts[prep.volId[i]!] ?? 0) + 1;
  const mainCalls = bo.sgp4Calls; // garbage-orbit check, exact loop count
  const sgp4Total = (calls.radius ?? 0) + (calls.coarse ?? 0) + (calls.formation ?? 0) + (calls.refine ?? 0) + mainCalls;
  const meta = {
    day: o.day, tag: o.tag, mode: 's6', batchTime: new Date(t0).toISOString(), windowEnd: new Date(t1).toISOString(), hours: o.hours, dtS: o.dtS, workers: o.workers,
    settings: { volumes: o.volumes, sphereKm: o.sphereKm, slowFactor: o.slowFactor, slowRlo: o.slowRlo, prefilter: o.prefilter },
    objects: { historyFile: bo.cc.objs.length + bo.cc.droppedNoEarlier, usedFallbackSetFromPreviousDay: bo.cc.fallback, droppedNoEarlierSet: bo.cc.droppedNoEarlier, fencedIds: bo.fenced, unusableSatrec: bo.unusable, garbageOrbit: bo.garbage, screened: N, identicalGroups: groups.length, identicalObjects: groups.reduce((s, g) => s + g.length, 0), volumeIdCounts: volCounts },
    recentJumpFlagsAvailable: jumps.ok, recentJumpObjects: jumps.set.size,
    radiusPass: { samples: radiusSamples, failedSamples: radiusFail, noRadius, maxPadKm: +padMax.toFixed(2), calls: calls.radius },
    prefilter: { shellRadiusKm: Rmax, pairsTotal, pairsOverlap, pairsRemoved: pairsTotal - pairsOverlap, objectsWithNoPartner: removed, objectsPropagated: fastSel.length + slowSel.length, slowClassObjects: slowSel.length, byRegime: regimePairs },
    passes: passStats,
    grid: { candidateWindows: nWindows, candidateWindowsOfFormationPairs: nWindowsFormation, formationCandidates: formSet.size, formationPairs: formationPairs.length, formationPairList: formationPairs, runs: nRuns, minima, acceptedMinima: accepted, dupDropped: dup, evalFailed: evalFail },
    sgp4Calls: { ...calls, garbageCheck: mainCalls, total: sgp4Total },
    sgp4CallsMeasured: { ...calls, garbageCheck: mainCalls, total: sgp4Total },
    timing: { ...timing, total: secs(T0) },
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    events: { total: evs.length, lt5: below(5), lt1: below(1), lt05: below(0.5), lt025: below(0.25), inVolumeBox: inAny, inVolumeEllipsoid: inEll, within5km: in5, inBoxAndWithin5: inBoth, within5kmOnly: in5only, boxOnly: volOnly, byVolumeId: byVol, evalFailed: evalFail, slowUnder05kms: evs.filter((e) => e.slow).length, ageOver14d: evs.filter((e) => e.old).length, manoeuvrableEither: evs.filter((e) => e.manA || e.manB).length, manoeuvrableBoth: evs.filter((e) => e.manA && e.manB).length },
    pcCounts: { balanced: above('pcBal'), conservative: above('pcCons'), max: above('pcMax'), balancedNoFloor: above('pcBalNoFloor') },
    pcQuantiles: { balanced: pcQ('pcBal'), conservative: pcQ('pcCons'), max: pcQ('pcMax') },
  };
  writeFileSync(batchFile(o.day, o.tag, 'meta.json'), JSON.stringify(meta, null, 1));
  console.log(`[${o.day}${o.tag ? ' ' + o.tag : ''}] S6 ${N} objects (${removed} without partner), ${evs.length} events (box ${inAny}, 5 km ${in5}); SGP4 ${(sgp4Total / 1e6).toFixed(1)} M (radius ${((calls.radius ?? 0) / 1e6).toFixed(1)}, coarse ${((calls.coarse ?? 0) / 1e6).toFixed(1)}, formation ${((calls.formation ?? 0) / 1e6).toFixed(1)}, refine+Pc ${((calls.refine ?? 0) / 1e6).toFixed(1)}); wall ${meta.timing.total} s (${Object.entries(timing).map(([k, v]) => `${k} ${v}`).join(', ')}); peak RSS ${meta.maxRssMB} MB`);
}

// ---------------------------------------------------------------- reference
export async function runRef(o: S6Opts): Promise<void> {
  const T0 = Date.now();
  mkdirSync(FORWARD_DIR, { recursive: true });
  const dtS = 5, t0 = batchTimeMs(o.day), nSteps = Math.round((o.hours * 3600) / dtS), t1 = t0 + nSteps * dtS * 1000, dtMs = dtS * 1000;
  const timing: Record<string, number> = {}, calls: Record<string, number> = {};
  let tm = Date.now();
  const bo = loadBatchObjects(o.day, t0, t1);
  const { objs } = bo;
  const N = objs.length;
  const prep = volumesFor(objs, o);
  const { group } = identicalGroups(objs);
  const pool = await startPool(prep, group, new Set(), o.workers);
  await pool.calls();
  const zero = new Float64Array(N);
  await pool.broadcast({ type: 'bounds', rlo: zero, rhi: zero, vmax: zero, omega: zero, hu: prep.hu, hv: prep.hv, hw: prep.hw, hr: prep.hr, volId: prep.volId, slow: new Uint8Array(N), sfs: o.volumes === 'sfs', sphereKm: o.sphereKm });
  timing.load = secs(tm);

  tm = Date.now();
  const slack = 0.5;
  const L = maxHr(prep) + 2 + 20 * (dtS / 2 + slack) + 1;
  const formEvery = Math.round(1800 / dtS), SL = Math.round(600 / dtS);
  const tasks = [];
  for (let s = 0; s <= nSteps; s += SL) tasks.push({ type: 'refgrid', s0: s, s1: Math.min(nSteps + 1, s + SL), t0Ms: t0, dtMs, L, slack, formEvery, formKm: FORM_KM, pruneKm: o.pruneKm });
  const outs = await pool.map<RefGridOut>(tasks);
  calls.grid = await pool.calls();
  timing.grid = secs(tm);

  tm = Date.now();
  const formSet = new Set<number>();
  for (const x of outs) for (let k = 0; k < x.form.length; k += 2) formSet.add(x.form[k]! * N + x.form[k + 1]!);
  const fp = new Int32Array(formSet.size * 2);
  let q = 0;
  for (const key of formSet) { fp[q++] = Math.floor(key / N); fp[q++] = key % N; }
  const ftasks = [];
  for (let p = 0; p < fp.length; p += 400 * 2) ftasks.push({ type: 'formFrac', pairs: fp.subarray(p, Math.min(fp.length, p + 400 * 2)), t0Ms: t0, t1Ms: t1, stepMs: 60_000, km: FORM_KM });
  const fouts = await pool.map<Float64Array>(ftasks);
  const formation = new Set<number>();
  for (const f of fouts) for (let k = 0; k < f.length; k += 4) if (f[k + 2]! > FORM_FRAC) formation.add(f[k]! * N + f[k + 1]!);
  calls.formation = await pool.calls();
  timing.formation = secs(tm);

  tm = Date.now();
  const byPair = new Map<number, number[]>();
  let nCand = 0;
  for (const x of outs) for (let k = 0; k < x.cand.length; k += 5) {
    const key = x.cand[k]! * N + x.cand[k + 1]!;
    if (formation.has(key)) continue;
    nCand++;
    const rec = [x.cand[k + 2]!, x.cand[k + 3]!, x.cand[k + 4]!];
    const l = byPair.get(key);
    if (l) l.push(...rec); else byPair.set(key, rec);
  }
  const GAP = Math.round(30 / dtS);
  const enc: number[] = [];
  for (const [key, l] of byPair) {
    const recs: Array<[number, number, number]> = [];
    for (let k = 0; k < l.length; k += 3) recs.push([l[k]!, l[k + 1]!, l[k + 2]!]);
    recs.sort((a, b) => a[0] - b[0]);
    let best = recs[0]!, last = recs[0]![0];
    const flush = () => { enc.push(Math.floor(key / N), key % N, t0 + best[0] * dtMs + best[1] * 1000); };
    for (let k = 1; k < recs.length; k++) {
      const r = recs[k]!;
      if (r[0] - last > GAP) { flush(); best = r; } else if (r[2] < best[2]) best = r;
      last = r[0];
    }
    flush();
  }
  byPair.clear();
  const nEnc = enc.length / 3;
  const rtasks = [];
  for (let p = 0; p < enc.length; p += 3 * 1500) rtasks.push({ type: 'refine5', buf: Float64Array.from(enc.slice(p, p + 3 * 1500)), win: 4000 });
  const routs = await pool.map<Float64Array>(rtasks);
  calls.refine = await pool.calls();
  await pool.close();
  timing.refine = secs(tm);

  // records: a, b, tca, miss, vrel, ricB(3), ricA(3), flags
  const rec: Array<{ a: number; b: number; tca: number; miss: number; vrel: number; ricB: number[]; ricA: number[]; inA: boolean; inB: boolean; in5: boolean; accepted: boolean }> = [];
  for (const r of routs) for (let k = 0; k < r.length; k += 12) {
    const tca = r[k + 2]!;
    if (tca < t0 || tca > t1) continue;
    const f = r[k + 11]!;
    rec.push({ a: objs[r[k]!]!.noradId, b: objs[r[k + 1]!]!.noradId, tca, miss: r[k + 3]!, vrel: r[k + 4]!, ricB: [r[k + 5]!, r[k + 6]!, r[k + 7]!], ricA: [r[k + 8]!, r[k + 9]!, r[k + 10]!], inA: !!(f & 1), inB: !!(f & 2), in5: !!(f & 4), accepted: !!(f & 8) });
  }
  rec.sort((x, y) => x.a - y.a || x.b - y.b || x.tca - y.tca);
  const acc = rec.filter((r) => r.accepted);
  const dedup = acc.filter((r, i) => !(i > 0 && acc[i - 1]!.a === r.a && acc[i - 1]!.b === r.b && Math.abs(acc[i - 1]!.tca - r.tca) < 10_000));
  writeLines(batchFile(o.day, o.tag), dedup.map((e) => JSON.stringify(e)));
  const total = (calls.grid ?? 0) + (calls.formation ?? 0) + (calls.refine ?? 0) + bo.sgp4Calls;
  const meta = { day: o.day, tag: o.tag, mode: 'ref', hours: o.hours, dtS, workers: o.workers, settings: { volumes: o.volumes, sphereKm: o.sphereKm, pruneKm: o.pruneKm }, gridCellKm: L, candidates: nCand, encounters: nEnc, refined: rec.length, accepted: dedup.length, sgp4CallsMeasured: { ...calls, garbageCheck: bo.sgp4Calls, total }, timing: { ...timing, total: secs(T0) }, maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), screened: N };
  writeFileSync(batchFile(o.day, o.tag, 'meta.json'), JSON.stringify(meta, null, 1));
  console.log(`[${o.day} ${o.tag}] REF ${N} objects, cell ${L.toFixed(0)} km, ${nCand} candidates, ${nEnc} encounters, ${dedup.length} accepted; SGP4 ${(total / 1e6).toFixed(0)} M; wall ${meta.timing.total} s (${Object.entries(timing).map(([k, v]) => `${k} ${v}`).join(', ')}); peak RSS ${meta.maxRssMB} MB`);
}
const maxHr = (p: Prep): number => p.hr.reduce((m, x) => Math.max(m, x), 0);
