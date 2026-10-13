import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrbitElements } from '@orbitwatch/orbital-core';
import { ER_KM, dot } from '@orbitwatch/orbital-core';
import {
  CHEVRON_U_DEG,
  ELEVATION_RAD,
  EQUATOR_STEPS,
  LABEL_PAD_LEFT,
  ORBIT_SAMPLES,
  PERIGEE_MIN_E,
  VIEW_H,
  VIEW_PAD,
  VIEW_W,
  cameraBasis,
  depthOf,
  fitView,
  layoutOrbit,
  markerAt,
  orbitPointAtU,
  outsideEarthPath,
  prepareOrbit,
  splitSides,
  toView,
  type V3,
} from './orbit-diagram';

const iss: OrbitElements = {
  meanMotionRevPerDay: 15.5,
  eccentricity: 0.0005,
  meanAnomalyDeg: 10,
  inclinationDeg: 51.6,
  raanDeg: 100,
  argPerigeeDeg: 80,
  epochMs: Date.UTC(2026, 9, 1),
};
const sso: OrbitElements = { ...iss, meanMotionRevPerDay: 14.8, inclinationDeg: 98.2, raanDeg: 250 };
const polar: OrbitElements = { ...iss, inclinationDeg: 90 };
/** Circular, in the equatorial plane. */
const equatorial: OrbitElements = { ...iss, eccentricity: 0, inclinationDeg: 0, argPerigeeDeg: 0 };
const molniya: OrbitElements = { ...iss, meanMotionRevPerDay: 2.006, eccentricity: 0.72, inclinationDeg: 63.4 };
const near0 = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const prep = (el: OrbitElements) => prepareOrbit(el)!;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** True when every number anywhere in `v` is finite. */
function allFinite(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v && typeof v === 'object') return Object.values(v).every(allFinite);
  return true;
}
/** Every "x y" pair in an SVG path string. */
function pathPoints(d: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const m of d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)) out.push({ x: Number(m[1]), y: Number(m[2]) });
  return out;
}
/** Shoelace sum in screen coordinates (y down): negative = counter-clockwise on screen. */
function shoelace(pts: { x: number; y: number }[]): number {
  let s = 0;
  for (let k = 0; k + 1 < pts.length; k++) s += pts[k]!.x * pts[k + 1]!.y - pts[k + 1]!.x * pts[k]!.y;
  return s;
}
/** Horizontal and vertical half-extent of a set of projected points. */
function extent(pts: { x: number; y: number }[]): { w: number; h: number } {
  return { w: Math.max(...pts.map((q) => Math.abs(q.x))), h: Math.max(...pts.map((q) => Math.abs(q.y))) };
}
/** Half-extent of a circle of radius R (km) in the equatorial plane, as this orbit's camera sees it. */
function equatorExtent(el: OrbitElements, R = 1000): { w: number; h: number } {
  const basis = prep(el).basis;
  return extent(Array.from({ length: 360 }, (_, k) => toView({ x: R * Math.cos(rad(k)), y: R * Math.sin(rad(k)), z: 0 }, basis)));
}

describe('prepareOrbit', () => {
  it('samples a closed ring, perigee first', () => {
    const p = prep(iss);
    assert.equal(p.ring.length, ORBIT_SAMPLES + 1);
    const a = p.ring[0]!, b = p.ring[ORBIT_SAMPLES]!;
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-3);
    near0(Math.hypot(a.x, a.y, a.z), p.shape.rp, 1e-6);
  });
  it('rejects unbound or non-finite elements', () => {
    assert.equal(prepareOrbit({ ...iss, eccentricity: 1.2 }), null);
    assert.equal(prepareOrbit({ ...iss, raanDeg: NaN }), null);
  });
});

