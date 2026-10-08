// ============================================================
// Sweep prefilter conservativeness — brute force. The prefilter may only
// EXCLUDE objects that can never exceed the elevation threshold. We sample
// random observers/satellites (seeded PRNG, deterministic), compute the TRUE
// elevation with orbital-core's observerEcef + lookAngles (same math as the
// live plane, in the ECEF frame), and assert no excluded object ever rises
// above the threshold. Half the samples are placed at the footprint edge.
// ============================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { observerEcef, lookAngles, ER_KM, DEG, RAD } from '@orbitwatch/orbital-core';
import {
  isConservativelyExcluded,
  SATCAT_EARTH_RADIUS_KM,
  footprintHalfAngleDeg,
} from './execute.js';

/** mulberry32 — small seeded PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const THRESHOLDS = [-5, 0, 5, 10, 30, 60];

describe('sweep prefilter — brute-force conservativeness', () => {
  it('never excludes an object that can exceed the threshold (600k seeded samples)', () => {
    const rnd = prng(0xc0ffee);
    let excluded = 0;
    let nearMiss = 0; // excluded, yet within 1 deg of the threshold
    let maxExcludedElev = -Infinity;
    const N = 600_000;
    for (let n = 0; n < N; n++) {
      const eps = THRESHOLDS[Math.floor(rnd() * THRESHOLDS.length)];
      const inc = rnd() < 0.2 ? 90 + rnd() * 90 : rnd() * 90;
      const incFolded = inc <= 90 ? inc : 180 - inc;
      const apogeeKm = 200 + Math.pow(rnd(), 2) * 40_000;
      const satR = SATCAT_EARTH_RADIUS_KM + 100 + rnd() * (apogeeKm - 100); // perigee >= ~100 km alt
      const altKm = -0.5 + rnd() * 9.5;
      const lonO = rnd() * 360 - 180;

      let latO: number;
      let dLon: number;
      if (rnd() < 0.5) {
        latO = rnd() * 180 - 90;
        dLon = rnd() * 360 - 180;
      } else {
        // Near the footprint edge: just beyond the highest latitude the satellite reaches.
        const lam = footprintHalfAngleDeg(6371, satR, eps);
        const sgn = rnd() < 0.5 ? 1 : -1;
        latO = Math.max(-90, Math.min(90, sgn * (incFolded + lam + (rnd() * 8 - 4))));
        dLon = rnd() < 0.5 ? (rnd() * 4 - 2) : rnd() * 360 - 180;
      }

      if (!isConservativelyExcluded({ latDeg: latO, lonDeg: lonO, altKm }, eps, inc, apogeeKm)) continue;
      excluded++;

      // Try many satellite positions in the allowed latitude band; take the best elevation.
      const obs = observerEcef({ latDeg: latO, lonDeg: lonO, altKm });
      for (let k = 0; k < 3; k++) {
        const u = Math.pow(rnd(), 0.2) * (rnd() < 0.5 ? 1 : -1); // biased toward the extremes
        const satLat = u * incFolded;
        // Prefer the satellite's sub-point on the observer's meridian side (min central angle).
        const satLon = lonO + (rnd() < 0.7 ? rnd() * 6 - 3 : rnd() * 360 - 180);
        const r = satR / ER_KM;
        const cl = Math.cos(satLat * RAD);
        const state = {
          r: { x: r * cl * Math.cos(satLon * RAD), y: r * cl * Math.sin(satLon * RAD), z: r * Math.sin(satLat * RAD) },
          v: { x: 0, y: 0, z: 0 },
        };
        const la = lookAngles(state, obs);
        assert.ok(la);
        const elev = Math.asin(Math.max(-1, Math.min(1, la.sinElevation))) * DEG;
        if (elev > maxExcludedElev) maxExcludedElev = elev;
        if (elev > eps - 1) nearMiss++;
        assert.ok(
          elev <= eps,
          `excluded but elev ${elev} > ${eps}: lat=${latO} alt=${altKm} inc=${inc} apo=${apogeeKm} satLat=${satLat} r=${satR}`,
        );
      }
    }
    assert.ok(excluded > 5_000, `test must exercise exclusions (got ${excluded})`);
    assert.ok(nearMiss > 0, 'test must probe near-threshold cases');
  });

  it('fails open on non-finite or out-of-range inputs', () => {
    const o = { latDeg: 80, lonDeg: 0 };
    assert.equal(isConservativelyExcluded(o, NaN, 0, 400), false);
    assert.equal(isConservativelyExcluded(o, 10, NaN, 400), false);
    assert.equal(isConservativelyExcluded(o, 10, 0, Infinity), false);
    assert.equal(isConservativelyExcluded(o, 200, 0, 400), false);
    assert.equal(isConservativelyExcluded(o, 10, -1, 400), false);
  });

  it('excludes the obvious case and keeps the obvious one', () => {
    assert.equal(isConservativelyExcluded({ latDeg: 85, lonDeg: 0 }, 10, 51.6, 420), true);
    assert.equal(isConservativelyExcluded({ latDeg: 45, lonDeg: 0 }, 10, 51.6, 420), false);
    // Polar observer, retrograde i=98 folds to 82 -> reaches ~82 N.
    assert.equal(isConservativelyExcluded({ latDeg: 80, lonDeg: 0 }, 10, 98, 700), false);
  });
});
