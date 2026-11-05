// ============================================================
// SGP — the original Simplified General Perturbations model of Spacetrack Report No. 3 (Hoots & Roehrich, 1980, section 5),
// the model the pre-SGP4 element sets were generated for. Pure maths, no imports.
//
// Why it is here: element sets before the mid-1970s carry no B* (the drag term SGP4 uses); their drag is in the first and second
// time derivatives of the mean motion (ndot/2, nddot/6), which SGP4 ignores. Propagated with SGP4 and B* = 0 a low-perigee object
// therefore flies drag-free and drifts along-track by ~ 2 pi (ndot/2) t^2 rev. SGP puts that drift back:
//
//   secular:    a(t) = a0 [n0 / (n0 + 2 (ndot/2) t + 3 (nddot/6) t^2)]^(2/3),   e(t) = 1 - q0 / a(t)   (perigee height held)
//               L(t) = L0 + (n0 + dw/dt + dO/dt) t + (ndot/2) t^2 + (nddot/6) t^3,   w and O with the J2 secular rates
//   long period (J3) and short period (J2) terms as in the report; Kepler's equation solved for E + w.
//
// Constants are the report's (WGS-72 era): ke = 0.0743669161 er^(3/2)/min, k2 = 1/2 J2 aE^2 = 5.413080e-4, J3 = -0.253881e-5,
// aE = 6378.135 km. Output frame = the SGP4 output frame (true equator, mean equinox of the elements), km and km/s.
//
// Validation: the report's published SGP test output is NOT reproduced here (its numbers could not be recovered reliably); the tests
// check internal consistency instead: velocity = time derivative of position, SGP == SGP4-like two-body + J2 behaviour on a drag-free
// high orbit (agreement with satellite.js SGP4 is checked in the backend, where satellite.js may be imported), the drag term's
// along-track drift equals 2 pi (ndot/2) t^2, and the decay of a(t) matches the mean-motion rate.
// ============================================================

/** Inputs in TLE / OMM units. */
export interface SgpElements {
  /** Kozai mean motion, rev/day (TLE / OMM MEAN_MOTION) */
  meanMotionRevDay: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argPerigeeDeg: number;
  meanAnomalyDeg: number;
  /** first derivative of the mean motion divided by 2, rev/day^2 (TLE field / OMM MEAN_MOTION_DOT) */
  ndot2RevDay2: number;
  /** second derivative divided by 6, rev/day^3 (TLE field / OMM MEAN_MOTION_DDOT); 0 when unknown */
  nddot6RevDay3?: number;
}

export interface SgpRecord {
  n0: number; e0: number; i0: number; O0: number; w0: number; M0: number; ndot2: number; nddot6: number;
  a0: number; q0: number; p0: number; L0: number; dO: number; dw: number; sinI: number; cosI: number;
}

export interface SgpState {
  /** km, TEME-like frame of the elements */
  position: [number, number, number];
  /** km/s */
  velocity: [number, number, number];
}

export const SGP_KE = 0.0743669161;
export const SGP_K2 = 5.41308e-4;
export const SGP_J3 = -0.253881e-5;
export const SGP_AE_KM = 6378.135;
const J3_OVER_J2 = SGP_J3 / (2 * SGP_K2);
const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;
const MIN_PER_DAY = 1440;

/** Precompute the epoch quantities; null for unusable elements (non-finite, e outside [0, 1), n <= 0, perigee inside the Earth). */
export function sgpInit(el: SgpElements): SgpRecord | null {
  const n0 = (el.meanMotionRevDay * TWO_PI) / MIN_PER_DAY; // rad/min
  const e0 = el.eccentricity, i0 = el.inclinationDeg * DEG;
  const ndot2 = (el.ndot2RevDay2 * TWO_PI) / (MIN_PER_DAY * MIN_PER_DAY); // rad/min^2
  const nddot6 = ((el.nddot6RevDay3 ?? 0) * TWO_PI) / (MIN_PER_DAY * MIN_PER_DAY * MIN_PER_DAY); // rad/min^3
  const vals = [n0, e0, i0, el.raanDeg, el.argPerigeeDeg, el.meanAnomalyDeg, ndot2, nddot6];
  if (!vals.every(Number.isFinite) || !(n0 > 0) || !(e0 >= 0 && e0 < 1)) return null;
  const cosI = Math.cos(i0), sinI = Math.sin(i0);
  const a1 = Math.pow(SGP_KE / n0, 2 / 3);
  const beta = 1 - e0 * e0;
  const d1 = (1.5 * SGP_K2 * (3 * cosI * cosI - 1)) / (a1 * a1 * Math.pow(beta, 1.5));
  const a0 = a1 * (1 - d1 / 3 - d1 * d1 - (134 / 81) * d1 * d1 * d1);
  const p0 = a0 * beta, q0 = a0 * (1 - e0);
  if (!(a0 > 0) || !(q0 > 0)) return null;
  const O0 = el.raanDeg * DEG, w0 = el.argPerigeeDeg * DEG, M0 = el.meanAnomalyDeg * DEG;
  const dO = (-3 * SGP_K2 * n0 * cosI) / (p0 * p0);
  const dw = (1.5 * SGP_K2 * n0 * (5 * cosI * cosI - 1)) / (p0 * p0);
  return { n0, e0, i0, O0, w0, M0, ndot2, nddot6, a0, q0, p0, L0: M0 + w0 + O0, dO, dw, sinI, cosI };
}

