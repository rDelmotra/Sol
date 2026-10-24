// SPIKE — not production. U5 worker: for each object in its shard, propagate every older element set to the
// epoch of every newer set (gap 0.25..14 d) and record the offset in the newer set's RIC frame.
import { parentPort, workerData } from 'node:worker_threads';
import * as satellite from 'satellite.js';
import { ricBasis, toRic, type V3 } from '@orbitwatch/orbital-core';
import { makeProp } from './runs.js';
import { MIN_GAP_D, MAX_GAP_D, NCOL, FLAG_JUMP, FLAG_LOWRADIUS, FLAG_BADOBJ, FLAG_IDENTICAL, FLAG_HUGE, BAD_NORAD, T2_JUMP } from './uncertainty-lib.js';

interface ObjIn { idx: number; norad: number; identical: boolean; sets: Array<{ epochMs: number; day: number; omm: Record<string, unknown> }> }
const MU = 398600.4418;
const DAY = 86_400_000;
const sma = (omm: Record<string, unknown>) => Math.cbrt(MU / ((Number(omm.MEAN_MOTION) * 2 * Math.PI / 86400) ** 2));

const objs = workerData.objs as ObjIn[];
let buf = new Float32Array(1 << 20);
let n = 0;
const push = (row: number[]) => {
  if ((n + 1) * NCOL > buf.length) { const nb = new Float32Array(buf.length * 2); nb.set(buf); buf = nb; }
  buf.set(row, n * NCOL);
  n++;
};
let svFail = 0, setFail = 0, pairsSeen = 0;
for (const o of objs) {
  const props = o.sets.map((s) => makeProp(s.omm));
  // new-set state at its own epoch, computed once
  const st = o.sets.map((s, k) => {
    const p = props[k];
    if (!p) return null;
    const pv = satellite.sgp4(p.satrec, 0);
    if (!pv || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean' || !Number.isFinite(pv.position.x)) return null;
    return { r: [pv.position.x, pv.position.y, pv.position.z] as V3, v: [pv.velocity.x, pv.velocity.y, pv.velocity.z] as V3 };
  });
  setFail += st.filter((x) => !x).length;
  for (let j = 0; j < o.sets.length; j++) {
    const nj = st[j];
    for (let i = 0; i < j; i++) {
      const gap = (o.sets[j]!.epochMs - o.sets[i]!.epochMs) / DAY;
      if (gap > MAX_GAP_D) continue;
      if (gap < MIN_GAP_D) continue;
      pairsSeen++;
      const pi = props[i];
      if (!pi || !nj) { svFail++; continue; }
      const pv = satellite.sgp4(pi.satrec, (o.sets[j]!.epochMs - pi.epochMs) / 60_000);
      if (!pv || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean' || !Number.isFinite(pv.position.x) || !Number.isFinite(pv.velocity.x)) { svFail++; continue; }
      const d: V3 = [pv.position.x - nj.r[0], pv.position.y - nj.r[1], pv.position.z - nj.r[2]];
      const dv: V3 = [pv.velocity.x - nj.v[0], pv.velocity.y - nj.v[1], pv.velocity.z - nj.v[2]];
      const b = ricBasis(nj.r, nj.v);
      if (!b) { svFail++; continue; }
      const ric = toRic(d, b), vric = toRic(dv, b);
      let flags = 0;
      const rOld = Math.hypot(pv.position.x, pv.position.y, pv.position.z), rNew = Math.hypot(...nj.r);
      if (rOld < 6400 || rNew < 6400) flags |= FLAG_LOWRADIUS;
      if (Math.hypot(...d) > 100_000) flags |= FLAG_HUGE;
      if (o.norad === BAD_NORAD) flags |= FLAG_BADOBJ;
      if (o.identical) flags |= FLAG_IDENTICAL;
      // T2 manoeuvre rule: dpos > 16.3 km AND |da| > 1 km AND |da - drag| > 1 km
      const a0 = sma(o.sets[i]!.omm), a1 = sma(o.sets[j]!.omm);
      const da = a1 - a0;
      const n0 = Number(o.sets[i]!.omm.MEAN_MOTION);
      const resid = da + (2 / 3) * (a0 / n0) * (2 * Number(o.sets[i]!.omm.MEAN_MOTION_DOT) * gap);
      if (Math.hypot(...d) > T2_JUMP.dposKm && Math.abs(da) > T2_JUMP.daKm && Math.abs(resid) > T2_JUMP.residKm) flags |= FLAG_JUMP;
      push([o.idx, gap, o.sets[j]!.day, ric[0], ric[1], ric[2], vric[0], vric[1], vric[2], flags, rNew]);
    }
  }
}
const out = buf.slice(0, n * NCOL);
parentPort!.postMessage({ out, n, svFail, setFail, pairsSeen }, [out.buffer]);
