// Real-SGP4 check of the analytic sweep prefilter (isConservativelyExcluded):
// across ~300 real catalog objects x a latitude grid x several instants, an
// exclusion must never hide an elevation above the threshold. Skips when the
// local catalog cache is absent (CI / fresh checkout).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as satellite from 'satellite.js';
import { isConservativelyExcluded } from '@orbitwatch/analytic';
import { createLivePlane, stateFromKm, type StateEr } from '@orbitwatch/orbital-core';
import { backendDataDir } from '../../src/utils/paths.js';
import path from 'node:path';

const CACHE = path.join(backendDataDir(), 'tle-cache.json');

interface Row { noradId: number; omm: Record<string, unknown>; apogee?: number; inclination?: number }

describe('sweep prefilter vs real SGP4', { skip: !existsSync(CACHE) }, () => {
  it('no exclusion hides an elevation above the threshold', () => {
    const all = (JSON.parse(readFileSync(CACHE, 'utf8')) as Row[]).filter(
      (o) => typeof o.apogee === 'number' && typeof o.inclination === 'number',
    );
    // Deterministic stride sample (~300), plus all of the lowest/highest-inclination extremes.
    const stride = Math.max(1, Math.floor(all.length / 280));
    const sample = all.filter((_, i) => i % stride === 0);
    const byInc = [...all].sort((a, b) => a.inclination! - b.inclination!);
    sample.push(...byInc.slice(-10), ...byInc.slice(0, 5));

    const recs = new Map<number, satellite.SatRec>();
    for (const o of sample) {
      try { recs.set(o.noradId, satellite.json2satrec(o.omm as never)); } catch { /* skip bad elset */ }
    }
    const plane = createLivePlane<number>((id, tMs): StateEr | null => {
      const rec = recs.get(id);
      if (!rec) return null;
      const r = satellite.propagate(rec, new Date(tMs));
      const p = r?.position; const v = r?.velocity;
      if (!p || !v || typeof p === 'boolean' || typeof v === 'boolean' || !Number.isFinite(p.x)) return null;
      return stateFromKm({ x: p.x, y: p.y, z: p.z }, { x: v.x, y: v.y, z: v.z });
    });

    let excluded = 0;
    let checked = 0;
    const lats = Array.from({ length: 25 }, (_, i) => -90 + i * 7.5);
    for (const o of sample) {
      const rec = recs.get(o.noradId);
      if (!rec) continue;
      const epochMs = Date.parse(o.omm.EPOCH as string);
      if (!Number.isFinite(epochMs)) continue;
      for (const thr of [0, 10]) {
        for (const lat of lats) {
          if (!isConservativelyExcluded({ latDeg: lat, lonDeg: 0, altKm: 0 }, thr, o.inclination!, o.apogee!)) continue;
          excluded++;
          for (const dtH of [0, 5, 11, 17, 23]) {
            for (const lon of [-120, 0, 90]) {
              const e = plane.elevationDeg(o.noradId, { latDeg: lat, lonDeg: lon, altKm: 0 }, epochMs + dtH * 3_600_000);
              if (e === null) continue;
              checked++;
              assert.ok(e <= thr, `norad ${o.noradId} excluded at lat ${lat} thr ${thr} but elev ${e} (dt ${dtH}h lon ${lon})`);
            }
          }
        }
      }
    }
    assert.ok(excluded > 100 && checked > 1000, `exercised too little: excluded=${excluded} checked=${checked}`);
  });
});
