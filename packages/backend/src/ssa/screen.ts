// ============================================================
// Encounter screener: all-vs-all screening of a catalog over a window (default 36 h) with Foster Pc.
// The S6 algorithm of the star-map spike (scripts/starmap/screen-s6.ts), ported with the same constants:
//   1. radius pass     coarse SGP4 sampling of every object -> measured radius range [rlo, rhi] and top speed (padded, volumes.ts)
//   2. pre-filter      apogee-perigee test on the measured ranges; objects with no partner leave the screen
//   3. coarse stage    adaptive time stepping: SGP4 every dtS s, spatial hash with the cell size of THE BOUND (volumes.ts) and the
//                      conservative window test against the Space Flight Safety Handbook RIC volume of either object (or a 5 km sphere)
//   4. formation       pairs within 50 km for more than half the window are not encounters
//   5. refinement      per candidate run (adjacent windows merged): sign changes of r.v on a fine grid, polished to 0.01 ms; the
//                      closest-approach point must lie inside the volume; Pc in the workers
// The catalog is injected (no file reads here). Per object the latest element set with epoch <= batch time is used.
// ============================================================
import { causalSelect, identicalGroups, makeProp, epochMsOf } from './encounter.js';
import { WorkerPool } from './pool.js';
import { SFS_VOLUMES, halfDiagonal, shapeFromOmm, shellCounts, solveCell, volumeIdFor } from './volumes.js';
import { loadUncertaintyModel } from './uncertainty.js';
import type { Encounter, ScreenOpts, ScreenStats, SsaObject } from './types.js';
import type { CoarseOut, RadiusTask, Refine6Out } from './worker.js';
import * as satellite from 'satellite.js';

/** Objects that are never screened (bad element sets that propagate to garbage). */
export const FENCED_IDS = new Set([54922]);
/** Formation exclusion: pairs within FORM_KM for more than FORM_FRAC of the window. */
export const FORM_KM = 50;
export const FORM_FRAC = 0.5;

/** The S6 settings (frozen with the spike): SFS volumes plus a 5 km sphere, 60 s coarse step, 5-minute formation stride, hot grid above 8.2 km/s. */
export const S6_SETTINGS = { hours: 36, dtS: 60, workers: 3, sphereKm: 5, formStride: 5, hotVmax: 8.2 } as const;

const secs = (t: number) => +((Date.now() - t) / 1000).toFixed(2);
const REGIME_FALLBACK = (omm: Record<string, unknown>): { regime: string; perigee: number } => {
  const s = shapeFromOmm(omm);
  const apogee = s.perigeeKm + 2 * (Math.cbrt(398600.4418 / ((Number(omm.MEAN_MOTION) * 2 * Math.PI) / 86400) ** 2) * s.ecc);
  const regime = s.ecc > 0.25 ? 'HEO' : s.periodMin >= 1300 && s.periodMin <= 1800 ? 'GEO' : apogee < 2000 ? 'LEO' : s.periodMin < 1300 ? 'MEO' : 'OTHER';
  return { regime, perigee: s.perigeeKm };
};

/** Fill regime / perigee when the caller did not supply them (the uncertainty class needs both). Never mutates the input. */
function withDerived(o: SsaObject): SsaObject {
  if (o.regime !== undefined && o.perigee !== undefined) return o;
  const d = REGIME_FALLBACK(o.omm);
  return { ...o, regime: o.regime ?? d.regime, perigee: o.perigee ?? d.perigee };
}

/**
 * Screen `catalog` (any number of element sets per object) for the window [batchTimeMs, batchTimeMs + hours].
 * Resolves with every encounter, sorted by (noradA, noradB, tca), and run statistics.
 */
