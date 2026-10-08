import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UMBRA_RADIUS_ER,
  geodeticToEcefEr,
  geodeticUpEcef,
  altitudeKmFromEr,
  latitudeDegFromEr,
  geocentricLatitudeDegFromEr,
  WGS84_A_KM,
  WGS84_INV_F,
  WGS84_F,
  WGS84_B_KM,
  WGS84_E2,
  geodeticLatAltFromEr,
} from './earth.js';
import { ER_KM } from './units.js';

const km = (v: { x: number; y: number; z: number }) => ({
  x: v.x * ER_KM,
  y: v.y * ER_KM,
  z: v.z * ER_KM,
});
const near = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} (tol ${tol})`);

// All reference numbers below come from /tmp/s4b/ref.py (pure python, NOT the code
// under test): forward = reduced-latitude parametric (tanβ=(1-f)tanφ, ρ=a cosβ+h cosφ,
// z=b sinβ+h sinφ); inverse = 200-iteration fixed-point (φ=atan2(z, ρ(1-e²N/(N+h)))).
describe('earth: constants', () => {
  it('UMBRA_RADIUS_ER = WGS84 a / ER_KM = 6378.137/6371 = 1.0011202323026211', () => {
    assert.equal(UMBRA_RADIUS_ER, WGS84_A_KM / ER_KM);
    near(UMBRA_RADIUS_ER, 1.0011202323026211, 1e-15);
  });
});

describe('earth: geodeticToEcefEr', () => {
  it('|position| matches the independent WGS84 reference (37.4N, -122.1E)', () => {
    const ref: Array<[number, number]> = [
      [0, 0.999888530373696],
      [100, 1.0155845724150063],
      [500, 1.0783687641647302],
    ];
    for (const [altKm, expected] of ref) {
      const p = geodeticToEcefEr({ latDeg: 37.4, lonDeg: -122.1, altKm });
      const mag = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      assert.ok(Math.abs(mag - expected) < 1e-12, `|p| ${mag} vs ${expected}`);
    }
  });

  it('defaults altKm to 0 when omitted', () => {
    const withAlt = geodeticToEcefEr({ latDeg: 10, lonDeg: 20, altKm: 0 });
    const withoutAlt = geodeticToEcefEr({ latDeg: 10, lonDeg: 20 });
    assert.deepEqual(withoutAlt, withAlt);
  });
});

describe('earth: geodeticUpEcef', () => {
  it('is a unit vector tilted from the position by (geodetic - geocentric) latitude', () => {
    const g = { latDeg: 51.5074, lonDeg: -0.1278 };
    const p = geodeticToEcefEr(g);
    const up = geodeticUpEcef(g);
    const upMag = Math.sqrt(up.x * up.x + up.y * up.y + up.z * up.z);
    assert.ok(Math.abs(upMag - 1) < 1e-15, `|up| = ${upMag}`);

    const pMag = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    const angleDeg = Math.acos((p.x * up.x + p.y * up.y + p.z * up.z) / pMag) * (180 / Math.PI);
    // phi - psi = 51.5074 - asin(z/|p|) = 0.18762217268756132 deg (ref.py).
    near(angleDeg, 0.18762217268756132, 1e-9);
  });
});

describe('earth: altitudeKmFromEr', () => {
  it('recovers altitude from an equatorial radial position (a + 400 km -> 400 km)', () => {
    const r = { x: (WGS84_A_KM + 400) / ER_KM, y: 0, z: 0 };
    near(altitudeKmFromEr(r), 400, 1e-9);
  });

  it('|r| = 1 ER is below the surface at the equator (6371 - 6378.137 = -7.137 km) and above it at the pole (6371 - 6356.752314245 = +14.247686 km)', () => {
    near(altitudeKmFromEr({ x: 1, y: 0, z: 0 }), -7.137, 1e-6);
    near(altitudeKmFromEr({ x: 0, y: 0, z: 1 }), 14.24768575482085, 1e-6);
  });
});

describe('earth: latitudeDegFromEr (geodetic)', () => {
  it('is 90 at the north pole, -90 at the south pole, 0 at the equator', () => {
    assert.ok(Math.abs(latitudeDegFromEr({ x: 0, y: 0, z: 1 })! - 90) < 1e-9);
    assert.ok(Math.abs(latitudeDegFromEr({ x: 0, y: 0, z: -1 })! - -90) < 1e-9);
    assert.ok(Math.abs(latitudeDegFromEr({ x: 1, y: 0, z: 0 })! - 0) < 1e-9);
  });

  it('is rotation-about-z invariant (valid on TEME input, not just ECEF)', () => {
    const ecef = { x: 0.6, y: 0.3, z: 0.5 };
    const theta = 1.234;
    const rotated = {
      x: ecef.x * Math.cos(theta) - ecef.y * Math.sin(theta),
      y: ecef.x * Math.sin(theta) + ecef.y * Math.cos(theta),
      z: ecef.z,
    };
    assert.ok(Math.abs(latitudeDegFromEr(ecef)! - latitudeDegFromEr(rotated)!) < 1e-12);
  });

  it('is geodetic: geocentric-45deg r=6778 km -> 45.180767355 deg (ref.py inverse)', () => {
    const c = Math.cos(Math.PI / 4);
    near(latitudeDegFromEr({ x: (6778 * c) / ER_KM, y: 0, z: (6778 * c) / ER_KM }) as number, 45.180767355486466, 1e-9);
  });

  it('returns null for the zero vector', () => {
    assert.equal(latitudeDegFromEr({ x: 0, y: 0, z: 0 }), null);
  });
});

// ---- WGS84 reference values computed independently (python, 200-iteration
// ---- fixed-point inverse; closed-form forward) — not by the code under test.

describe('earth: WGS84 constants', () => {
  it('match the defining values and derived b, e2', () => {
    assert.equal(WGS84_A_KM, 6378.137);
    assert.equal(WGS84_INV_F, 298.257223563);
    near(WGS84_F, 1 / 298.257223563, 1e-18);
    near(WGS84_B_KM, 6356.752314245179, 1e-9);
    near(WGS84_E2, 0.0066943799901413165, 1e-17);
  });
});

describe('earth: geodeticToEcefEr (forward, reference vectors)', () => {
  const cases: Array<[string, number, number, number, number, number, number]> = [
    ['equator/prime', 0, 0, 0, 6378.137, 0, 0],
    ['north pole', 90, 0, 0, 0, 0, 6356.752314],
    ['45N 45E', 45, 45, 0, 3194.419145, 3194.419145, 4487.348409],
    ['45N 0E 1km', 45, 0, 1, 4518.297986, 0, 4488.055516],
  ];
  for (const [name, lat, lon, alt, x, y, z] of cases) {
    it(name, () => {
      const p = km(geodeticToEcefEr({ latDeg: lat, lonDeg: lon, altKm: alt }));
      near(p.x, x, 1e-5);
      near(p.y, y, 1e-5);
      near(p.z, z, 1e-5);
    });
  }
  it('defaults altKm to 0', () => {
    const a = geodeticToEcefEr({ latDeg: 30, lonDeg: 10 });
    const b = geodeticToEcefEr({ latDeg: 30, lonDeg: 10, altKm: 0 });
    assert.deepEqual(a, b);
  });
});

describe('earth: geodeticLatAltFromEr (inverse)', () => {
  const toEr = (x: number, y: number, z: number) => ({ x: x / ER_KM, y: y / ER_KM, z: z / ER_KM });

  it('geocentric-45deg r=6778 km -> phi=45.180767355, h=410.580100 km', () => {
    const c = Math.cos(Math.PI / 4);
    const out = geodeticLatAltFromEr(toEr(6778 * c, 0, 6778 * c));
    near(out.latDeg as number, 45.180767355, 1e-6);
    near(out.altKm, 410.5801, 1e-3);
  });
  it('GEO radius on equator: h=35785.863 km', () => {
    const out = geodeticLatAltFromEr(toEr(42164, 0, 0));
    near(out.latDeg as number, 0, 1e-12);
    near(out.altKm, 35785.863, 1e-3);
  });
  it('(2 ER,0,0): h=6363.863 km', () => {
    const out = geodeticLatAltFromEr({ x: 2, y: 0, z: 0 });
    near(out.altKm, 6363.863, 1e-3);
  });
  it('max(geodetic - parametric... geocentric) lat difference at surface = 0.192424 deg near 45.1', () => {
    let best = 0;
    let bestPhi = 0;
    for (let phi = 44; phi <= 46.2; phi += 0.001) {
      const geoc = geocentricLatitudeDegFromEr(geodeticToEcefEr({ latDeg: phi, lonDeg: 0 })) as number;
      if (phi - geoc > best) {
        best = phi - geoc;
        bestPhi = phi;
      }
    }
    near(best, 0.192424, 1e-6);
    near(bestPhi, 45.1, 0.05);
  });
  it('origin -> null lat, altKm = -a', () => {
    const out = geodeticLatAltFromEr({ x: 0, y: 0, z: 0 });
    assert.equal(out.latDeg, null);
    assert.equal(out.altKm, -WGS84_A_KM);
  });
  it('poles (rho = 0): lat +/-90, finite, correct height', () => {
    for (const s of [1, -1]) {
      const out = geodeticLatAltFromEr({ x: 0, y: 0, z: (s * (WGS84_B_KM + 100)) / ER_KM });
      near(out.latDeg as number, s * 90, 1e-9);
      near(out.altKm, 100, 1e-6);
    }
  });
});

describe('earth: WGS84 round-trip grid', () => {
  const lats = [-90, -89.999, -80, -60, -45.1, -30, -1, 0, 1, 15, 30, 45, 45.1, 60, 80, 89.999, 90];
  const lons = [-180, -90, 0, 90, 179.9];
  const alts = [-0.5, 0, 0.4, 20, 400, 35786, 384400];
  it('recovers lat < 1e-9 deg and height < 1 mm everywhere', () => {
    for (const latDeg of lats)
      for (const lonDeg of lons)
        for (const altKm of alts) {
          const out = geodeticLatAltFromEr(geodeticToEcefEr({ latDeg, lonDeg, altKm }));
          assert.ok(out.latDeg !== null && Number.isFinite(out.latDeg) && Number.isFinite(out.altKm));
          const tag = `lat=${latDeg} lon=${lonDeg} h=${altKm}`;
          near(out.latDeg as number, latDeg, 1e-9, tag);
          near(out.altKm, altKm, 1e-6, tag);
        }
  });
  it('negative height near surface (-50 km) round-trips', () => {
    for (const latDeg of [-90, -45, 0, 45, 90]) {
      const out = geodeticLatAltFromEr(geodeticToEcefEr({ latDeg, lonDeg: 20, altKm: -50 }));
      near(out.latDeg as number, latDeg, 1e-9);
      near(out.altKm, -50, 1e-6);
    }
  });
  it('is invariant under rotation about z (TEME vs ECEF)', () => {
    const base = geodeticToEcefEr({ latDeg: 37.3, lonDeg: 12, altKm: 550 });
    const ref = geodeticLatAltFromEr(base);
    for (const ang of [0.3, 1.7, -2.9, 5.1]) {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const rot = { x: c * base.x - s * base.y, y: s * base.x + c * base.y, z: base.z };
      const out = geodeticLatAltFromEr(rot);
      near(out.latDeg as number, ref.latDeg as number, 1e-11);
      near(out.altKm, ref.altKm, 1e-8);
    }
  });
});
