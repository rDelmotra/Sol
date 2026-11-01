// ============================================================
// Ground region -> STAR-MAP cell cover, per time slice. Ported from scripts/starmap/coverage-cover.ts (frozen spike), extended to
// circles, with a faster sampling loop (same arithmetic, hoisted per pixel instead of per sample).
//
// A ground place is fixed on the rotating Earth, so in the star map (TEME) it sweeps one full turn around the polar axis every
// sidereal day. To ask "who was over the region during period P" against star-map lists we need every star cell that the volume above
// the region touches at ANY instant of P.
//
// Method (conservative; a miss is impossible up to the stated paddings):
//  1. A star cell = (HEALPix pixel direction at order o) x (log-radius shell). The volume above a region is a RADIAL COLUMN: its
//     directions are the region's directions, its radii all shells (every height). Rotation about the polar axis does not change the
//     radius, so  cover(P) = { pixels hit by the rotating region during P }  x  { all shells in the height range }.
//  2. The pixels are found at the instants t_k (spacing dt, ends of P included): take every order-(o+3) "child" pixel centre in a
//     latitude band, rotate it into the Earth frame (longitude = phi - gmst(t_k); latitude is unchanged by the rotation), and keep its
//     parent pixel if it falls inside the region DILATED by the padding. The padding covers one child pixel (centre to corner), half a
//     time step of rotation, the 0.2 degree geodetic-vs-geocentric latitude difference, and the raster (0.1 degree) of the mask.
//     Polygons use the spike's plain-plane padding rho = 1.4 * 2 * w + 0.35 (1.4 = 1/cos(lat) headroom up to ~45 degrees); circles
//     use an angular (great-circle) padding 3 * w + 0.35, which needs no latitude headroom.
//  3. Heights: all shells from the bottom of the star map up to the highest radius in the data (the layer manifest records it).
// cover.test.ts checks conservativeness with randomized points (below ground to 60,000 km, any instant, polygon edges), for polygons
// and circles (also across the antimeridian).
// ============================================================
import { cellKey, pix2angNest, gmst, DEG, RAD, WGS84_A_KM, SHELL_DELTA0, radialIndex } from '@orbitwatch/orbital-core';
import { R_MIN_KM, PERIOD_MS, PER_DAY, type Gran } from './consts.js';
import { havKm, inPoly, distToPolyEdges, KM_PER_DEG, polyBounds, type Region } from './region.js';

const EARTH_ROT_DEG_PER_S = 360.98564736629 / 86400;
const MASK_RES = 0.1; // deg
const GEODETIC_PAD_DEG = 0.2;

interface Tables {
  rhoDeg: number;
  dtMs: number;
  /** per fine pixel in the latitude band: mask row offset, longitude (deg, Earth-fixed at gmst 0), parent pixel */
  rowBase: Int32Array;
  lon0: Float64Array;
  parent: Int32Array;
  mask: Uint8Array; lonLo: number; nLon: number;
  wraps: boolean;
}
const cache = new Map<string, Tables>();

