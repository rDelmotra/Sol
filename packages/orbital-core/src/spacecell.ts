// ============================================================
// SpaceCell — a numbered 3D octree of space around Earth.
//
// Direction = HEALPix NESTED pixel (Gorski et al. 2005, 12·4^k equal-area
// pixels at order k); radius = log-spaced shells of ratio exp(Δ0/2^k) with
// Δ0 = sqrt(π/3), so cells are roughly cubic at every order. Direction and
// radius refine together, bit-interleaved: every cell has 8 children
// (key*8 + c, c = 0..7) and parent floor(key/8).
//
// FRAME-AGNOSTIC: x,y,z are km in any Earth-centred Cartesian frame; the caller
// tags the frame (SpaceFrame is documentation only, never packed into keys).
// Intended use: index satellite TEME positions (a star-fixed frame) by cell.
//
// Keys are JS numbers (exact up to 2^53 → order ≤ 15, 7 + 3k bits). Arithmetic
// (not 32-bit bitwise ops) is used wherever values can exceed 2^31. For storage
// every cell maps to an int8 range at MAX_ORDER (see keyRangeAtMaxOrder).
//
// Out-of-range radii (r < a·e^-Δ0 or r ≥ a·e^(7Δ0), i.e. below ~2,300 km or
// above ~8.2 million km geocentric) yield `null` — encoders never throw.
// ============================================================

import { WGS84_A_KM } from './earth.js';

/** Documentation-only tag for the frame a position is expressed in. */
export type SpaceFrame = 'TEME' | 'ECEF' | 'J2000';

/** Highest HEALPix order supported (12·4^18 ≈ 8.2e11 < 2^53). */
export const MAX_ORDER = 18;
/** Highest order whose key fits a JS number exactly (7 + 3k ≤ 52). */
export const MAX_KEY_ORDER = 15;
/** Base shell log-width Δ0 = sqrt(π/3): makes a cell ≈ cube at every order. */
export const SHELL_DELTA0 = Math.sqrt(Math.PI / 3);

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;
const TWO_THIRDS = 2 / 3;

function checkOrder(order: number, max: number): void {
  if (!Number.isInteger(order) || order < 0 || order > max) {
    throw new RangeError(`spacecell: order ${order} outside 0..${max}`);
  }
}

// ------------------------------------------------------------
// Bit interleave (x → even bits, y → odd bits) for values < 2^18.
// ------------------------------------------------------------

function spread16(v: number): number {
  v &= 0xffff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  v = (v | (v << 1)) & 0x55555555;
  return v >>> 0;
}

function compact16(v: number): number {
  v &= 0x55555555;
  v = (v | (v >>> 1)) & 0x33333333;
  v = (v | (v >>> 2)) & 0x0f0f0f0f;
  v = (v | (v >>> 4)) & 0x00ff00ff;
  v = (v | (v >>> 8)) & 0x0000ffff;
  return v >>> 0;
}

/** Spread a value < 2^18 into even bit positions (result < 2^36). */
function spread(v: number): number {
  return spread16(v % 512) + spread16(Math.floor(v / 512)) * 262144; // 2^18
}

/** Inverse of spread for a value < 2^36. */
function compact(v: number): number {
  const lo = v % 262144;
  const hi = Math.floor(v / 262144);
  return compact16(lo) + compact16(hi) * 512;
}

function xyf2nest(order: number, ix: number, iy: number, face: number): number {
  return face * 4 ** order + spread(ix) + 2 * spread(iy);
}

// ------------------------------------------------------------
// HEALPix NESTED
// ------------------------------------------------------------

const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

/** HEALPix NESTED pixel of direction (z = cos colatitude, phi = longitude/RA, rad). */
export function ang2pixNest(order: number, z: number, phi: number): number {
  checkOrder(order, MAX_ORDER);
  const nside = 2 ** order;
  if (z > 1) z = 1;
  else if (z < -1) z = -1;
  const za = Math.abs(z);
  let tt = phi / HALF_PI;
  tt -= 4 * Math.floor(tt / 4);
  if (!(tt >= 0) || tt >= 4) tt = 0; // also guards NaN

  let face: number;
  let ix: number;
  let iy: number;
  if (za <= TWO_THIRDS) {
    const temp1 = nside * (0.5 + tt);
    const temp2 = nside * z * 0.75;
    const jp = Math.floor(temp1 - temp2);
    const jm = Math.floor(temp1 + temp2);
    const ifp = Math.floor(jp / nside);
    const ifm = Math.floor(jm / nside);
    // ifp|4 with ifp===ifm in 0..4 (bitwise OK: tiny ints)
    face = ifp === ifm ? ifp | 4 : ifp < ifm ? ifp : ifm + 8;
    ix = jm % nside;
    iy = nside - (jp % nside) - 1;
  } else {
    const ntt = Math.min(Math.floor(tt), 3);
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(Math.floor(tp * tmp), nside - 1);
    const jm = Math.min(Math.floor((1 - tp) * tmp), nside - 1);
    if (z >= 0) {
      face = ntt;
      ix = nside - jm - 1;
      iy = nside - jp - 1;
    } else {
      face = ntt + 8;
      ix = jp;
      iy = jm;
    }
  }
  return xyf2nest(order, ix, iy, face);
}