describe('cameraBasis: the camera is tied to the orbit plane', () => {
  const cases: [number, number][] = [[0, 0], [100, 51.6], [250, 98.2], [10, 90], [300, 144], [45, 180]];
  it('is orthonormal', () => {
    for (const [raan, inc] of cases) {
      const b = cameraBasis(raan, inc);
      for (const v of [b.right, b.up, b.view, b.normal]) near0(dot(v, v), 1);
      near0(dot(b.right, b.up), 0);
      near0(dot(b.right, b.view), 0);
      near0(dot(b.up, b.view), 0);
    }
  });
  it('looks from the +angular-momentum side, 35° above the orbital plane', () => {
    for (const [raan, inc] of cases) {
      const b = cameraBasis(raan, inc);
      near0(dot(b.view, b.normal), Math.sin(ELEVATION_RAD));
      near0(dot(b.up, b.normal), Math.cos(ELEVATION_RAD));
      near0(dot(b.right, b.normal), 0);
    }
  });
  it('the orbit normal is the real angular momentum direction', () => {
    const b = cameraBasis(100, 51.6);
    // h = (sin O sin i, -cos O sin i, cos i)
    near0(b.normal.z, Math.cos(rad(51.6)));
    near0(b.normal.x, Math.sin(rad(100)) * Math.sin(rad(51.6)));
    near0(b.normal.y, -Math.cos(rad(100)) * Math.sin(rad(51.6)));
  });
});

describe('toView', () => {
  it('puts the ascending node on the left, on the horizontal line through the Earth', () => {
    for (const el of [iss, sso, polar, molniya, equatorial]) {
      const p = prep(el);
      const node = toView(orbitPointAtU(p, 0)!, p.basis);
      assert.ok(node.x < 0);
      near0(node.y, 0, 1e-6);
      near0(node.d, 0, 1e-6);
      const down = toView(orbitPointAtU(p, Math.PI)!, p.basis);
      assert.ok(down.x > 0);
      near0(down.y, 0, 1e-6);
    }
  });
  it('the half of the orbit 90° past the node is the near half and sits at the bottom', () => {
    for (const el of [iss, sso, polar, equatorial]) {
      const p = prep(el);
      const q = toView(orbitPointAtU(p, rad(90))!, p.basis);
      assert.ok(q.d > 0 && q.y > 0);
      const far = toView(orbitPointAtU(p, rad(270))!, p.basis);
      assert.ok(far.d < 0 && far.y < 0);
    }
  });
  it('a circular orbit is an ellipse with minor/major = sin(35°), whatever its inclination or node', () => {
    for (const el of [{ ...iss, eccentricity: 0 }, { ...sso, eccentricity: 0 }, { ...polar, eccentricity: 0 }, equatorial]) {
      const p = prep(el);
      const { w, h } = extent(p.ring.map((pt) => toView(pt, p.basis)));
      near0(h / w, Math.sin(ELEVATION_RAD), 1e-3);
    }
  });
});

describe('every orbit runs counter-clockwise on screen', () => {
  it('prograde, polar, retrograde, equatorial and retrograde-equatorial all agree', () => {
    for (const el of [iss, sso, polar, equatorial, { ...equatorial, inclinationDeg: 180 }, { ...iss, inclinationDeg: 144 }, molniya]) {
      const p = prep(el);
      assert.ok(shoelace(p.ring.map((pt) => toView(pt, p.basis))) < 0, `inclination ${el.inclinationDeg}`);
    }
  });
});

