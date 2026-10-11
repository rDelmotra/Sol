import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrbitElements } from '@orbitwatch/orbital-core';
import { ER_KM } from '@orbitwatch/orbital-core';
import {
  ORBIT_SAMPLES,
  VIEW_H,
  VIEW_PAD,
  VIEW_W,
  WEB_RINGS,
  WEB_SPOKES,
  fitView,
  frameFor,
  prepareOrbit,
  splitSides,
  toView,
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
const molniya: OrbitElements = { ...iss, meanMotionRevPerDay: 2.006, eccentricity: 0.72, inclinationDeg: 63.4 };

describe('prepareOrbit', () => {
  it('samples a closed ring', () => {
    const p = prepareOrbit(iss)!;
    assert.equal(p.ring.length, ORBIT_SAMPLES + 1);
    const a = p.ring[0]!, b = p.ring[ORBIT_SAMPLES]!;
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-3);
  });
  it('rejects unbound or non-finite elements', () => {
    assert.equal(prepareOrbit({ ...iss, eccentricity: 1.2 }), null);
    assert.equal(prepareOrbit({ ...iss, raanDeg: NaN }), null);
  });
});

describe('toView / fitView', () => {
  it('the camera sits 5° above the equator: the north pole projects up and a bit near', () => {
    const v = toView({ x: 0, y: 0, z: 1000 }, 0);
    assert.ok(v.y < 0 && v.d > 0);
  });
  it('fits any orbit, even a very eccentric one, inside the padded view', () => {
    for (const el of [iss, molniya]) {
      const prep = prepareOrbit(el)!;
      const raw = prep.ring.map((p) => toView(p, 1.1));
      const { s, cx, cy } = fitView(raw);
      for (const p of raw) {
        assert.ok(cx + p.x * s >= VIEW_PAD - 1e-6 && cx + p.x * s <= VIEW_W - VIEW_PAD + 1e-6);
        assert.ok(cy + p.y * s >= VIEW_PAD - 1e-6 && cy + p.y * s <= VIEW_H - VIEW_PAD + 1e-6);
      }
      assert.ok(cy - ER_KM * s >= VIEW_PAD - 1e-6);
    }
  });
});

describe('splitSides', () => {
  it('overlaps by one point and writes an M per stretch', () => {
    const pts = [1, 1, -1, -1, 1].map((d, i) => ({ sx: i, sy: 0, d }));
    const { front, back } = splitSides(pts);
    assert.equal((front.match(/M/g) ?? []).length, 2);
    assert.equal((back.match(/M/g) ?? []).length, 1);
    assert.match(back, /^M 1\.00 0\.00 L 2\.00 0\.00 L 3\.00 0\.00 L 4\.00 0\.00$/);
  });
});

describe('frameFor', () => {
  it('has the web, a marker, and a centred Earth', () => {
    const f = frameFor(prepareOrbit(iss)!, 0.6, iss.epochMs);
    assert.equal(f.rings.length, WEB_RINGS);
    assert.equal(f.spokes.length, WEB_SPOKES);
    assert.ok(f.marker);
    assert.ok(f.front.startsWith('M') && f.back.startsWith('M'));
    assert.ok(Math.abs(f.earth.cx - VIEW_W / 2) < 1);
  });
  it('is deterministic and the spin changes the picture', () => {
    const prep = prepareOrbit(iss)!;
    assert.deepEqual(frameFor(prep, 0.6, 0), frameFor(prep, 0.6, 0));
    assert.notEqual(frameFor(prep, 0.6, 0).front, frameFor(prep, 2, 0).front);
  });
});
