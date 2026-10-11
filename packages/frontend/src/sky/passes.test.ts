import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as satellite from 'satellite.js';
import type { OMMJsonObject } from 'satellite.js';
import {
  lookAnglesAt,
  findPasses,
  isPassInProgress,
  pickCurrentPass,
  DEFAULT_MIN_ELEVATION_DEG,
  COARSE_STEP_SEC,
  MAX_HORIZON_WALK_MS,
  type PassObserver,
  type Pass,
} from './passes';

// ============================================================
// There is no reference implementation to diff against, so these tests lean on
// properties that must hold regardless of the exact search parameters: the
// sub-satellite point must read ~90° elevation (validates the whole look-angle
// chain independently), passes must be internally consistent (AOS < peak <
// LOS, boundary elevation ≈ threshold, peak really is the max), and the coarse
// search must agree with an much finer manual sweep (nothing skipped between
// samples).
// ============================================================

const EPOCH_ISO = '2026-07-10T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);

function mkOmm(over?: Record<string, unknown>): OMMJsonObject {
  return {
    OBJECT_NAME: 'TESTSAT',
    OBJECT_ID: '1998-067A',
    EPOCH: EPOCH_ISO,
    MEAN_MOTION: 15.5,
    ECCENTRICITY: 0.0005,
    INCLINATION: 51.6,
    RA_OF_ASC_NODE: 100,
    ARG_OF_PERICENTER: 90,
    MEAN_ANOMALY: 270,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 100,
    BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0.0001,
    MEAN_MOTION_DDOT: 0,
    ...over,
  } as unknown as OMMJsonObject;
}

function mkGeoOmm(over?: Record<string, unknown>): OMMJsonObject {
  return mkOmm({
    NORAD_CAT_ID: 40000,
    MEAN_MOTION: 1.0027,
    INCLINATION: 0,
    ECCENTRICITY: 0,
    RA_OF_ASC_NODE: 0,
    ARG_OF_PERICENTER: 0,
    MEAN_ANOMALY: 0,
    BSTAR: 0,
    MEAN_MOTION_DOT: 0,
    ...over,
  });
}

/** Sub-satellite geodetic point at `atMs`, computed independently of passes.ts. */
function subSatellitePoint(omm: OMMJsonObject, atMs: number): PassObserver {
  const satrec = satellite.json2satrec(omm);
  const date = new Date(atMs);
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') {
    throw new Error('propagation failed in test fixture setup');
  }
  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  return {
    latDeg: (geo.latitude * 180) / Math.PI,
    lonDeg: (geo.longitude * 180) / Math.PI,
    altKm: 0,
  };
}

const LEO_OMM = mkOmm();
const GEO_OMM = mkGeoOmm();

describe('passes: lookAnglesAt', () => {
  it('reads ~90° elevation directly under the satellite (validates the full look-angle chain)', () => {
    const atMs = EPOCH_MS + 30 * 60_000;
    const observer = subSatellitePoint(LEO_OMM, atMs);
    const look = lookAnglesAt(LEO_OMM, observer, atMs);
    assert.ok(look, 'expected a look-angle result');
    assert.ok(look.elevationDeg > 89.5, `expected ~90°, got ${look.elevationDeg}`);
  });

  it('returns azimuth normalised to [0, 360)', () => {
    const atMs = EPOCH_MS + 10 * 60_000;
    const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };
    const look = lookAnglesAt(LEO_OMM, observer, atMs);
    if (look) {
      assert.ok(look.azimuthDeg >= 0 && look.azimuthDeg < 360, `got ${look.azimuthDeg}`);
    }
  });

  it('returns null for a malformed element set', () => {
    const bad = mkOmm({ EPOCH: 'not-a-date' });
    const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };
    assert.equal(lookAnglesAt(bad, observer, EPOCH_MS), null);
  });

  it('returns null far outside the propagation window', () => {
    const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };
    const farMs = EPOCH_MS + 1000 * 86_400_000; // 1000 days — well past the 60-day cap
    assert.equal(lookAnglesAt(LEO_OMM, observer, farMs), null);
  });
});

