import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CIVIL_TWILIGHT_SIN,
  isEclipsedFromComponents,
  isObserverInDarkFromComponents,
  getPhaseMultiplierFromComponents,
  isEclipsed,
  isObserverDarkFromUp,
  isObserverDark,
} from './illumination.js';
import { UMBRA_RADIUS_ER } from './earth.js';

describe('illumination: CIVIL_TWILIGHT_SIN', () => {
  it('equals sin(-6deg)', () => {
    assert.equal(CIVIL_TWILIGHT_SIN, Math.sin(-6 * (Math.PI / 180)));
  });
});

describe('illumination: isEclipsedFromComponents', () => {
  it('is eclipsed exactly on the anti-solar axis inside the umbra radius', () => {
    // Satellite directly behind Earth from the sun, at 1 ER (inside umbra cylinder).
    assert.equal(isEclipsedFromComponents(-1, 0, 0, 1, 0, 0), true);
  });

  it('is not eclipsed on the sunward side regardless of distance', () => {
    assert.equal(isEclipsedFromComponents(1, 0, 0, 1, 0, 0), false);
    assert.equal(isEclipsedFromComponents(0.5, 0.5, 0, 1, 0, 0), false);
  });

  it('is not eclipsed anti-solar but outside the cylindrical umbra radius', () => {
    // Perpendicular offset UMBRA_RADIUS_ER + margin from the shadow axis.
    assert.equal(isEclipsedFromComponents(-1, UMBRA_RADIUS_ER + 0.5, 0, 1, 0, 0), false);
  });

  it('matches the literal-1.0 umbra radius today (UMBRA_RADIUS_ER === 1)', () => {
    assert.equal(UMBRA_RADIUS_ER, 1);
    assert.equal(UMBRA_RADIUS_ER * UMBRA_RADIUS_ER, 1.0);
  });
});

describe('illumination: isObserverInDarkFromComponents', () => {
  it('dark when facing away from the sun', () => {
    assert.equal(isObserverInDarkFromComponents(-1, 0, 0, 1, 0, 0), true);
  });

  it('not dark when facing the sun', () => {
    assert.equal(isObserverInDarkFromComponents(1, 0, 0, 1, 0, 0), false);
  });

  it('returns false (not dark) for a zero-length observer vector', () => {
    assert.equal(isObserverInDarkFromComponents(0, 0, 0, 1, 0, 0), false);
  });
});

describe('illumination: isObserverDarkFromUp / isObserverDark agree with the FromComponents form', () => {
  it('for a unit "up" vector, both forms agree', () => {
    const cases: Array<[number, number, number, number, number, number]> = [
      [-1, 0, 0, 1, 0, 0],
      [1, 0, 0, 1, 0, 0],
      [0, 1, 0, 0.6, 0.8, 0],
      [0.6, 0.8, 0, -0.6, -0.8, 0],
    ];
    for (const [ux, uy, uz, sx, sy, sz] of cases) {
      assert.equal(
        isObserverDarkFromUp(ux, uy, uz, sx, sy, sz),
        isObserverInDarkFromComponents(ux, uy, uz, sx, sy, sz),
      );
    }
  });

  it('Vec3 wrapper isObserverDark matches the component form', () => {
    const up = { x: 0, y: 0, z: 1 };
    const sun = { x: 0.3, y: 0.3, z: -0.9 };
    assert.equal(isObserverDark(up, sun), isObserverDarkFromUp(up.x, up.y, up.z, sun.x, sun.y, sun.z));
  });
});

describe('illumination: isEclipsed (Vec3 wrapper)', () => {
  it('matches isEclipsedFromComponents', () => {
    const r = { x: -1, y: 0, z: 0 };
    const sun = { x: 1, y: 0, z: 0 };
    assert.equal(isEclipsed(r, sun), isEclipsedFromComponents(r.x, r.y, r.z, sun.x, sun.y, sun.z));
  });
});

describe('illumination: getPhaseMultiplierFromComponents', () => {
  it('returns 0.1 for a zero-length view vector', () => {
    assert.equal(getPhaseMultiplierFromComponents(0, 0, 0, 0, 0, 0, 1, 0, 0), 0.1);
  });

  it('is highest when the view vector points toward the sun', () => {
    // obs - sat points toward the sun direction (1,0,0)
    const full = getPhaseMultiplierFromComponents(0, 0, 0, 1, 0, 0, 1, 0, 0);
    const none = getPhaseMultiplierFromComponents(0, 0, 0, -1, 0, 0, 1, 0, 0);
    assert.ok(full > none, `full ${full} should exceed none ${none}`);
    assert.ok(full <= 1 && full >= 0.1);
    assert.ok(none >= 0.1);
  });
});
