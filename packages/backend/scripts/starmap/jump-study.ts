// SPIKE — not production. Is a big element jump a manoeuvre or just drag? Adds a drag-corrected semi-major-axis change.
//   npx tsx packages/backend/scripts/starmap/jump-study.ts
import { contiguousDays, prevDay, loadDayCatalog, jumpMetric, semiMajorKm, type CatFull } from './events.js';

const days = contiguousDays();
const q = (a: number[], p: number) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))]! : NaN;
interface R { day: string; id: number; name: string; reg: string; dpos: number; da: number; resid: number; gap: number; ndotA: number; perigee: number }
const all: R[] = [];
let prev = loadDayCatalog(days[0]!);
for (const day of days.slice(1)) {
  const cur = loadDayCatalog(day);
  const pm = new Map(prev.map((o) => [o.noradId, o]));
  for (const o of cur) {
    const p0 = pm.get(o.noradId);
    if (!p0 || String(p0.omm.EPOCH) === String(o.omm.EPOCH)) continue;
    const m = jumpMetric(p0 as CatFull, o as CatFull);
    if (!m) continue;
    // expected drag change in a over the gap from the old set's own rate (OMM MEAN_MOTION_DOT is ndot/2, rev/day^2)
    const n0 = Number(p0.omm.MEAN_MOTION), ndot = 2 * Number(p0.omm.MEAN_MOTION_DOT), a0 = semiMajorKm(p0.omm);
    const dn = ndot * m.gapDays + 0.5 * 0; // rev/day change over the gap
    const daExp = -(2 / 3) * (a0 / n0) * dn;
    all.push({ day, id: o.noradId, name: o.name, reg: o.regime, dpos: m.dposKm, da: m.daKm, resid: m.daKm - daExp, gap: m.gapDays, ndotA: ndot, perigee: o.perigee ?? NaN });
  }
  prev = cur;
}
console.log('changed element sets:', all.length);
for (const reg of ['LEO', 'MEO', 'GEO', 'HEO']) {
  const s = all.filter((r) => r.reg === reg);
  const ra = s.map((r) => Math.abs(r.resid)).sort((a, b) => a - b), da = s.map((r) => Math.abs(r.da)).sort((a, b) => a - b), dp = s.map((r) => r.dpos).sort((a, b) => a - b);
  console.log(reg, 'n', s.length, '| dpos p50/p90/p99', [.5, .9, .99].map((p) => q(dp, p).toFixed(2)).join('/'), '| |da| p50/p90/p99', [.5, .9, .99].map((p) => q(da, p).toFixed(3)).join('/'), '| |da - drag| p50/p90/p99', [.5, .9, .99].map((p) => q(ra, p).toFixed(3)).join('/'));
}
const cand = all.filter((r) => r.dpos > 16.3 && Math.abs(r.da) > 1);
console.log(`Mac rule (dpos>16.3 km and |da|>1 km): ${cand.length} in ${days.length - 1} days = ${(cand.length / (days.length - 1)).toFixed(0)}/day`);
const dragLike = cand.filter((r) => r.da < 0 && Math.abs(r.resid) < 1);
console.log(`  of those, lowering and explained by drag (|da - drag| < 1 km): ${dragLike.length} (${(100 * dragLike.length / cand.length).toFixed(0)}%)`);
console.log(`  raising (da > 0, drag cannot do that): ${cand.filter((r) => r.da > 0).length}; lowering beyond drag: ${cand.filter((r) => r.da < 0 && Math.abs(r.resid) >= 1).length}`);
const reg = (r: R) => (/STARLINK/.test(r.name) ? 'STARLINK' : r.reg);
const by = new Map<string, number>(); for (const r of cand) by.set(reg(r), (by.get(reg(r)) ?? 0) + 1);
console.log('  by group:', JSON.stringify([...by]));
// stricter: residual after drag
for (const t of [0.5, 1, 2, 5]) {
  const c2 = all.filter((r) => Math.abs(r.resid) > t && r.dpos > 16.3);
  console.log(`rule: |da - drag| > ${t} km and dpos > 16.3: ${c2.length} = ${(c2.length / (days.length - 1)).toFixed(0)}/day (raise ${c2.filter((r) => r.da > 0).length}, lower ${c2.filter((r) => r.da < 0).length}, starlink ${c2.filter((r) => /STARLINK/.test(r.name)).length})`);
}
console.log('top 12 by |da|, dpos>16.3:'); 
for (const r of [...cand].sort((a, b) => Math.abs(b.da) - Math.abs(a.da)).slice(0, 12)) console.log(`  ${r.day} ${r.id} ${r.name} ${r.reg} da=${r.da.toFixed(2)} resid=${r.resid.toFixed(2)} dpos=${r.dpos.toFixed(0)} gap=${r.gap.toFixed(2)} perigee=${r.perigee}`);
console.log('ISS 25544:'); for (const r of all.filter((x) => x.id === 25544 && Math.abs(x.da) > 0.3)) console.log(`  ${r.day} da=${r.da.toFixed(3)} resid=${r.resid.toFixed(3)} dpos=${r.dpos.toFixed(1)} gap=${r.gap.toFixed(2)}`);
const sl = all.filter((r) => /STARLINK/.test(r.name) && r.reg === 'LEO');
const slBig = sl.filter((r) => r.dpos > 16.3 && Math.abs(r.da) > 1);
console.log(`Starlink: ${sl.length} element updates, ${slBig.length} pass the rule (${(100 * slBig.length / sl.length).toFixed(1)}%); raise ${slBig.filter((r) => r.da > 0).length}, lower ${slBig.filter((r) => r.da < 0).length}`);