describe('the orbit is drawn the same whatever the inclination; the equator is what tilts', () => {
  it('same ring projection for 0°, 51.6° and 98° (same size and shape, any node)', () => {
    const a = prep({ ...iss, inclinationDeg: 0 }), b = prep(iss), c = prep({ ...sso, meanMotionRevPerDay: iss.meanMotionRevPerDay });
    for (let k = 0; k <= ORBIT_SAMPLES; k += 10) {
      const qa = toView(a.ring[k]!, a.basis), qb = toView(b.ring[k]!, b.basis), qc = toView(c.ring[k]!, c.basis);
      near0(qa.x, qb.x, 1e-6); near0(qa.y, qb.y, 1e-6);
      near0(qa.x, qc.x, 1e-6); near0(qa.y, qc.y, 1e-6);
    }
  });
  it('circular equatorial orbit: the equatorial ring is coincident with the orbit', () => {
    const p = prep(equatorial);
    const orbit = extent(p.ring.map((pt) => toView(pt, p.basis)));
    const ring = equatorExtent(equatorial, p.shape.a);
    near0(ring.w, orbit.w, 1e-3);
    near0(ring.h, orbit.h, 1e-3);
  });
  it('the equatorial ring is foreshortened by |sin(35° + i)|: i = 0 → 0.57, 51.6° → almost round, 90° → 0.82', () => {
    for (const el of [equatorial, iss, polar, sso, { ...iss, inclinationDeg: 144.9 }]) {
      const { w, h } = equatorExtent(el);
      near0(h / w, Math.abs(Math.sin(ELEVATION_RAD + rad(el.inclinationDeg))), 1e-3);
    }
  });
  it('a polar orbit: the equatorial plane is perpendicular to the orbit plane', () => {
    const b = prep(polar).basis;
    near0(dot(b.normal, { x: 0, y: 0, z: 1 }), 0);
    // So the equatorial ring is tilted a full 90° relative to the orbit, i.e. 55° from edge-on (not 35°).
    const { w, h } = equatorExtent(polar);
    near0(h / w, Math.sin(rad(125)), 1e-3);
    assert.ok(h / w > Math.sin(ELEVATION_RAD) + 0.2);
  });
});

describe('fitView', () => {
  it('fits any orbit, even a very eccentric one, inside the padded view', () => {
    for (const el of [iss, sso, polar, molniya, equatorial, { ...iss, meanMotionRevPerDay: 1.0027, eccentricity: 0.0002 }]) {
      const p = prep(el);
      const raw = p.ring.map((pt) => toView(pt, p.basis));
      const { s, cx, cy } = fitView(raw);
      for (const q of raw) {
        assert.ok(cx + q.x * s >= VIEW_PAD + LABEL_PAD_LEFT - 1e-6 && cx + q.x * s <= VIEW_W - VIEW_PAD + 1e-6);
        assert.ok(cy + q.y * s >= VIEW_PAD - 1e-6 && cy + q.y * s <= VIEW_H - VIEW_PAD + 1e-6);
      }
      assert.ok(cy - ER_KM * s >= VIEW_PAD - 1e-6 && cy + ER_KM * s <= VIEW_H - VIEW_PAD + 1e-6);
      assert.ok(cx - ER_KM * s >= VIEW_PAD + LABEL_PAD_LEFT - 1e-6 && cx + ER_KM * s <= VIEW_W - VIEW_PAD + 1e-6);
    }
  });
});

describe('splitSides', () => {
  it('overlaps by one point and writes an M per stretch', () => {
    const pts = [1, 1, -1, -1, 1].map((d, i) => ({ sx: i, sy: 0, d }));
    const { near, far } = splitSides(pts);
    assert.equal((near.match(/M/g) ?? []).length, 2);
    assert.equal((far.match(/M/g) ?? []).length, 1);
    assert.match(far, /^M 1\.00 0\.00 L 2\.00 0\.00 L 3\.00 0\.00 L 4\.00 0\.00$/);
  });
});

describe('depthOf', () => {
  const earth = { cx: 100, cy: 65, r: 40 };
  it('near is in front; far is dimmed only if the Earth disc hides it', () => {
    assert.equal(depthOf({ sx: 10, sy: 10, d: 0 }, earth), 'near');
    assert.equal(depthOf({ sx: 100, sy: 40, d: -5 }, earth), 'hidden');
    assert.equal(depthOf({ sx: 160, sy: 65, d: -5 }, earth), 'far');
  });
});

