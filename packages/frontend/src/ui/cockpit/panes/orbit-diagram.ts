/**
 * Orbit-diagram geometry, pure (no React, no store, no DOM); tested in
 * orbit-diagram.test.ts.
 *
 * The picture is STILL. The camera is tied to the orbit plane, not the equator:
 * it looks from the +angular-momentum side (so every orbit, prograde or
 * retrograde, runs counter-clockwise on screen), 35 degrees above the plane,
 * with the line of nodes horizontal and the ascending node on the left. Depth
 * is read from the picture itself (near half solid, far half dashed), so no
 * spin is needed. `prepareOrbit` runs once per object, `layoutOrbit` once per
 * object (it is all static), `markerAt` once per marker update (1 Hz).
 *
 * One deliberate departure from scale: a low orbit is drawn a little higher
 * above the surface than it really is (`liftRadiusKm`, at most 0.1 Earth radii,
 * fading to nothing by one radius of altitude). Drawn true, the ISS sits 6.6%
 * above the Earth and its ring lies on the Earth's outline. The Earth disc, the
 * pole and the sampled orbit (`prepareOrbit`) stay true; only what is drawn
 * (the orbit lines, nodes, perigee, chevrons, marker, equator ring) is lifted.
 */
import {
  ER_KM,
  RAD,
  dot,
  orbitPoint3D,
  orbitPosition,
  orbitShape,
  type OrbitElements,
  type OrbitShape,
} from '@orbitwatch/orbital-core';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const VIEW_W = 200;
export const VIEW_H = 130;
export const VIEW_PAD = 12;
/** Top and bottom padding. Smaller than the side padding: the labels all sit at the sides. */
export const VIEW_PAD_Y = 8;
/** Extra room on the left, so the "AN" label never touches the card edge. */
export const LABEL_PAD_LEFT = 8;
/** Camera elevation above the ORBITAL plane. */
export const ELEVATION_RAD = 35 * RAD;
export const ORBIT_SAMPLES = 160;
export const EQUATOR_STEPS = 96;
/** The marker is moved once a second; the diagram never animates. */
export const MARKER_INTERVAL_MS = 1000;
/** Perigee is only marked when the orbit is visibly eccentric. */
export const PERIGEE_MIN_E = 0.02;
/** The pole tick runs from the surface out to this many Earth radii. */
export const POLE_TIP = 1.25;
/** Argument of latitude (degrees from the ascending node) of each direction chevron. */
export const CHEVRON_U_DEG = [45, 135, 270] as const;
/** Each chevron may slide inside its slot [lowest, highest] to stay off the perigee mark. */
export const CHEVRON_SLOT_DEG = [[25, 70], [110, 155], [225, 315]] as const;
/** A chevron closer than this (degrees of orbit) to the perigee slides away from it. */
export const CHEVRON_CLEAR_DEG = 22;
/** Label text metrics (font size 6.5 monospace): width per character and cap height, card units. */
export const LABEL_CHAR_W = 3.9;
export const LABEL_CAP_H = 4.7;
/** Opacity of a mark by depth. */
export const DEPTH_OPACITY = { near: 1, far: 0.45, hidden: 0.2 } as const;
/** How far (in Earth radii) a surface-grazing orbit is drawn above the surface; fades to 0 at one radius of altitude. */
export const LIFT_MAX = 0.1;
/** The equatorial ring is left out when the orbit is this close (degrees) to the equator: it would lie on the orbit. */
export const EQUATOR_HIDE_DEG = 1.5;

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
export interface Fit {
  s: number;
  cx: number;
  cy: number;
}
/** Where a mark sits relative to the Earth disc: in front, far side in the clear, or behind the disc. */
export type Depth = keyof typeof DEPTH_OPACITY;

/** Unit vectors, in Earth-centred inertial axes, of the camera: screen-right, screen-up and toward-camera. */
export interface CameraBasis {
  right: V3;
  up: V3;
  view: V3;
  /** Orbit-plane normal (the angular momentum direction). */
  normal: V3;
}

