// ============================================================
// SPIKE — not production. Ground region -> STAR-MAP cell cover, per time slice.
//
// A ground place (India) is fixed on the rotating Earth, so in the star map (TEME) it sweeps one full
// turn around the polar axis every sidereal day. To ask "who was over India during period P" against
// star-map summaries we need every star cell that the volume above India touches at ANY instant of P.
//
// Method (conservative, derived so that a miss is impossible up to the stated paddings):
//  1. A star cell = (HEALPix pixel direction at order o) x (log-radius shell). The ground volume above a
//     polygon is a RADIAL COLUMN: its directions are the polygon's directions, its radii are all shells
//     (every height). Rotation about the polar axis does not change the radius, so
//          cover(P) = { pixels hit by the rotating polygon during P }  x  { all shells in the height range }.
//  2. The pixels are found at the instants t_k (spacing dt, ends of P included): take every order-(o+3)
//     "child" pixel centre in a latitude band, rotate it into the Earth frame by gmst(t_k), and keep its
//     parent pixel if it falls inside the polygon DILATED by rho. rho covers: one child pixel (the point
//     may sit anywhere in a child, centre-to-corner), half a time step of rotation, the 0.2 deg
//     geodetic-vs-geocentric latitude difference, and the raster used for the dilated mask. Any point of
//     the true volume at any instant then lies within rho of a child centre of its own pixel at the nearest
//     sample, so its pixel is kept.
//  3. Heights: all shells from the bottom of the star map up to the highest radius in the data.
// A randomized-point unit test (coverage-cover.test.ts) checks the result is conservative.
// ============================================================
import { cellKey, pix2angNest, ang2pixNest, gmst, DEG, RAD, WGS84_A_KM, SHELL_DELTA0, radialIndex } from '@orbitwatch/orbital-core';
import { INDIA_POLY, POLY_LAT_MIN, POLY_LAT_MAX, POLY_LON_MIN, POLY_LON_MAX, inPoly, distToPolyEdges, R_MIN_KM, type Gran } from './coverage-lib.js';

const EARTH_ROT_DEG_PER_S = 360.98564736629 / 86400;
const MASK_RES = 0.1; // deg
const GEODETIC_PAD_DEG = 0.2;

interface OrderTables {
  order: number;
  rhoDeg: number;
  dtMs: number;
  fineDirs: Float64Array; // x,y,z per fine pixel in the latitude band
  fineParent: Int32Array;
  mask: Uint8Array; maskLat0: number; maskLon0: number; maskNLat: number; maskNLon: number;
}
const cache = new Map<string, OrderTables>();

function tables(order: number, poly: Array<[number, number]>): OrderTables {
  const ck = `${order}:${poly.length}:${poly[0]![0]}`;
  const hit = cache.get(ck); if (hit) return hit;
  const fineOrder = order + 3;
  const wFine = Math.sqrt((4 * Math.PI) / (12 * 4 ** fineOrder)) * DEG;
  // 1.4 = 1/cos(lat) headroom for longitude differences up to ~45 deg latitude (plain lat/lon plane distance)
  const rhoDeg = 1.4 * 2 * wFine + GEODETIC_PAD_DEG + MASK_RES * 1.5;
  const dtMs = Math.max(1000, Math.floor((2 * wFine) / EARTH_ROT_DEG_PER_S) * 1000);
  const latLo = Math.min(...poly.map((v) => v[0])) - rhoDeg - 1, latHi = Math.max(...poly.map((v) => v[0])) + rhoDeg + 1;
  const lonLo = Math.min(...poly.map((v) => v[1])) - rhoDeg - 1, lonHi = Math.max(...poly.map((v) => v[1])) + rhoDeg + 1;
  const nLat = Math.ceil((latHi - latLo) / MASK_RES), nLon = Math.ceil((lonHi - lonLo) / MASK_RES);
  const mask = new Uint8Array(nLat * nLon);
  for (let i = 0; i < nLat; i++) {
    const lat = latLo + (i + 0.5) * MASK_RES;
    for (let j = 0; j < nLon; j++) {
      const lon = lonLo + (j + 0.5) * MASK_RES;
      if (inPoly(lat, lon, poly) || distToPolyEdges(lat, lon, poly) <= rhoDeg - MASK_RES * 0.75) mask[i * nLon + j] = 1;
    }
  }
  // fine pixels whose centre latitude is inside the (padded) band; the rotation never changes latitude
  const sLo = Math.sin((latLo - 1) * RAD), sHi = Math.sin((latHi + 1) * RAD);
  const dirs: number[] = [], par: number[] = [];
  const nFine = 12 * 4 ** fineOrder;
  for (let f = 0; f < nFine; f++) {
    const { z, phi } = pix2angNest(fineOrder, f);
    if (z < sLo || z > sHi) continue;
    const s = Math.sqrt(1 - z * z);
    dirs.push(s * Math.cos(phi), s * Math.sin(phi), z);
    par.push(Math.floor(f / 64));
  }
  const t: OrderTables = {
    order, rhoDeg, dtMs, fineDirs: Float64Array.from(dirs), fineParent: Int32Array.from(par),
    mask, maskLat0: latLo, maskLon0: lonLo, maskNLat: nLat, maskNLon: nLon,
  };
  cache.set(ck, t);
  return t;
}

