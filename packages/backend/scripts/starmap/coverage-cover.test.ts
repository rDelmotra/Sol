import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellKey, ecefToTeme, gmst, geodeticToEcefEr, ER_KM, SHELL_DELTA0, WGS84_A_KM } from '@orbitwatch/orbital-core';
import { rng } from './catalog.js';
import { INDIA_POLY, inPoly, GRANS, POLY_LAT_MIN, POLY_LAT_MAX, POLY_LON_MIN, POLY_LON_MAX } from './coverage-lib.js';
import { polygonPixelsByTenMin, groupPixels, shellRange, cellsOf } from './coverage-cover.js';

const DAY0 = Date.parse('2026-10-18T00:00:00Z');

// Random ground-volume points (inside India, any height from below ground to 60,000 km, any instant of the
// day, plus points ON the polygon edges and vertices) must always land in the cover of their period.
for (const order of [2, 3, 4]) {
  test(`India-in-star-map cover is conservative, order ${order}`, () => {
    const tenMin = polygonPixelsByTenMin(order, DAY0);
    const grouped = GRANS.map((g) => groupPixels(tenMin, g));
    const [nkLo, nkHi] = shellRange(order, 2300, 70000);
    const covers = grouped.map((g) => g.map((px) => new Set(cellsOf(order, px, nkLo, nkHi))));
    const r = rng(1234 + order);
    let checked = 0;
    for (let n = 0; n < 12000; n++) {
      let lat: number, lon: number;
      if (n % 3 === 0) { // on an edge, nudged very slightly inside/outside the plain polygon
        const i = Math.floor(r() * INDIA_POLY.length), u = r();
        const a = INDIA_POLY[i]!, b = INDIA_POLY[(i + 1) % INDIA_POLY.length]!;
        lat = a[0] + (b[0] - a[0]) * u; lon = a[1] + (b[1] - a[1]) * u;
        if (!inPoly(lat, lon)) { lat += (a[0] - b[0]) * 1e-6; lon += (a[1] - b[1]) * 1e-6; if (!inPoly(lat, lon)) continue; }
      } else {
        lat = POLY_LAT_MIN + r() * (POLY_LAT_MAX - POLY_LAT_MIN); lon = POLY_LON_MIN + r() * (POLY_LON_MAX - POLY_LON_MIN);
        if (!inPoly(lat, lon)) continue;
      }
      const alt = Math.exp(Math.log(0.5) + r() * (Math.log(60000) - Math.log(0.5))) - 20; // -19.5 .. 60,000 km
      const t = DAY0 + Math.floor(r() * 86_400_000);
      const e = geodeticToEcefEr({ latDeg: lat, lonDeg: lon, altKm: alt });
      const v = ecefToTeme(e, gmst(t));
      const key = cellKey(order, v.x * ER_KM, v.y * ER_KM, v.z * ER_KM);
      if (key === null) continue;
      const rr = Math.hypot(v.x, v.y, v.z) * ER_KM;
      if (rr < WGS84_A_KM * Math.exp(-SHELL_DELTA0)) continue;
      for (let g = 0; g < GRANS.length; g++) {
        const p = Math.min(GRANS[g]!.perDay - 1, Math.floor((t - DAY0) / GRANS[g]!.periodMs));
        assert.ok(covers[g]![p]!.has(key), `order ${order} ${GRANS[g]!.name} period ${p} misses key ${key} (lat ${lat}, lon ${lon}, alt ${alt}, t ${t - DAY0})`);
      }
      checked++;
    }
    assert.ok(checked > 3000);
  });
}