/**
 * The orbit-relative camera. n = toward the ascending node, m = 90 degrees
 * ahead of it in the plane, h = n x m (angular momentum). Screen-right is -n
 * (so the ascending node is on the left); the camera sits at 35 degrees above
 * the plane on the +h side, over the +m edge, so the +m half of the orbit is
 * the near half and appears at the bottom.
 */
export function cameraBasis(raanDeg: number, inclinationDeg: number): CameraBasis {
  const O = raanDeg * RAD;
  const i = inclinationDeg * RAD;
  const n = { x: Math.cos(O), y: Math.sin(O), z: 0 };
  const m = { x: -Math.sin(O) * Math.cos(i), y: Math.cos(O) * Math.cos(i), z: Math.sin(i) };
  const h = { x: Math.sin(O) * Math.sin(i), y: -Math.cos(O) * Math.sin(i), z: Math.cos(i) };
  const sE = Math.sin(ELEVATION_RAD);
  const cE = Math.cos(ELEVATION_RAD);
  return {
    right: { x: -n.x, y: -n.y, z: -n.z },
    up: { x: cE * h.x - sE * m.x, y: cE * h.y - sE * m.y, z: cE * h.z - sE * m.z },
    view: { x: sE * h.x + cE * m.x, y: sE * h.y + cE * m.y, z: sE * h.z + cE * m.z },
    normal: h,
  };
}

/** Everything that depends only on the object. */
export interface PreparedOrbit {
  el: OrbitElements;
  shape: OrbitShape;
  basis: CameraBasis;
  /** The orbit as a closed run of 3D points (km), by eccentric anomaly, perigee first. */
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
  return { el, shape, basis: cameraBasis(el.raanDeg, el.inclinationDeg), ring };
}

/** Orbit radius (km) as drawn: raised by up to LIFT_MAX Earth radii when the orbit is low, true from one radius of altitude up. */
export function liftRadiusKm(r: number): number {
  const h = clamp((r - ER_KM) / ER_KM, 0, 1);
  return r + ER_KM * LIFT_MAX * (1 - h);
}

/** The point moved along its radius to its drawn radius. */
export function liftPoint(p: V3): V3 {
  const r = Math.hypot(p.x, p.y, p.z);
  if (!(r > 1e-9)) return p;
  const k = liftRadiusKm(r) / r;
  return { x: p.x * k, y: p.y * k, z: p.z * k };
}

/** Earth-centred point (km) to unscaled view coords. y points DOWN (SVG); d > 0 is toward the camera. */
export function toView(p: V3, basis: CameraBasis): { x: number; y: number; d: number } {
  return { x: dot(p, basis.right), y: -dot(p, basis.up), d: dot(p, basis.view) };
}

/** Scale and centre that fit the projected points (plus the Earth) into the padded view. */
export function fitView(pts: { x: number; y: number }[]): Fit {
  let x0 = -ER_KM, x1 = ER_KM, y0 = -ER_KM, y1 = ER_KM;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const left = VIEW_PAD + LABEL_PAD_LEFT;
  const availW = VIEW_W - left - VIEW_PAD;
  const availH = VIEW_H - 2 * VIEW_PAD_Y;
  const s = Math.min(availW / (x1 - x0), availH / (y1 - y0));
  return {
    s,
    cx: left + availW / 2 - ((x0 + x1) / 2) * s,
    cy: VIEW_PAD_Y + availH / 2 - ((y0 + y1) / 2) * s,
  };
}