describe('layoutOrbit', () => {
  it('has no NaN anywhere and is deterministic', () => {
    for (const el of [iss, sso, polar, molniya, equatorial, { ...iss, inclinationDeg: 144.9 }]) {
      const L = layoutOrbit(prep(el));
      assert.ok(allFinite(L), 'every number in the layout is finite');
      assert.ok(!/NaN|Infinity/.test(L.near + L.far + L.equatorNear + L.equatorFar));
      assert.deepEqual(layoutOrbit(prep(el)), L);
    }
  });
  it('near half of the orbit is solid at the bottom, far half is dashed at the top (split at the line of nodes)', () => {
    for (const el of [iss, sso, polar, molniya]) {
      const L = layoutOrbit(prep(el));
      assert.ok(L.near.startsWith('M') && L.far.startsWith('M'));
      // Each stretch overlaps its neighbour by one sample, so allow one sample's height of slack.
      for (const q of pathPoints(L.near)) assert.ok(q.y >= L.earth.cy - 2.5, 'near stays below the nodal line');
      for (const q of pathPoints(L.far)) assert.ok(q.y <= L.earth.cy + 2.5, 'far stays above it');
      assert.ok(pathPoints(L.near).some((q) => q.y > L.earth.cy + 5) && pathPoints(L.far).some((q) => q.y < L.earth.cy - 5));
    }
  });
  it('keeps every drawn point inside the card', () => {
    for (const el of [iss, sso, polar, molniya, equatorial]) {
      const L = layoutOrbit(prep(el));
      for (const q of pathPoints(L.near + ' ' + L.far + ' ' + L.equatorNear + ' ' + L.equatorFar)) {
        assert.ok(q.x >= VIEW_PAD + LABEL_PAD_LEFT - 0.02 && q.x <= VIEW_W - VIEW_PAD + 0.02, `x ${q.x}`);
        assert.ok(q.y >= VIEW_PAD - 0.02 && q.y <= VIEW_H - VIEW_PAD + 0.02, `y ${q.y}`);
      }
      for (const m of [L.pole.base, L.pole.tip, L.node.at]) {
        assert.ok(m.sx >= 0 && m.sx <= VIEW_W && m.sy >= 0 && m.sy <= VIEW_H);
      }
    }
  });
  it('the Earth disc is to scale and the node is on the left of it, on its horizontal diameter', () => {
    const L = layoutOrbit(prep(iss));
    near0(L.earth.r, ER_KM * L.fit.s);
    assert.ok(L.node.at.sx < L.earth.cx);
    near0(L.node.at.sy, L.earth.cy, 1e-6);
    assert.ok(L.node.label.sx < L.node.at.sx);
    assert.match(L.outside, /^M 0 0 H 200 V 130 H 0 Z M /);
    assert.equal(L.outside, outsideEarthPath(L.earth.cx, L.earth.cy, L.earth.r));
  });
  it('draws a closed equatorial ring in two halves', () => {
    assert.equal(EQUATOR_STEPS % 2, 0);
    const L = layoutOrbit(prep(sso));
    assert.ok(L.equatorNear.startsWith('M') && L.equatorFar.startsWith('M'));
    // The ring reaches out to the line of nodes, where it meets the orbit.
    const xs = pathPoints(L.equatorNear + ' ' + L.equatorFar).map((q) => q.x);
    near0(Math.min(...xs), L.node.at.sx, 0.05);
  });
  it('shows the north pole where the real axis points: up for a low inclination, down for 98°', () => {
    const low = layoutOrbit(prep({ ...iss, inclinationDeg: 20 }));
    assert.ok(low.pole.tip.sy < low.pole.base.sy && low.pole.depth === 'near');
    const high = layoutOrbit(prep(sso));
    assert.ok(high.pole.tip.sy > high.pole.base.sy);
    // Pole faces the camera for ISS: a short, honest tick.
    const L = layoutOrbit(prep(iss));
    assert.ok(Math.hypot(L.pole.tip.sx - L.pole.base.sx, L.pole.tip.sy - L.pole.base.sy) < 4);
  });
  it('the inclination label reads the inclination', () => {
    assert.equal(layoutOrbit(prep(iss)).inclination.text, 'i 51.6°');
    assert.equal(layoutOrbit(prep(sso)).inclination.text, 'i 98.2°');
  });
  it('marks the perigee only above e = 0.02, at the real perigee point', () => {
    assert.equal(layoutOrbit(prep(iss)).perigee, null);
    assert.equal(layoutOrbit(prep({ ...iss, eccentricity: PERIGEE_MIN_E })).perigee, null);
    const m = prep({ ...molniya, meanAnomalyDeg: 0 });
    const L = layoutOrbit(m);
    assert.ok(L.perigee);
    const atPerigee = markerAt(m, L.fit, m.el.epochMs)!;
    near0(L.perigee!.at.sx, atPerigee.sx, 1e-6);
    near0(L.perigee!.at.sy, atPerigee.sy, 1e-6);
    // Perigee is nearer the Earth than the far end of the orbit.
    const apo = markerAt({ ...m, el: { ...m.el, meanAnomalyDeg: 180 } }, L.fit, m.el.epochMs)!;
    assert.ok(Math.hypot(L.perigee!.at.sx - L.earth.cx, L.perigee!.at.sy - L.earth.cy) < Math.hypot(apo.sx - L.earth.cx, apo.sy - L.earth.cy));
    for (const l of [L.perigee!.label]) assert.ok(l.sx >= 0 && l.sx <= VIEW_W && l.sy >= 0 && l.sy <= VIEW_H);
  });
  it('three chevrons point along the motion: right on the near (bottom) half, left on the far (top) half', () => {
    for (const el of [iss, sso, polar, molniya]) {
      const L = layoutOrbit(prep(el));
      assert.equal(L.chevrons.length, CHEVRON_U_DEG.length);
      L.chevrons.forEach((c, i) => {
        const goesRight = Math.cos(rad(c.angleDeg)) > 0;
        assert.equal(goesRight, CHEVRON_U_DEG[i]! < 180, `u=${CHEVRON_U_DEG[i]}`);
        assert.equal(c.depth === 'near', CHEVRON_U_DEG[i]! < 180);
      });
    }
  });
});