describe('passes: findPasses — LEO from a mid-latitude observer', () => {
  const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };
  const horizonMs = 24 * 3600_000;
  const passes = findPasses(LEO_OMM, observer, EPOCH_MS, horizonMs);

  it('finds several passes over 24h', () => {
    assert.ok(passes.length >= 2, `expected several passes, got ${passes.length}`);
  });

  it('orders aosMs < peakMs < losMs within each pass, and orders passes non-overlapping', () => {
    for (const p of passes) {
      assert.ok(p.aosMs < p.peakMs, `aos ${p.aosMs} not before peak ${p.peakMs}`);
      assert.ok(p.peakMs < p.losMs, `peak ${p.peakMs} not before los ${p.losMs}`);
    }
    for (let i = 1; i < passes.length; i++) {
      assert.ok(passes[i].aosMs >= passes[i - 1].losMs, 'passes overlap or out of order');
    }
  });

  it('boundary elevation is close to the threshold for non-clipped passes', () => {
    for (const p of passes) {
      if (p.startClipped || p.endClipped) continue;
      const aosLook = lookAnglesAt(LEO_OMM, observer, p.aosMs);
      const losLook = lookAnglesAt(LEO_OMM, observer, p.losMs);
      assert.ok(aosLook, 'aos should be propagatable');
      assert.ok(losLook, 'los should be propagatable');
      assert.ok(
        Math.abs(aosLook.elevationDeg - DEFAULT_MIN_ELEVATION_DEG) < 0.1,
        `aos elevation ${aosLook.elevationDeg} not close to threshold`,
      );
      assert.ok(
        Math.abs(losLook.elevationDeg - DEFAULT_MIN_ELEVATION_DEG) < 0.1,
        `los elevation ${losLook.elevationDeg} not close to threshold`,
      );
    }
  });

  it('peak elevation is really the maximum within the pass', () => {
    for (const p of passes) {
      assert.ok(p.peakElevationDeg >= DEFAULT_MIN_ELEVATION_DEG - 1e-6);
      const span = p.losMs - p.aosMs;
      for (let f = 0.1; f < 1; f += 0.1) {
        const t = p.aosMs + f * span;
        const look = lookAnglesAt(LEO_OMM, observer, t);
        if (!look) continue;
        assert.ok(
          p.peakElevationDeg >= look.elevationDeg - 1e-3,
          `peak ${p.peakElevationDeg} not >= sample ${look.elevationDeg} at f=${f}`,
        );
      }
    }
  });

  it('pass durations are plausible for LEO (roughly 2–20 minutes)', () => {
    for (const p of passes) {
      const durationMin = (p.losMs - p.aosMs) / 60_000;
      assert.ok(durationMin > 1 && durationMin < 25, `implausible duration ${durationMin} min`);
    }
  });

  it('all azimuths are within [0, 360)', () => {
    for (const p of passes) {
      for (const az of [p.aosAzimuthDeg, p.peakAzimuthDeg, p.losAzimuthDeg]) {
        assert.ok(az >= 0 && az < 360, `azimuth out of range: ${az}`);
      }
    }
  });

  it('respects maxPasses', () => {
    const capped = findPasses(LEO_OMM, observer, EPOCH_MS, horizonMs, { maxPasses: 1 });
    assert.ok(capped.length <= 1);
  });
});

describe('passes: findPasses — step independence', () => {
  it('finds the same AOS times with the default coarse step as with a much finer manual sweep', () => {
    const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };
    const horizonMs = 3 * 3600_000; // ~2 orbits
    const coarse = findPasses(LEO_OMM, observer, EPOCH_MS, horizonMs);

    // Manual fine sweep, well under COARSE_STEP_SEC, to make sure nothing was
    // skipped between coarse samples.
    const fineStepMs = 2000;
    assert.ok(fineStepMs < COARSE_STEP_SEC * 1000);
    const fineAos: number[] = [];
    let prevMargin: number | null = null;
    for (let t = EPOCH_MS; t <= EPOCH_MS + horizonMs; t += fineStepMs) {
      const look = lookAnglesAt(LEO_OMM, observer, t);
      if (!look) continue;
      const margin = look.elevationDeg - DEFAULT_MIN_ELEVATION_DEG;
      if (prevMargin !== null && prevMargin < 0 && margin >= 0) {
        fineAos.push(t);
      }
      prevMargin = margin;
    }

    const coarseAos = coarse.filter((p) => !p.startClipped).map((p) => p.aosMs);
    assert.equal(coarseAos.length, fineAos.length, 'coarse and fine sweeps found a different number of passes');
    for (let i = 0; i < coarseAos.length; i++) {
      assert.ok(
        Math.abs(coarseAos[i] - fineAos[i]) < fineStepMs + COARSE_STEP_SEC * 1000,
        `AOS mismatch at pass ${i}: coarse ${coarseAos[i]} vs fine ${fineAos[i]}`,
      );
    }
  });
});