/** Pixels (order `order`) hit by the rotating polygon during [aMs, bMs], marked into `marks` (length 12*4^order). */
function samplePeriod(T: OrderTables, aMs: number, bMs: number, marks: Uint8Array): void {
  const n = Math.max(1, Math.ceil((bMs - aMs) / T.dtMs));
  const d = T.fineDirs, par = T.fineParent;
  for (let k = 0; k <= n; k++) {
    const t = Math.min(aMs + k * T.dtMs, bMs);
    const th = gmst(t), c = Math.cos(th), s = Math.sin(th);
    for (let q = 0, m = par.length; q < m; q++) {
      const x = d[3 * q]!, y = d[3 * q + 1]!, z = d[3 * q + 2]!;
      // TEME -> ECEF: rotate by -theta
      const ex = c * x + s * y, ey = -s * x + c * y;
      const lat = Math.asin(z) * DEG;
      const lon = Math.atan2(ey, ex) * DEG;
      const i = Math.floor((lat - T.maskLat0) / MASK_RES);
      if (i < 0 || i >= T.maskNLat) continue;
      const j = Math.floor((lon - T.maskLon0) / MASK_RES);
      if (j < 0 || j >= T.maskNLon) continue;
      if (T.mask[i * T.maskNLon + j]) marks[par[q]!] = 1;
    }
    if (t >= bMs) break;
  }
}

/**
 * Star pixels at `order` touched by the (padded) polygon in each 10-minute slice of the UTC day starting
 * at dayStartMs: 144 arrays.
 */
export function polygonPixelsByTenMin(order: number, dayStartMs: number, poly: Array<[number, number]> = INDIA_POLY): Int32Array[] {
  const T = tables(order, poly);
  const out: Int32Array[] = [];
  const marks = new Uint8Array(12 * 4 ** order);
  for (let p = 0; p < 144; p++) {
    marks.fill(0);
    samplePeriod(T, dayStartMs + p * 600_000, dayStartMs + (p + 1) * 600_000, marks);
    const list: number[] = [];
    for (let i = 0; i < marks.length; i++) if (marks[i]) list.push(i);
    out.push(Int32Array.from(list));
  }
  return out;
}

/** Union of the 144 ten-minute pixel sets into the periods of a granularity. */
export function groupPixels(tenMin: Int32Array[], gran: Gran): Int32Array[] {
  const per = 144 / gran.perDay;
  const out: Int32Array[] = [];
  for (let g = 0; g < gran.perDay; g++) {
    const s = new Set<number>();
    for (let p = g * per; p < (g + 1) * per; p++) for (const v of tenMin[p]!) s.add(v);
    out.push(Int32Array.from([...s].sort((a, b) => a - b)));
  }
  return out;
}

/** Shell index range [lo, hi] at `order` for radii [rLoKm, rHiKm]. */
export function shellRange(order: number, rLoKm: number, rHiKm: number): [number, number] {
  const lo = radialIndex(order, Math.max(rLoKm, R_MIN_KM)), hi = radialIndex(order, rHiKm);
  if (lo === null || hi === null) throw new RangeError('shellRange: radius outside the star-map range');
  return [lo, hi];
}

const keyCache = new Map<string, Map<number, number>>();
/** Star cell key for pixel `pix` and shell `nk` at `order`. */
export function pixelShellKey(order: number, pix: number, nk: number): number {
  let m = keyCache.get(String(order)); if (!m) { m = new Map(); keyCache.set(String(order), m); }
  const ck = pix * 4096 + (nk + 2048);
  const hit = m.get(ck); if (hit !== undefined) return hit;
  const { z, phi } = pix2angNest(order, pix);
  const s = Math.sqrt(1 - z * z);
  const r = WGS84_A_KM * Math.exp(((nk + 0.5) * SHELL_DELTA0) / 2 ** order);
  const k = cellKey(order, r * s * Math.cos(phi), r * s * Math.sin(phi), r * z);
  if (k === null) throw new RangeError('pixelShellKey: out of range');
  m.set(ck, k);
  return k;
}

/** All cell keys of (pixels x shells[nkLo..nkHi]). */
export function cellsOf(order: number, pixels: Int32Array, nkLo: number, nkHi: number): number[] {
  const out: number[] = [];
  for (const p of pixels) for (let nk = nkLo; nk <= nkHi; nk++) out.push(pixelShellKey(order, p, nk));
  return out;
}

export { ang2pixNest, POLY_LAT_MIN, POLY_LAT_MAX, POLY_LON_MIN, POLY_LON_MAX };