describe('markerAt', () => {
  const p = prep(iss);
  const { fit } = layoutOrbit(p);
  it('is the two-body position at the sim time, deterministic', () => {
    const t = iss.epochMs + 600_000;
    assert.deepEqual(markerAt(p, fit, t), markerAt(p, fit, t));
    assert.ok(markerAt(p, fit, t));
  });
  it('half a period later a circular orbit has the marker on the opposite side of the Earth', () => {
    const c = prep({ ...iss, eccentricity: 0 });
    const f = layoutOrbit(c).fit;
    const period = 86_400_000 / iss.meanMotionRevPerDay;
    const a = markerAt(c, f, iss.epochMs)!, b = markerAt(c, f, iss.epochMs + period / 2)!;
    near0(a.sx + b.sx, 2 * f.cx, 1e-3);
    near0(a.sy + b.sy, 2 * f.cy, 1e-3);
    assert.ok(a.d * b.d < 0, 'one is on the near side, the other on the far side');
  });
  it('is null for a non-finite time', () => {
    assert.equal(markerAt(p, fit, NaN), null);
  });
  it('moves slowly: one second of ISS motion is a fraction of a pixel to a few pixels', () => {
    const a = markerAt(p, fit, iss.epochMs)!, b = markerAt(p, fit, iss.epochMs + 1000)!;
    const px = Math.hypot(a.sx - b.sx, a.sy - b.sy);
    assert.ok(px > 0 && px < 3, `${px}`);
  });
});

describe('orbitPointAtU', () => {
  it('lies on the orbit: its radius matches the conic at that angle', () => {
    const p = prep(molniya);
    const { a, e } = p.shape;
    for (const deg of [0, 45, 135, 180, 270]) {
      const v = orbitPointAtU(p, rad(deg)) as V3;
      const nu = rad(deg) - rad(molniya.argPerigeeDeg);
      near0(Math.hypot(v.x, v.y, v.z), (a * (1 - e * e)) / (1 + e * Math.cos(nu)), 1e-6);
    }
  });
});
