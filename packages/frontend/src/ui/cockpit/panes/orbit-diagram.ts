/**
 * Orbit-diagram geometry, pure (no React, no store, no DOM); tested in
 * orbit-diagram.test.ts. The maths of the spike's ui/OrbitDiagram.tsx
 * (d1a0c70) split so the component can animate by writing attributes:
 * `prepareOrbit` runs once per object, `frameFor` once per drawn frame.
 */
import {
  ER_KM,
  orbitPoint3D,
  orbitPosition,
  orbitShape,
  type OrbitElements,
} from '@orbitwatch/orbital-core';

export const VIEW_W = 200;
export const VIEW_H = 130;
export const VIEW_PAD = 12;
/** Camera elevation above the equatorial plane. */
export const TILT_RAD = (5 * Math.PI) / 180;
export const SPIN_DEG_PER_S = 7;
/** Spin the diagram starts at, radians. */
export const SPIN_START_RAD = 0.6;
export const ORBIT_SAMPLES = 160;
export const WEB_RINGS = 16;
export const WEB_SPOKES = 60;
const WEB_RING_STEPS = 72;

export interface V3 {
  x: number;
  y: number;
  z: number;
}
export interface Sp {
  sx: number;
  sy: number;
  /** >0 = nearer the camera than the Earth's centre. */
  d: number;
}

/** Everything that depends only on the object (not on spin or time). */
export interface PreparedOrbit {
  el: OrbitElements;
  /** The orbit as a closed run of 3D points (km), by eccentric anomaly. */
  ring: V3[];
}

/** Sample the orbit once; null when the elements describe no bound ellipse. */
export function prepareOrbit(el: OrbitElements): PreparedOrbit | null {
  const shape = orbitShape(el);
  if (!shape) return null;
  const { a, e } = shape;
  const ring: V3[] = [];
  for (let k = 0; k <= ORBIT_SAMPLES; k++) {
    const E = (k / ORBIT_SAMPLES) * 2 * Math.PI;
    const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    const p = orbitPoint3D(el, a * (1 - e * Math.cos(E)), nu);
    if (!p) return null;
    ring.push(p);
  }
  return { el, ring };
}

/** Earth-fixed point (km) to unscaled view coords, with the slow spin about the pole. */
export function toView(p: V3, spin: number): { x: number; y: number; d: number } {
  const cosS = Math.cos(spin);
  const sinS = Math.sin(spin);
  const cosT = Math.cos(TILT_RAD);
  const sinT = Math.sin(TILT_RAD);
  const x = p.x * cosS - p.y * sinS;
  const y = p.x * sinS + p.y * cosS;
  return { x, y: -(p.z * cosT + y * sinT), d: -y * cosT + p.z * sinT };
}

/** Scale and centre that fit the projected outline (plus the Earth) into the view. */
export function fitView(pts: { x: number; y: number }[]): { s: number; cx: number; cy: number } {
  let x0 = -ER_KM, x1 = ER_KM, y0 = -ER_KM, y1 = ER_KM;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const s = Math.min((VIEW_W - 2 * VIEW_PAD) / (x1 - x0), (VIEW_H - 2 * VIEW_PAD) / (y1 - y0));
  return { s, cx: VIEW_W / 2 - ((x0 + x1) / 2) * s, cy: VIEW_H / 2 - ((y0 + y1) / 2) * s };
}

export function toPath(pts: Sp[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.sx.toFixed(2)} ${p.sy.toFixed(2)}`).join(' ');
}

/**
 * Split a closed run of points into the near-side and far-side stretches. Each
 * stretch overlaps its neighbour by one point so the line has no gap at the
 * crossing. Each side is one path string, with an `M` per stretch.
 */
export function splitSides(pts: Sp[]): { front: string; back: string } {
  const front: string[] = [];
  const back: string[] = [];
  let cur: Sp[] = [];
  let curFront = false;
  const flush = () => {
    if (cur.length > 1) (curFront ? front : back).push(toPath(cur));
  };
  for (let k = 0; k < pts.length; k++) {
    const isFront = pts[k]!.d >= 0;
    if (k === 0 || curFront !== isFront) {
      if (k > 0) {
        cur.push(pts[k]!);
        flush();
      }
      cur = k > 0 ? [pts[k - 1]!] : [];
      curFront = isFront;
    }
    cur.push(pts[k]!);
  }
  flush();
  return { front: front.join(' '), back: back.join(' ') };
}

/** The "outside the Earth disc" clip region: the whole view minus the disc. */
export function outsideEarthPath(cx: number, cy: number, r: number): string {
  return `M 0 0 H ${VIEW_W} V ${VIEW_H} H 0 Z M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}

export interface Frame {
  earth: { cx: number; cy: number; r: number };
  front: string;
  back: string;
  outside: string;
  rings: string[];
  spokes: string[];
  /** Marker screen position, or null when the elements have no position at that time. */
  marker: Sp | null;
}

/**
 * One drawn frame at `spin` radians. The marker is the two-body position at
 * `atMs` (the store exposes only the live altitude and speed, not the live
 * position, so the diagram cannot show the SGP4 point).
 */
export function frameFor(prep: PreparedOrbit, spin: number, atMs: number): Frame {
  const raw = prep.ring.map((p) => toView(p, spin));
  const { s, cx, cy } = fitView(raw);
  const project = (p: V3): Sp => {
    const q = toView(p, spin);
    return { sx: cx + q.x * s, sy: cy + q.y * s, d: q.d };
  };
  const pts: Sp[] = raw.map((q) => ({ sx: cx + q.x * s, sy: cy + q.y * s, d: q.d }));
  const { front, back } = splitSides(pts);
  const r = ER_KM * s;

  // Radial web in the equatorial plane (z = 0), spread to the view's horizontal edges.
  const webR = (VIEW_W / 2 + Math.abs(cx - VIEW_W / 2)) / s;
  const rings = Array.from({ length: WEB_RINGS }, (_, i) => {
    const R = (webR * (i + 1)) / WEB_RINGS;
    return toPath(
      Array.from({ length: WEB_RING_STEPS + 1 }, (_, k) => {
        const t = (k / WEB_RING_STEPS) * 2 * Math.PI;
        return project({ x: R * Math.cos(t), y: R * Math.sin(t), z: 0 });
      }),
    );
  });
  const origin = project({ x: 0, y: 0, z: 0 });
  const spokes = Array.from({ length: WEB_SPOKES }, (_, k) => {
    const t = (k / WEB_SPOKES) * 2 * Math.PI;
    return toPath([origin, project({ x: webR * Math.cos(t), y: webR * Math.sin(t), z: 0 })]);
  });

  const pos = orbitPosition(prep.el, atMs);
  const q = pos ? orbitPoint3D(prep.el, pos.r, pos.trueAnomaly) : null;
  return {
    earth: { cx, cy, r },
    front,
    back,
    outside: outsideEarthPath(cx, cy, r),
    rings,
    spokes,
    marker: q ? project(q) : null,
  };
}