export function toPath(pts: Sp[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.sx.toFixed(2)} ${p.sy.toFixed(2)}`).join(' ');
}

/**
 * Split a closed run of points into the near-side and far-side stretches. Each
 * stretch overlaps its neighbour by one point so the line has no gap at the
 * crossing. Each side is one path string, with an `M` per stretch.
 */
export function splitSides(pts: Sp[]): { near: string; far: string } {
  const near: string[] = [];
  const far: string[] = [];
  let cur: Sp[] = [];
  let curNear = false;
  const flush = () => {
    if (cur.length > 1) (curNear ? near : far).push(toPath(cur));
  };
  for (let k = 0; k < pts.length; k++) {
    const isNear = pts[k]!.d >= 0;
    if (k === 0 || curNear !== isNear) {
      if (k > 0) {
        cur.push(pts[k]!);
        flush();
      }
      cur = k > 0 ? [pts[k - 1]!] : [];
      curNear = isNear;
    }
    cur.push(pts[k]!);
  }
  flush();
  return { near: near.join(' '), far: far.join(' ') };
}

/** The "outside the Earth disc" clip region: the whole view minus the disc. */
export function outsideEarthPath(cx: number, cy: number, r: number): string {
  return `M 0 0 H ${VIEW_W} V ${VIEW_H} H 0 Z M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}

/** Near the camera, far side in the clear, or far side behind the Earth disc. */
export function depthOf(p: Sp, earth: { cx: number; cy: number; r: number }): Depth {
  if (p.d >= 0) return 'near';
  return Math.hypot(p.sx - earth.cx, p.sy - earth.cy) < earth.r ? 'hidden' : 'far';
}

/** The orbit point at argument of latitude `uRad` (measured from the ascending node). */
export function orbitPointAtU(prep: PreparedOrbit, uRad: number): V3 | null {
  const { a, e } = prep.shape;
  const nu = uRad - prep.el.argPerigeeDeg * RAD;
  return orbitPoint3D(prep.el, (a * (1 - e * e)) / (1 + e * Math.cos(nu)), nu);
}

/** Earth-centred point (km) to card coords. `lift` moves it to its drawn radius first (orbit marks yes, the Earth's own pole no). */
function projector(prep: PreparedOrbit, fit: Fit, lift: boolean): (p: V3) => Sp {
  return (p) => {
    const q = toView(lift ? liftPoint(p) : p, prep.basis);
    return { sx: fit.cx + q.x * fit.s, sy: fit.cy + q.y * fit.s, d: q.d };
  };
}

export interface Label {
  sx: number;
  sy: number;
}
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The box a short label covers (baseline at `at.sy`). */
export function labelBox(at: Label, anchor: 'start' | 'middle' | 'end', text: string): Box {
  const w = text.length * LABEL_CHAR_W;
  const x0 = anchor === 'start' ? at.sx : anchor === 'end' ? at.sx - w : at.sx - w / 2;
  return { x0, x1: x0 + w, y0: at.sy - LABEL_CAP_H, y1: at.sy + 0.5 };
}

/** True when the boxes come within `gap` of each other. */
export function boxesOverlap(a: Box, b: Box, gap = 1): boolean {
  return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
}

/** Shortest distance between two angles, degrees (0..180). */
function angleGapDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/**
 * The chevrons' arguments of latitude: the defaults, except that one which
 * would sit on the perigee mark slides to the end of its slot that is further
 * from it. (Molniya and Tundra orbits have the perigee at 270 degrees, exactly
 * where the last chevron is.) `perigeeUDeg` is null when no perigee is marked.
 */