/** Centre {z = cos colatitude, phi in [0,2π)} of a HEALPix NESTED pixel. */
export function pix2angNest(order: number, ipix: number): { z: number; phi: number } {
  checkOrder(order, MAX_ORDER);
  const nside = 2 ** order;
  const npface = 4 ** order;
  if (!Number.isInteger(ipix) || ipix < 0 || ipix >= 12 * npface) {
    throw new RangeError(`spacecell: pixel ${ipix} outside order ${order}`);
  }
  const face = Math.floor(ipix / npface);
  const local = ipix - face * npface;
  const ix = compact(local);
  const iy = compact(Math.floor(local / 2));

  const jr = JRLL[face]! * nside - ix - iy - 1;
  let nr: number;
  let z: number;
  let kshift: number;
  if (jr < nside) {
    nr = jr;
    z = 1 - (nr * nr) / (3 * nside * nside);
    kshift = 0;
  } else if (jr > 3 * nside) {
    nr = 4 * nside - jr;
    z = (nr * nr) / (3 * nside * nside) - 1;
    kshift = 0;
  } else {
    nr = nside;
    z = ((2 * nside - jr) * 2) / (3 * nside);
    kshift = (jr - nside) & 1;
  }
  let jp = Math.trunc((JPLL[face]! * nr + ix - iy + 1 + kshift) / 2);
  if (jp > 4 * nside) jp -= 4 * nside;
  if (jp < 1) jp += 4 * nside;
  const phi = ((jp - (kshift + 1) * 0.5) * HALF_PI) / nr;
  return { z, phi: phi >= TWO_PI ? phi - TWO_PI : phi };
}

// ------------------------------------------------------------
// Radial shells
// ------------------------------------------------------------

/**
 * Radial shell index n_k = floor(ln(r/a)·2^k/Δ0), or null if the base shell
 * n_0 is outside -1..6 (or r is not a positive finite number).
 */
export function radialIndex(order: number, rKm: number): number | null {
  checkOrder(order, MAX_ORDER);
  if (!(rKm > 0) || !Number.isFinite(rKm)) return null;
  const L = Math.log(rKm / WGS84_A_KM);
  const nk = Math.floor((L * 2 ** order) / SHELL_DELTA0);
  const n0 = Math.floor(nk / 2 ** order);
  if (n0 < -1 || n0 > 6) return null;
  return nk;
}

// ------------------------------------------------------------
// Keys
// ------------------------------------------------------------

/** Octree key of the cell containing (x,y,z) km at `order` (0..15), or null if out of radial range. */
export function cellKey(order: number, x: number, y: number, z: number): number | null {
  checkOrder(order, MAX_KEY_ORDER);
  const r = Math.sqrt(x * x + y * y + z * z);
  const nk = radialIndex(order, r);
  if (nk === null) return null;
  const pix = ang2pixNest(order, z / r, Math.atan2(y, x));
  const span = 2 ** order;
  const n0 = Math.floor(nk / span);
  const rad = nk - n0 * span;
  const npface = 4 ** order;
  const base = Math.floor(pix / npface);
  const sub = pix - base * npface;
  let key = base * 8 + (n0 + 1);
  for (let i = 1; i <= order; i++) {
    const digit = Math.floor(sub / 4 ** (order - i)) % 4;
    const bit = Math.floor(rad / 2 ** (order - i)) % 2;
    key = key * 8 + digit * 2 + bit;
  }
  return key;
}

/** Parent cell key (one order coarser). */
export function parentKey(key: number): number {
  return Math.floor(key / 8);
}

/** The 8 child cell keys (one order finer). */
export function childKeys(key: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < 8; c++) out.push(key * 8 + c);
  return out;
}