function tables(order: number, region: Region): Tables {
  const ck = `${order}:${region.id}`;
  const hit = cache.get(ck); if (hit) return hit;
  const fineOrder = order + 3;
  const wFine = Math.sqrt((4 * Math.PI) / (12 * 4 ** fineOrder)) * DEG;
  const dtMs = Math.max(1000, Math.floor((2 * wFine) / EARTH_ROT_DEG_PER_S) * 1000);
  let rhoDeg: number, latLo: number, latHi: number, lonLo: number, lonHi: number;
  let inside: (lat: number, lon: number) => boolean;
  if (region.kind === 'polygon') {
    rhoDeg = 1.4 * 2 * wFine + GEODETIC_PAD_DEG + MASK_RES * 1.5;
    const b = polyBounds(region);
    latLo = b.latMin - rhoDeg - 1; latHi = b.latMax + rhoDeg + 1; lonLo = b.lonMin - rhoDeg - 1; lonHi = b.lonMax + rhoDeg + 1;
    const poly = region.poly;
    inside = (lat, lon) => inPoly(lat, lon, poly) || distToPolyEdges(lat, lon, poly) <= rhoDeg - MASK_RES * 0.75;
  } else {
    rhoDeg = 3 * wFine + GEODETIC_PAD_DEG + MASK_RES * 1.5;
    const reach = region.radiusKm / KM_PER_DEG + rhoDeg;
    latLo = region.latDeg - reach - 1; latHi = Math.min(90, region.latDeg + reach + 1);
    const ext = Math.asin(Math.min(1, Math.sin(reach * RAD) / Math.cos(region.latDeg * RAD))) * DEG + 1;
    lonLo = region.lonDeg - ext; lonHi = region.lonDeg + ext;
    const limKm = region.radiusKm + rhoDeg * KM_PER_DEG;
    inside = (lat, lon) => havKm(lat, lon, region.latDeg, region.lonDeg) <= limKm;
  }
  const nLat = Math.ceil((latHi - latLo) / MASK_RES), nLon = Math.ceil((lonHi - lonLo) / MASK_RES);
  const mask = new Uint8Array(nLat * nLon);
  for (let i = 0; i < nLat; i++) {
    const lat = latLo + (i + 0.5) * MASK_RES;
    for (let j = 0; j < nLon; j++) if (inside(lat, lonLo + (j + 0.5) * MASK_RES)) mask[i * nLon + j] = 1;
  }
  // fine pixels whose centre latitude is inside the (padded) band; the rotation never changes latitude
  const sLo = Math.sin((latLo - 1) * RAD), sHi = Math.sin((latHi + 1) * RAD);
  const rowBase: number[] = [], lon0: number[] = [], par: number[] = [];
  const nFine = 12 * 4 ** fineOrder;
  for (let f = 0; f < nFine; f++) {
    const { z, phi } = pix2angNest(fineOrder, f);
    if (z < sLo || z > sHi) continue;
    const i = Math.floor((Math.asin(z) * DEG - latLo) / MASK_RES);
    if (i < 0 || i >= nLat) continue;
    rowBase.push(i * nLon); lon0.push(phi * DEG); par.push(Math.floor(f / 64));
  }
  const t: Tables = {
    rhoDeg, dtMs, rowBase: Int32Array.from(rowBase), lon0: Float64Array.from(lon0), parent: Int32Array.from(par),
    mask, lonLo, nLon, wraps: lonLo < -180 || lonHi > 180,
  };
  cache.set(ck, t);
  return t;
}

/** Pixels (order `order`) hit by the rotating region during [aMs, bMs], marked into `marks` (length 12*4^order). */
function samplePeriod(T: Tables, aMs: number, bMs: number, marks: Uint8Array): void {
  const n = Math.max(1, Math.ceil((bMs - aMs) / T.dtMs));
  const { rowBase, lon0, parent, mask, lonLo, nLon } = T;
  const inv = 1 / MASK_RES;
  for (let k = 0; k <= n; k++) {
    const t = Math.min(aMs + k * T.dtMs, bMs);
    const th = gmst(t) * DEG;
    for (let q = 0, m = parent.length; q < m; q++) {
      let lon = lon0[q]! - th;
      lon -= 360 * Math.floor((lon + 180) / 360); // [-180, 180)
      let j = Math.floor((lon - lonLo) * inv);
      if (j >= 0 && j < nLon && mask[rowBase[q]! + j]) { marks[parent[q]!] = 1; continue; }
      if (T.wraps) {
        j = Math.floor((lon + 360 - lonLo) * inv);
        if (j >= 0 && j < nLon && mask[rowBase[q]! + j]) { marks[parent[q]!] = 1; continue; }
        j = Math.floor((lon - 360 - lonLo) * inv);
        if (j >= 0 && j < nLon && mask[rowBase[q]! + j]) marks[parent[q]!] = 1;
      }
    }
    if (t >= bMs) break;
  }
}

/**
 * Star pixels at `order` touched by the (padded) region in each period of the UTC day starting at dayStartMs
 * (1 array for 'day', 24 for 'hour'), ascending.
 */
export function coverPixels(order: number, region: Region, dayStartMs: number, gran: Gran): Int32Array[] {
  const T = tables(order, region);
  const out: Int32Array[] = [];
  const marks = new Uint8Array(12 * 4 ** order);
  const per = PERIOD_MS[gran];
  for (let p = 0; p < PER_DAY[gran]; p++) {
    marks.fill(0);
    samplePeriod(T, dayStartMs + p * per, dayStartMs + (p + 1) * per, marks);
    const list: number[] = [];
    for (let i = 0; i < marks.length; i++) if (marks[i]) list.push(i);
    out.push(Int32Array.from(list));
  }
  return out;
}

/** Shell index range [lo, hi] at `order` for radii [rLoKm, rHiKm]. */
export function shellRange(order: number, rLoKm: number, rHiKm: number): [number, number] {
  const lo = radialIndex(order, Math.max(rLoKm, R_MIN_KM)), hi = radialIndex(order, rHiKm);
  if (lo === null || hi === null) throw new RangeError('shellRange: radius outside the star-map range');
  return [lo, hi];
}

const keyCache = new Map<number, Map<number, number>>();
/** Star cell key for pixel `pix` and shell `nk` at `order`. */
export function pixelShellKey(order: number, pix: number, nk: number): number {
  let m = keyCache.get(order); if (!m) { m = new Map(); keyCache.set(order, m); }
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