export function chevronAngles(perigeeUDeg: number | null): number[] {
  return CHEVRON_U_DEG.map((u, i) => {
    if (perigeeUDeg === null || angleGapDeg(u, perigeeUDeg) >= CHEVRON_CLEAR_DEG) return u;
    const [lo, hi] = CHEVRON_SLOT_DEG[i]!;
    return angleGapDeg(lo, perigeeUDeg) >= angleGapDeg(hi, perigeeUDeg) ? lo : hi;
  });
}
export interface Chevron {
  sx: number;
  sy: number;
  /** Direction of motion on screen, degrees (SVG rotate). */
  angleDeg: number;
  depth: Depth;
}
export interface OrbitLayout {
  fit: Fit;
  earth: { cx: number; cy: number; r: number };
  /** Clip region: the view minus the Earth disc. */
  outside: string;
  /** Orbit, near half and far half (each one path string). */
  near: string;
  far: string;
  /** The equatorial plane as a ring the size of the orbit's nearer node, same split. */
  equatorNear: string;
  equatorFar: string;
  /** North pole: where it meets the surface, the tick's end, and its label. */
  pole: { base: Sp; tip: Sp; label: Label; depth: Depth };
  /** Ascending node dot and label (label is right-aligned, to the left of the dot). */
  node: { at: Sp; label: Label };
  /** Perigee tick and label, only when the orbit is eccentric. */
  perigee: { at: Sp; tip: Sp; label: Label; depth: Depth } | null;
  chevrons: Chevron[];
  /** Text for the top-left corner (left-aligned). */
  inclination: { text: string; at: Label };
}