export async function screenEncounters(catalog: SsaObject[], batchTimeMs: number, opts: ScreenOpts = {}): Promise<{ encounters: Encounter[]; stats: ScreenStats }> {
  const T0 = Date.now();
  const hours = opts.hours ?? S6_SETTINGS.hours, dtS = opts.dtS ?? S6_SETTINGS.dtS, workers = opts.workers ?? S6_SETTINGS.workers;
  const { sphereKm, formStride, hotVmax } = S6_SETTINGS;
  const t0 = batchTimeMs, t1 = t0 + hours * 3_600_000, spanS = hours * 3600;
  const model = loadUncertaintyModel(opts.modelPath);

  // ---- usable objects: causal element set, fence, satrec, garbage-orbit check (radius outside 6340 km..1e6 km at start, middle or end) ----
  const sel = causalSelect(catalog, t0);
  const objs: SsaObject[] = [];
  let fenced = 0, unusable = 0, garbage = 0, loadCalls = 0;
  for (const o0 of sel.objs) {
    if (FENCED_IDS.has(o0.noradId)) { fenced++; continue; }
    const p = makeProp(o0.omm);
    if (!p) { unusable++; continue; }
    let bad = false;
    for (const t of [t0, (t0 + t1) / 2, t1]) {
      loadCalls++;
      const pv = satellite.sgp4(p.satrec, (t - p.epochMs) / 60_000);
      const r = pv ? pv.position : null;
      if (!r || typeof r === 'boolean' || !Number.isFinite(r.x)) { bad = true; break; }
      const rad = Math.hypot(r.x, r.y, r.z);
      if (rad < 6340 || rad > 1e6) { bad = true; break; }
    }
    if (bad) { garbage++; continue; }
    objs.push(withDerived(o0));
  }
  const N = objs.length;
  if (N >= 65536) throw new Error(`catalog too large for the pair key (${N} objects)`);
  let elementCutoffMs = 0;
  for (const o of objs) elementCutoffMs = Math.max(elementCutoffMs, epochMsOf(o.omm));

  // ---- screening volume per object (SFS volume of its regime, at least the 5 km sphere) ----
  const hu = new Float64Array(N), hv = new Float64Array(N), hw = new Float64Array(N), hr = new Float64Array(N), volId = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const id = volumeIdFor(shapeFromOmm(objs[i]!.omm));
    volId[i] = id;
    const v = SFS_VOLUMES[id - 1]!;
    hu[i] = Math.max(v.u, sphereKm); hv[i] = Math.max(v.v, sphereKm); hw[i] = Math.max(v.w, sphereKm);
    hr[i] = halfDiagonal({ u: hu[i]!, v: hv[i]!, w: hw[i]! });
  }
  const { group, groups } = identicalGroups(objs);

  const stats = (x: Partial<ScreenStats> = {}): ScreenStats => ({
    objectsIn: catalog.length, objectsScreened: N, noEarlierSet: sel.noEarlierSet, fenced, unusable, garbage, identicalGroups: groups.length,
    objectsWithoutPartner: 0, candidateWindows: 0, formationPairs: 0, formationList: [], runs: 0, minima: 0, acceptedMinima: 0, evalFailed: 0, duplicatesDropped: 0,
    sgp4Calls: loadCalls, elementCutoffMs, hours, batchTimeMs: t0, durationS: secs(T0), maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), ...x,
  });
  if (N < 2) return { encounters: [], stats: stats() };

  const pool = new WorkerPool(workers);
  try {
    await pool.start({ type: 'init', objs, group, model });
    await pool.calls();

    // ---- 1. radius pass ----
    const rtasks: RadiusTask[] = [];
    for (let a = 0; a < N; a += 400) rtasks.push({ type: 'radius', o0: a, o1: Math.min(N, a + 400), t0Ms: t0, t1Ms: t1, padKm: 2 });
    const rout = await pool.map<Float64Array>(rtasks);
    const rlo = new Float64Array(N), rhi = new Float64Array(N), vmax = new Float64Array(N), omega = new Float64Array(N);
    for (let t = 0; t < rtasks.length; t++) {
      const f = rout[t]!, a = rtasks[t]!.o0;
      for (let k = 0; k < f.length / 6; k++) {
        const i = a + k;
        rlo[i] = f[6 * k]!; rhi[i] = f[6 * k + 1]!; vmax[i] = f[6 * k + 2]!;
        if (!(rlo[i]! > 0)) { rlo[i] = 0; rhi[i] = 1e9; vmax[i] = 20; }
        omega[i] = (1.05 * vmax[i]!) / Math.max(1, rlo[i]!) + 1e-5;
      }
    }
    let sgp4Total = loadCalls + (await pool.calls());

    // ---- 2. pre-filter on the measured radius ranges ----
    const Rmax = hr.reduce((m, x) => Math.max(m, x), 0);
    const all = shellCounts(rlo, rhi, Rmax);
    const noPartner = new Uint8Array(N);
    let removed = 0;
    for (let i = 0; i < N; i++) if (all.perObject[i]! - 1 <= 0) { noPartner[i] = 1; removed++; }

    // ---- bounds to the workers ----
    await pool.broadcast({ type: 'bounds', rlo, rhi, vmax, omega, hu, hv, hw, hr, volId, sphereKm });
    const active = (i: number) => !noPartner[i];

    // ---- 3. coarse pass ----
    const mkBound = (selIdx: number[], h: number) => {
      let hrMax = 0, rFloor = Infinity, omegaMax = 0;
      const sp: number[] = [];
      for (const i of selIdx) { hrMax = Math.max(hrMax, hr[i]!); rFloor = Math.min(rFloor, Math.max(6300, rlo[i]!)); omegaMax = Math.max(omegaMax, omega[i]!); sp.push(vmax[i]!); }
      sp.sort((a, b) => b - a);
      return { hrMax, rFloor, omegaMax, wMax: (sp[0] ?? 0) + (sp[1] ?? 0), ...solveCell({ hrMax, wMax: (sp[0] ?? 0) + (sp[1] ?? 0), rFloor, omegaMax, h }) };
    };
    const fastSel: number[] = [];
    for (let i = 0; i < N; i++) if (active(i)) fastSel.push(i);
    const dtF = dtS;
    if ((1800 % dtF) || (spanS % dtF)) throw new Error('step size must divide 1800 s and the window');
    const hotSel = hotVmax > 0 ? fastSel.filter((i) => vmax[i]! > hotVmax) : [];
    const bulkSel = hotVmax > 0 ? fastSel.filter((i) => vmax[i]! <= hotVmax) : fastSel;
    const bf = mkBound(bulkSel, dtF / 2);
    let hotInfo: { Lh: number; epsCapH: number; padCapH: number } | null = null;
    if (hotSel.length) {
      // a fast mover meets any object: its relative speed is at most its own top speed plus the fastest of all
      const vTop = fastSel.reduce((m, i) => Math.max(m, vmax[i]!), 0), vHot = hotSel.reduce((m, i) => Math.max(m, vmax[i]!), 0);
      const hb = solveCell({ hrMax: bf.hrMax, wMax: vTop + vHot, rFloor: Math.min(...fastSel.map((i) => Math.max(6300, rlo[i]!))), omegaMax: Math.max(...fastSel.map((i) => omega[i]!)), h: dtF / 2 });
      hotInfo = { Lh: hb.L, epsCapH: hb.epsCap, padCapH: hb.padCap };
    }
    const pass = { subset: Int32Array.from(fastSel), dtS: dtF, h: dtF / 2, L: bf.L, epsCap: bf.epsCap, padCap: bf.padCap, steps: spanS / dtF + 1 };
    const cand: Float64Array[] = [];
    const formArr: Int32Array[] = [];
    const SL = 12; // steps per task
    const tasks = [];
    const formEvery = 1800 / pass.dtS;
    for (let s = 0; s < pass.steps; s += SL) tasks.push({ type: 'coarse', s0: s, s1: Math.min(pass.steps, s + SL), t0Ms: t0, dtMs: pass.dtS * 1000, subset: pass.subset, L: pass.L, h: pass.h, epsCap: pass.epsCap, padCap: pass.padCap, formEvery, formKm: FORM_KM, ...(hotInfo ? { hot: Int32Array.from(hotSel), Lh: hotInfo.Lh, epsCapH: hotInfo.epsCapH, padCapH: hotInfo.padCapH } : {}) });
    for (const x of await pool.map<CoarseOut>(tasks)) { cand.push(x.cand); formArr.push(x.form); }
    sgp4Total += await pool.calls();

    // ---- 4. formation exclusion ----
    const formSet = new Set<number>();
    for (const f of formArr) for (let k = 0; k < f.length; k += 2) formSet.add(f[k]! * N + f[k + 1]!);
    const fp = new Int32Array(formSet.size * 2);
    let q = 0;
    for (const key of formSet) { fp[q++] = Math.floor(key / N); fp[q++] = key % N; }
    const ftasks = [];
    for (let p = 0; p < fp.length; p += 400 * 2) ftasks.push({ type: 'formFrac', pairs: fp.subarray(p, Math.min(fp.length, p + 400 * 2)), t0Ms: t0, t1Ms: t1, stepMs: 60_000, km: FORM_KM, stride: formStride });
    const fouts = await pool.map<Float64Array>(ftasks);
    const formation = new Set<number>();
    const formationList: ScreenStats['formationList'] = [];
    for (const f of fouts) for (let k = 0; k < f.length; k += 4) if (f[k + 2]! > FORM_FRAC) {
      formation.add(f[k]! * N + f[k + 1]!);
      const na = objs[f[k]!]!.noradId, nb = objs[f[k + 1]!]!.noradId;
      formationList.push([Math.min(na, nb), Math.max(na, nb), f[k + 2]!, f[k + 3]!]);
    }
    formationList.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    sgp4Total += await pool.calls();

    // ---- 5. candidate windows -> runs -> refinement ----
    const SBITS = 16384;
    const runs: number[] = [];
    let nWindows = 0;
    {
      let m = 0;
      for (const c of cand) m += c.length / 3;
      const keys = new Float64Array(m);
      let w = 0;
      for (const c of cand) for (let k = 0; k < c.length; k += 3) {
        const i = c[k]!, j = c[k + 1]!;
        if (formation.has(i * N + j)) continue;
        keys[w++] = (i * 65536 + j) * SBITS + c[k + 2]!;
      }
      const ks = keys.subarray(0, w).sort();
      nWindows = w;
      const subMs = Math.max(1000, (pass.dtS * 1000) / 6);
      let start = -1, last = -1, pair = -1;
      const flush = () => {
        if (start < 0) return;
        const i = Math.floor(pair / 65536), j = pair % 65536;
        runs.push(i, j, Math.max(t0, t0 + start * pass.dtS * 1000 - pass.h * 1000), Math.min(t1, t0 + last * pass.dtS * 1000 + pass.h * 1000), subMs);
      };
      for (let k = 0; k < ks.length; k++) {
        const key = ks[k]!, s = key % SBITS, pr = (key - s) / SBITS;
        if (pr === pair && s - last <= 1) { last = s; continue; }
        flush();
        pair = pr; start = s; last = s;
      }
      flush();
    }
    cand.length = 0;
    const nRuns = runs.length / 5;
    const rftasks = [];
    const RCH = 300;
    for (let p = 0; p < runs.length; p += 5 * RCH) rftasks.push({ type: 'refine6', runs: Float64Array.from(runs.slice(p, p + 5 * RCH)), pc: true });
    const rfouts = await pool.map<Refine6Out>(rftasks);
    let minima = 0, accepted = 0, evalFail = 0;
    const events: Encounter[] = [];
    for (const x of rfouts) { minima += x.minima; accepted += x.accepted; evalFail += x.evalFail; for (const e of x.events) events.push(e); }
    sgp4Total += await pool.calls();

    // ---- merge, dedupe ----
    events.sort((a, b) => a.noradA - b.noradA || a.noradB - b.noradB || a.tcaMs - b.tcaMs);
    const encounters: Encounter[] = [];
    let dup = 0;
    for (const e of events) {
      const l = encounters[encounters.length - 1];
      if (l && l.noradA === e.noradA && l.noradB === e.noradB && Math.abs(l.tcaMs - e.tcaMs) < 10_000) { dup++; continue; }
      encounters.push(e);
    }
    if (opts.recentJumps) for (const e of encounters) { e.manoeuvreAMs = opts.recentJumps.get(e.noradA) ?? null; e.manoeuvreBMs = opts.recentJumps.get(e.noradB) ?? null; }
    return { encounters, stats: stats({ objectsWithoutPartner: removed, candidateWindows: nWindows, formationPairs: formation.size, formationList, runs: nRuns, minima, acceptedMinima: accepted, evalFailed: evalFail, duplicatesDropped: dup, sgp4Calls: sgp4Total }) };
  } finally {
    await pool.close();
  }
}