/** State at `tsinceMin` minutes from the epoch; null when the orbit has decayed in the model or the solution fails. */
export function sgpPropagate(s: SgpRecord, tsinceMin: number): SgpState | null {
  const t = tsinceMin;
  const den = s.n0 + 2 * s.ndot2 * t + 3 * s.nddot6 * t * t;
  if (!(den > 0)) return null;
  const a = s.a0 * Math.pow(s.n0 / den, 2 / 3);
  const e = a > s.q0 ? 1 - s.q0 / a : 1e-6;
  const p = a * (1 - e * e);
  if (!(a > 0) || !(p > 0)) return null;
  const Os = s.O0 + s.dO * t;
  const ws = s.w0 + s.dw * t;
  const Ls = s.L0 + (s.n0 + s.dw + s.dO) * t + s.ndot2 * t * t + s.nddot6 * t * t * t;
  // long-period periodics (J3)
  const axN = e * Math.cos(ws);
  const ayN = e * Math.sin(ws) - (0.5 * J3_OVER_J2 * s.sinI) / p;
  const L = Ls - (0.25 * J3_OVER_J2 * axN * s.sinI * (3 + 5 * s.cosI)) / (p * (1 + s.cosI));
  // Kepler for E + w
  const U = (((L - Os) % TWO_PI) + TWO_PI) % TWO_PI;
  let Ew = U;
  for (let k = 0; k < 10; k++) {
    const sn = Math.sin(Ew), cs = Math.cos(Ew);
    const d = (U - ayN * cs + axN * sn - Ew) / (1 - ayN * sn - axN * cs);
    Ew += d;
    if (Math.abs(d) < 1e-12) break;
  }
  const sEw = Math.sin(Ew), cEw = Math.cos(Ew);
  const ecosE = axN * cEw + ayN * sEw;
  const esinE = axN * sEw - ayN * cEw;
  const eL2 = axN * axN + ayN * ayN;
  if (!(eL2 < 1)) return null;
  const pL = a * (1 - eL2);
  const r = a * (1 - ecosE);
  if (!(r > 0) || !(pL > 0)) return null;
  const rdot = (SGP_KE * Math.sqrt(a) * esinE) / r;
  const rvdot = (SGP_KE * Math.sqrt(pL)) / r;
  const bL = Math.sqrt(1 - eL2);
  const sinu = (a / r) * (sEw - ayN - (axN * esinE) / (1 + bL));
  const cosu = (a / r) * (cEw - axN + (ayN * esinE) / (1 + bL));
  const u = Math.atan2(sinu, cosu);
  const s2u = Math.sin(2 * u), c2u = Math.cos(2 * u);
  // short-period periodics (J2)
  const k2p = SGP_K2 / pL, k2p2 = SGP_K2 / (pL * pL);
  const rk = r + 0.5 * k2p * s.sinI * s.sinI * c2u;
  const uk = u - 0.25 * k2p2 * (7 * s.cosI * s.cosI - 1) * s2u;
  const Ok = Os + 1.5 * k2p2 * s.cosI * s2u;
  const ik = s.i0 + 1.5 * k2p2 * s.sinI * s.cosI * c2u;
  const sO = Math.sin(Ok), cO = Math.cos(Ok), si = Math.sin(ik), ci = Math.cos(ik), su = Math.sin(uk), cu = Math.cos(uk);
  const Mv = [-sO * ci, cO * ci, si];
  const Nv = [cO, sO, 0];
  const Uv = [Mv[0]! * su + Nv[0]! * cu, Mv[1]! * su + Nv[1]! * cu, Mv[2]! * su + Nv[2]! * cu];
  const Vv = [Mv[0]! * cu - Nv[0]! * su, Mv[1]! * cu - Nv[1]! * su, Mv[2]! * cu - Nv[2]! * su];
  const kms = SGP_AE_KM / 60;
  const position: [number, number, number] = [rk * Uv[0]! * SGP_AE_KM, rk * Uv[1]! * SGP_AE_KM, rk * Uv[2]! * SGP_AE_KM];
  const velocity: [number, number, number] = [
    (rdot * Uv[0]! + rvdot * Vv[0]!) * kms, (rdot * Uv[1]! + rvdot * Vv[1]!) * kms, (rdot * Uv[2]! + rvdot * Vv[2]!) * kms,
  ];
  if (!position.every(Number.isFinite) || !velocity.every(Number.isFinite)) return null;
  return { position, velocity };
}

/** SGP elements from an OMM record (MEAN_MOTION, ECCENTRICITY, ..., MEAN_MOTION_DOT, MEAN_MOTION_DDOT). */
export function sgpElementsFromOmm(omm: Record<string, unknown>): SgpElements {
  return {
    meanMotionRevDay: Number(omm.MEAN_MOTION), eccentricity: Number(omm.ECCENTRICITY), inclinationDeg: Number(omm.INCLINATION),
    raanDeg: Number(omm.RA_OF_ASC_NODE), argPerigeeDeg: Number(omm.ARG_OF_PERICENTER), meanAnomalyDeg: Number(omm.MEAN_ANOMALY),
    ndot2RevDay2: Number(omm.MEAN_MOTION_DOT ?? 0), nddot6RevDay3: Number(omm.MEAN_MOTION_DDOT ?? 0),
  };
}