/** One static layout for the whole card. An unusable point falls back to the Earth's centre. */
export function layoutOrbit(prep: PreparedOrbit): OrbitLayout {
  const { el, shape, basis } = prep;
  // The equatorial ring has the radius of the nearer node, so it meets the orbit on the line of
  // nodes and never sticks out past it: the tilt between the two loops IS the inclination. It is
  // left out when the orbit is (nearly) equatorial, where it would only lie on the orbit.
  const nodePoint = orbitPointAtU(prep, 0);
  const downPoint = orbitPointAtU(prep, Math.PI);
  const ringR = liftRadiusKm(
    Math.min(
      nodePoint ? Math.hypot(nodePoint.x, nodePoint.y, nodePoint.z) : shape.a,
      downPoint ? Math.hypot(downPoint.x, downPoint.y, downPoint.z) : shape.a,
    ),
  );
  const showEquator = Math.min(el.inclinationDeg % 180, 180 - (el.inclinationDeg % 180)) > EQUATOR_HIDE_DEG;
  const equatorPts: V3[] = showEquator
    ? Array.from({ length: EQUATOR_STEPS + 1 }, (_, k) => {
        const t = (k / EQUATOR_STEPS) * 2 * Math.PI;
        return { x: ringR * Math.cos(t), y: ringR * Math.sin(t), z: 0 };
      })
    : [];
  const poleTipRaw = toView({ x: 0, y: 0, z: ER_KM * POLE_TIP }, basis);
  const fit = fitView([...prep.ring.map(liftPoint), ...equatorPts].map((p) => toView(p, basis)).concat(poleTipRaw));
  // Orbit marks are drawn at their lifted radius; the ring is already built at one, the pole is the Earth's own.
  const project = projector(prep, fit, true);
  const projectEarth = projector(prep, fit, false);
  const earth = { cx: fit.cx, cy: fit.cy, r: ER_KM * fit.s };
  const centre: Sp = { sx: earth.cx, sy: earth.cy, d: 0 };
  const proj = (p: V3 | null): Sp => (p ? project(p) : centre);

  const orbit = splitSides(prep.ring.map(project));
  const equator = splitSides(equatorPts.map(projectEarth));

  // North pole: the real axis, from the surface out to POLE_TIP radii, projected. It is short when
  // the pole faces the camera (that foreshortening is the honest picture).
  const poleBase = projectEarth({ x: 0, y: 0, z: ER_KM });
  const poleTip = projectEarth({ x: 0, y: 0, z: ER_KM * POLE_TIP });
  const tickLen = Math.hypot(poleTip.sx - poleBase.sx, poleTip.sy - poleBase.sy);
  const pdx = tickLen > 1e-6 ? (poleTip.sx - poleBase.sx) / tickLen : 0;
  const pdy = tickLen > 1e-6 ? (poleTip.sy - poleBase.sy) / tickLen : -1;
  const poleLabelRaw: Label =
    tickLen >= 6
      ? { sx: poleTip.sx + pdx * 5, sy: poleTip.sy + pdy * 5 + 2.3 }
      : { sx: poleBase.sx + 5, sy: poleBase.sy + 2.3 };
  const poleLabel: Label = { sx: clamp(poleLabelRaw.sx, 4, VIEW_W - 4), sy: clamp(poleLabelRaw.sy, 6, VIEW_H - 2) };

  const node = proj(nodePoint);
  const nodeLabel: Label = { sx: node.sx - 4, sy: node.sy + 2.3 };
  const inclination = { text: `i ${el.inclinationDeg.toFixed(1)}°`, at: { sx: 6, sy: 9 } };

  let perigee: OrbitLayout['perigee'] = null;
  if (shape.e > PERIGEE_MIN_E) {
    const at = proj(orbitPoint3D(el, shape.rp, 0));
    const len = Math.hypot(at.sx - earth.cx, at.sy - earth.cy);
    const dx = len > 1e-6 ? (at.sx - earth.cx) / len : 0;
    const dy = len > 1e-6 ? (at.sy - earth.cy) / len : -1;
    // The label sits just outside the tick, turned away in 45 degree steps from any other label or the node dot.
    const taken: Box[] = [
      labelBox(nodeLabel, 'end', 'AN'),
      { x0: node.sx - 3, x1: node.sx + 3, y0: node.sy - 3, y1: node.sy + 3 },
      labelBox(poleLabel, 'middle', 'N'),
      labelBox(inclination.at, 'start', inclination.text),
    ];
    const base = Math.atan2(dy, dx);
    let label: Label | null = null;
    let first: Label | null = null;
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4]) {
      const ang = base + (k * Math.PI) / 4;
      const c: Label = {
        sx: clamp(at.sx + Math.cos(ang) * 10, 10, VIEW_W - 10),
        sy: clamp(at.sy + Math.sin(ang) * 10 + 2.3, 7, VIEW_H - 3),
      };
      first ??= c;
      if (!taken.some((b) => boxesOverlap(labelBox(c, 'middle', 'PE'), b))) {
        label = c;
        break;
      }
    }
    perigee = {
      at,
      tip: { sx: at.sx + dx * 4.5, sy: at.sy + dy * 4.5, d: at.d },
      label: label ?? first!,
      depth: depthOf(at, earth),
    };
  }

  const chevrons = chevronAngles(perigee ? ((el.argPerigeeDeg % 360) + 360) % 360 : null).map((deg): Chevron => {
    const u = deg * RAD;
    const a = proj(orbitPointAtU(prep, u - 0.03));
    const b = proj(orbitPointAtU(prep, u + 0.03));
    const mid = proj(orbitPointAtU(prep, u));
    return { sx: mid.sx, sy: mid.sy, angleDeg: Math.atan2(b.sy - a.sy, b.sx - a.sx) / RAD, depth: depthOf(mid, earth) };
  });

  return {
    fit,
    earth,
    outside: outsideEarthPath(earth.cx, earth.cy, earth.r),
    near: orbit.near,
    far: orbit.far,
    equatorNear: equator.near,
    equatorFar: equator.far,
    pole: { base: poleBase, tip: poleTip, label: poleLabel, depth: depthOf(poleBase, earth) },
    node: { at: node, label: nodeLabel },
    perigee,
    chevrons,
    inclination,
  };
}

/**
 * The object's marker on screen at `atMs`: the two-body position (the store
 * exposes only the live altitude and speed, not the live position, so the
 * diagram cannot show the SGP4 point). Null when the elements have no position.
 */
export function markerAt(prep: PreparedOrbit, fit: Fit, atMs: number): Sp | null {
  const pos = orbitPosition(prep.el, atMs);
  const q = pos ? orbitPoint3D(prep.el, pos.r, pos.trueAnomaly) : null;
  return q ? projector(prep, fit, true)(q) : null;
}