describe('passes: findPasses — GEO edge cases', () => {
  it('a GEO object is never visible from a polar observer', () => {
    const observer: PassObserver = { latDeg: 85, lonDeg: 0, altKm: 0 };
    const passes = findPasses(GEO_OMM, observer, EPOCH_MS, 24 * 3600_000);
    assert.deepEqual(passes, []);
  });

  it('a GEO object seen from beneath it (equatorial observer) is permanently above the horizon', () => {
    const sub = subSatellitePoint(GEO_OMM, EPOCH_MS);
    const observer: PassObserver = { latDeg: 0, lonDeg: sub.lonDeg, altKm: 0 };
    const horizonMs = 6 * 3600_000;
    const passes = findPasses(GEO_OMM, observer, EPOCH_MS, horizonMs);
    assert.equal(passes.length, 1);
    const [p] = passes;
    assert.equal(p.startClipped, true);
    assert.equal(p.endClipped, true);
    assert.equal(p.aosMs, EPOCH_MS);
    assert.equal(p.losMs, EPOCH_MS + horizonMs);
    assert.ok(p.peakElevationDeg > 80, `expected near-zenith elevation, got ${p.peakElevationDeg}`);
  });
});

describe('passes: findPasses — horizon span', () => {
  const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };
  const horizonMs = 24 * 3600_000;
  const passes = findPasses(LEO_OMM, observer, EPOCH_MS, horizonMs);

  it('finds the geometric horizon strictly outside the 10° AOS/LOS, with ~0° elevation there', () => {
    const nonClipped = passes.filter((p) => !p.startClipped && !p.endClipped);
    assert.ok(nonClipped.length >= 1, 'expected at least one non-clipped pass to test against');
    for (const p of nonClipped) {
      assert.ok(p.horizonAosMs < p.aosMs, `horizonAosMs ${p.horizonAosMs} not before aosMs ${p.aosMs}`);
      assert.ok(p.horizonLosMs > p.losMs, `horizonLosMs ${p.horizonLosMs} not after losMs ${p.losMs}`);

      const aosHorizonLook = lookAnglesAt(LEO_OMM, observer, p.horizonAosMs);
      const losHorizonLook = lookAnglesAt(LEO_OMM, observer, p.horizonLosMs);
      assert.ok(aosHorizonLook, 'horizonAosMs should be propagatable');
      assert.ok(losHorizonLook, 'horizonLosMs should be propagatable');
      assert.ok(
        Math.abs(aosHorizonLook.elevationDeg) < 0.1,
        `horizon AOS elevation ${aosHorizonLook.elevationDeg} not close to 0°`,
      );
      assert.ok(
        Math.abs(losHorizonLook.elevationDeg) < 0.1,
        `horizon LOS elevation ${losHorizonLook.elevationDeg} not close to 0°`,
      );
    }
  });

  it('the horizonAosMs <= aosMs and horizonLosMs >= losMs invariant holds across every pass found', () => {
    assert.ok(passes.length >= 2, `expected several passes, got ${passes.length}`);
    for (const p of passes) {
      assert.ok(p.horizonAosMs <= p.aosMs, `invariant broken: ${p.horizonAosMs} > ${p.aosMs}`);
      assert.ok(p.horizonLosMs >= p.losMs, `invariant broken: ${p.horizonLosMs} < ${p.losMs}`);
    }
  });

  it('falls back to a well-ordered pass, not an inverted or NaN interval, when the horizon crossing is unreachable', () => {
    // A GEO object seen from directly beneath it never drops below the 10°
    // threshold, let alone 0°, within MAX_HORIZON_WALK_MS in either direction
    // — the walk exhausts its bound and must fall back to the given endpoint.
    const sub = subSatellitePoint(GEO_OMM, EPOCH_MS);
    const geoObserver: PassObserver = { latDeg: 0, lonDeg: sub.lonDeg, altKm: 0 };
    const geoHorizonMs = 6 * 3600_000;
    const geoPasses = findPasses(GEO_OMM, geoObserver, EPOCH_MS, geoHorizonMs);
    assert.equal(geoPasses.length, 1);
    const [p] = geoPasses;

    assert.ok(Number.isFinite(p.horizonAosMs), 'horizonAosMs must be finite');
    assert.ok(Number.isFinite(p.horizonLosMs), 'horizonLosMs must be finite');
    assert.ok(p.horizonAosMs <= p.aosMs, 'invariant must hold even in the fallback path');
    assert.ok(p.horizonLosMs >= p.losMs, 'invariant must hold even in the fallback path');
    // Both ends are clipped by the search/propagation window well before
    // MAX_HORIZON_WALK_MS could find a real 0° crossing, so the walk gives up
    // and returns the given bound unchanged.
    assert.equal(p.horizonAosMs, p.aosMs);
    assert.equal(p.horizonLosMs, p.losMs);
    assert.ok(MAX_HORIZON_WALK_MS > 0);
  });
});