/** Split a key into HEALPix base face, nested pixel and radial index n_k. */
export function decodeKey(order: number, key: number): { base: number; pix: number; nk: number } {
  checkOrder(order, MAX_KEY_ORDER);
  let k = key;
  let sub = 0;
  let rad = 0;
  for (let i = 0; i < order; i++) {
    const g = k % 8;
    k = Math.floor(k / 8);
    sub += (g >> 1) * 4 ** i;
    rad += (g & 1) * 2 ** i;
  }
  const s0 = k % 8;
  const base = Math.floor(k / 8);
  return { base, pix: base * 4 ** order + sub, nk: (s0 - 1) * 2 ** order + rad };
}

/** Centre of a cell (km, same frame as the encoded positions): pixel centre direction, mid-shell radius. */
export function cellCentre(order: number, key: number): { x: number; y: number; z: number } {
  const { pix, nk } = decodeKey(order, key);
  const { z, phi } = pix2angNest(order, pix);
  const r = WGS84_A_KM * Math.exp(((nk + 0.5) * SHELL_DELTA0) / 2 ** order);
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: r * s * Math.cos(phi), y: r * s * Math.sin(phi), z: r * z };
}

/** Approximate cell edge length (km) at radius r: r·Δ0/2^k. */
export function cellWidthKm(order: number, rKm: number): number {
  return (rKm * SHELL_DELTA0) / 2 ** order;
}

// ------------------------------------------------------------
// Ball cover (neighbour query)
// ------------------------------------------------------------

/** Upper bound on grid points coverBall will enumerate before refusing. */
const COVER_MAX_POINTS = 4_000_000;

/**
 * Distinct cell keys at `order` that (conservatively) intersect the sphere of
 * `radiusKm` around (x,y,z). NOT exact: a SAMPLING cover. We lay a 3D grid over
 * the ball inflated by one grid step, plus a Fibonacci sample of the surface and
 * of an inner sphere, and collect the key of every sample. Grid spacing is a
 * quarter of the narrowest cell width inside the ball (cellWidthKm at the ball's
 * minimum radius), so a cell can only be missed if the ball clips less than a
 * sliver of its corner. Over-inclusion is intended (callers refine afterwards).
 * Samples outside the radial range are skipped. Order is limited to 0..15.
 */
export function coverBall(order: number, x: number, y: number, z: number, radiusKm: number): number[] {
  checkOrder(order, MAX_KEY_ORDER);
  if (!(radiusKm >= 0) || !Number.isFinite(radiusKm)) throw new RangeError('spacecell: bad radius');
  const rc = Math.sqrt(x * x + y * y + z * z);
  const rMin = Math.max(rc - radiusKm, WGS84_A_KM * Math.exp(-SHELL_DELTA0) * 1.0001);
  const h = cellWidthKm(order, rMin) / 4;
  const reach = radiusKm + h; // inflated ball
  const n = Math.ceil(reach / h);
  if ((2 * n + 1) ** 3 > COVER_MAX_POINTS) {
    throw new RangeError(`spacecell: ball cover too large (${(2 * n + 1) ** 3} grid points)`);
  }
  const keys = new Set<number>();
  const add = (px: number, py: number, pz: number): void => {
    const k = cellKey(order, px, py, pz);
    if (k !== null) keys.add(k);
  };
  add(x, y, z);
  const reach2 = reach * reach;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      for (let k = -n; k <= n; k++) {
        const dx = i * h, dy = j * h, dz = k * h;
        if (dx * dx + dy * dy + dz * dz <= reach2) add(x + dx, y + dy, z + dz);
      }
    }
  }
  // Fibonacci spheres at R and R+h, and at R/2 (fine structure for tiny balls).
  const golden = Math.PI * (3 - Math.sqrt(5));
  const SURF = 512;
  for (const rad of [radiusKm, radiusKm + h, radiusKm / 2]) {
    for (let i = 0; i < SURF; i++) {
      const zz = 1 - (2 * (i + 0.5)) / SURF;
      const s = Math.sqrt(1 - zz * zz);
      const ph = i * golden;
      add(x + rad * s * Math.cos(ph), y + rad * s * Math.sin(ph), z + rad * zz);
    }
  }
  return [...keys];
}

// ------------------------------------------------------------
// Storage alignment (Postgres int8)
// ------------------------------------------------------------

/** Half-open [lo, hi) range of max-order (18) aligned keys covered by a cell. */
export function keyRangeAtMaxOrder(order: number, key: number): [lo: bigint, hi: bigint] {
  checkOrder(order, MAX_KEY_ORDER);
  const scale = 8n ** BigInt(MAX_ORDER - order);
  const k = BigInt(key);
  return [k * scale, (k + 1n) * scale];
}

/** Aligned storage key: the lo end of the cell's max-order range. */
export function alignedKey(order: number, key: number): bigint {
  return keyRangeAtMaxOrder(order, key)[0];
}