describe('passes: findPasses — robustness', () => {
  it('a malformed OMM returns [] and never throws', () => {
    const bad = mkOmm({ EPOCH: 'not-a-date' });
    const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };
    assert.doesNotThrow(() => {
      const passes = findPasses(bad, observer, EPOCH_MS, 24 * 3600_000);
      assert.deepEqual(passes, []);
    });
  });

  it('an object that never rises above threshold returns []', () => {
    // A polar observer under a GEO belt never sees it — reuses the property
    // above but asserted here as the "[] means never rises" contract.
    const observer: PassObserver = { latDeg: 89, lonDeg: 0, altKm: 0 };
    const passes: Pass[] = findPasses(GEO_OMM, observer, EPOCH_MS, 24 * 3600_000);
    assert.deepEqual(passes, []);
  });
});

describe('passes: findPasses — a pass already in progress at fromMs', () => {
  const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };
  const full = findPasses(LEO_OMM, observer, EPOCH_MS, 24 * 3600_000).find((p) => !p.startClipped && !p.endClipped);

  it('starts the first pass at fromMs, marks only its start clipped, and keeps the real set', () => {
    assert.ok(full, 'expected a complete pass to start from');
    const fromMs = full.peakMs; // mid-pass: well above the threshold
    const passes = findPasses(LEO_OMM, observer, fromMs, 3 * 3600_000);
    assert.ok(passes.length >= 1);
    const [p] = passes;
    assert.equal(p.startClipped, true);
    assert.equal(p.endClipped, false);
    assert.equal(p.aosMs, fromMs);
    assert.ok(Math.abs(p.losMs - full.losMs) <= 2000, `los ${p.losMs} vs ${full.losMs}`);
    // The geometric rise is before the window and is still found.
    assert.ok(Math.abs(p.horizonAosMs - full.horizonAosMs) <= 2000, `horizon aos ${p.horizonAosMs} vs ${full.horizonAosMs}`);
    assert.ok(isPassInProgress(p, fromMs));
    assert.equal(pickCurrentPass(passes, fromMs), p);
    for (const later of passes.slice(1)) assert.equal(later.startClipped, false);
  });
});

describe('passes: look angles agree with satellite.js ecfToLookAngles', () => {
  // Pinned element set (LEO_OMM). satellite.js uses WGS72 for the observer;
  // we use WGS84 (orbital-core). The gap is accepted (state/DECISIONS.md D4)
  // and must stay under 0.1°.
  const observer: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 1.6 };
  const satrec = satellite.json2satrec(LEO_OMM);

  function reference(atMs: number): { elevationDeg: number; azimuthDeg: number; rangeKm: number } | null {
    const date = new Date(atMs);
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    const look = satellite.ecfToLookAngles(
      { latitude: (observer.latDeg * Math.PI) / 180, longitude: (observer.lonDeg * Math.PI) / 180, height: observer.altKm },
      ecf,
    );
    return {
      elevationDeg: (look.elevation * 180) / Math.PI,
      azimuthDeg: ((((look.azimuth * 180) / Math.PI) % 360) + 360) % 360,
      rangeKm: look.rangeSat,
    };
  }

  it('elevation and azimuth within 0.1° across a day of samples (above and below the horizon)', () => {
    let compared = 0;
    for (let t = EPOCH_MS; t < EPOCH_MS + 24 * 3600_000; t += 7 * 60_000) {
      const ours = lookAnglesAt(LEO_OMM, observer, t);
      const ref = reference(t);
      assert.ok(ours && ref);
      assert.ok(Math.abs(ours.elevationDeg - ref.elevationDeg) <= 0.1, `elevation ${ours.elevationDeg} vs ${ref.elevationDeg}`);
      // Azimuth is meaningless near the zenith; skip the rare near-overhead sample.
      if (ref.elevationDeg < 85) {
        const dAz = Math.abs(((ours.azimuthDeg - ref.azimuthDeg + 540) % 360) - 180);
        assert.ok(dAz <= 0.1, `azimuth ${ours.azimuthDeg} vs ${ref.azimuthDeg}`);
      }
      assert.ok(Math.abs(ours.rangeKm - ref.rangeKm) <= 1, `range ${ours.rangeKm} vs ${ref.rangeKm}`);
      compared++;
    }
    assert.ok(compared > 100);
  });
});
