// The CelesTrak overlay: pure merge rules, the orbit-only merge that keeps cached metadata,
// and the 6-digit id path through the builder. CelesTrak's GP JSON has only the 17 OMM keys.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { overlayCatalog } from '../../src/cache/catalog-overlay.js';
import { buildFromCelesTrak, buildFromSpaceTrack, mergeNewerOrbit } from '../../src/cron/tle-updater.js';
import { summarizeOrbit } from '../../src/utils/orbit-summary.js';
import { CELESTRAK_KEYS, celesTrakGp, issLikeCelesTrak, issLikeSpaceTrack } from './gp-fixtures.js';

function obj(noradId: number, epoch: string, name = `OBJ ${noradId}`): EnrichedTLEObject {
  return { noradId, name, epoch } as unknown as EnrichedTLEObject;
}

/** The generic overlay tests only care about WHICH object wins; the merge just returns the newer one. */
const takeNewer = (_cached: EnrichedTLEObject, newer: EnrichedTLEObject) => newer;

describe('overlayCatalog', () => {
  const cached = [
    obj(1, '2026-10-10T00:00:00.000000Z', 'cached 1'),
    obj(2, '2026-10-10T00:00:00.000000Z', 'cached 2'),
    obj(3, '2026-10-10T00:00:00.000000Z', 'cached 3'),
  ];

  it('a newer CelesTrak epoch is handed to the merge together with the cached object', () => {
    const seen: Array<[string, string]> = [];
    const r = overlayCatalog(cached, [obj(1, '2026-10-11T00:00:00.000000Z', 'fresh 1')], (c, n) => {
      seen.push([c.name, n.name]);
      return { ...c, epoch: n.epoch };
    });
    assert.deepEqual(seen, [['cached 1', 'fresh 1']]);
    assert.equal(r.catalog.find((o) => o.noradId === 1)?.name, 'cached 1');
    assert.equal(r.catalog.find((o) => o.noradId === 1)?.epoch, '2026-10-11T00:00:00.000000Z');
    assert.equal(r.replaced, 1);
    assert.equal(r.added, 0);
  });

  it('an older or equal CelesTrak epoch never reaches the merge', () => {
    const r = overlayCatalog(
      cached,
      [obj(1, '2026-10-09T00:00:00.000000Z', 'older 1'), obj(2, '2026-10-10T00:00:00.000000Z', 'equal 2')],
      () => assert.fail('merge must not be called'),
    );
    assert.equal(r.catalog.find((o) => o.noradId === 1)?.name, 'cached 1');
    assert.equal(r.catalog.find((o) => o.noradId === 2)?.name, 'cached 2');
    assert.equal(r.replaced, 0);
  });

  it('epochs are compared as times, not as text (different fraction lengths)', () => {
    const r = overlayCatalog(
      [obj(1, '2026-10-10T00:00:00.5Z', 'cached')],
      [obj(1, '2026-10-10T00:00:00.123456Z', 'fresh')],
      takeNewer,
    );
    assert.equal(r.catalog[0].name, 'cached', '.123 is older than .5');
  });

  it('an id that is not cached is added as built; every other cached object stays untouched', () => {
    const r = overlayCatalog(cached, [obj(99, '2026-10-11T00:00:00.000000Z', 'new 99')], takeNewer);
    assert.equal(r.catalog.length, 4);
    assert.equal(r.added, 1);
    assert.equal(r.catalog[3].name, 'new 99');
    for (let i = 0; i < 3; i++) assert.strictEqual(r.catalog[i], cached[i]);
  });

  it('the result is never smaller than the cache', () => {
    const r = overlayCatalog(cached, [], takeNewer);
    assert.equal(r.catalog.length, cached.length);
    const r2 = overlayCatalog(cached, [obj(7, '2026-10-11T00:00:00.000000Z')], takeNewer);
    assert.ok(r2.catalog.length >= cached.length);
  });

  it('does not change its inputs', () => {
    const before = JSON.stringify(cached);
    overlayCatalog(
      cached,
      [obj(1, '2027-01-01T00:00:00.000000Z'), obj(50, '2027-01-01T00:00:00.000000Z')],
      mergeNewerOrbit,
    );
    assert.equal(JSON.stringify(cached), before);
  });

  it('no cache: the result is just the CelesTrak records', () => {
    const fresh = [obj(5, '2026-10-11T00:00:00.000000Z'), obj(6, '2026-10-11T00:00:00.000000Z')];
    for (const none of [null, []]) {
      const r = overlayCatalog(none, fresh, takeNewer);
      assert.equal(r.catalog.length, 2);
      assert.equal(r.added, 2);
      assert.equal(r.replaced, 0);
    }
  });

  it('duplicates inside the CelesTrak set keep the newest epoch', () => {
    const r = overlayCatalog(
      null,
      [obj(5, '2026-10-11T00:00:00.000000Z', 'old'), obj(5, '2026-10-12T00:00:00.000000Z', 'new')],
      takeNewer,
    );
    assert.equal(r.catalog.length, 1);
    assert.equal(r.catalog[0].name, 'new');
  });

  it('a cached object with an unreadable epoch is updated by any readable one', () => {
    const r = overlayCatalog(
      [obj(1, 'garbage', 'broken')],
      [obj(1, '2026-10-11T00:00:00.000000Z', 'fresh')],
      (c, n) => ({ ...c, epoch: n.epoch }),
    );
    assert.equal(r.catalog[0].epoch, '2026-10-11T00:00:00.000000Z');
  });

  it('6-digit catalog numbers behave like any other id', () => {
    const r = overlayCatalog(
      [obj(100001, '2026-10-10T00:00:00.000000Z', 'six old')],
      [obj(100001, '2026-10-11T00:00:00.000000Z', 'six new'), obj(100002, '2026-10-11T00:00:00.000000Z', 'six added')],
      takeNewer,
    );
    assert.deepEqual(
      r.catalog.map((o) => [o.noradId, o.name]),
      [
        [100001, 'six new'],
        [100002, 'six added'],
      ],
    );
  });
});

describe('summarizeOrbit — the period and apsides CelesTrak does not send', () => {
  it('matches Space-Track for an ISS-like orbit: 15.5 rev/day is about 92.9 minutes', () => {
    const st = issLikeSpaceTrack();
    const s = summarizeOrbit(15.5, 0.0005);
    assert.ok(s);
    assert.ok(Math.abs(s.period - parseFloat(st.PERIOD)) < 0.01, `period ${s.period} vs ${st.PERIOD}`);
    assert.ok(Math.abs(s.period - 92.9) < 0.05);
    // apsides are altitudes above the surface; Space-Track uses WGS72 constants (about 0.005 km apart)
    assert.ok(Math.abs(s.apogee - parseFloat(st.APOAPSIS)) < 0.05, `apogee ${s.apogee} vs ${st.APOAPSIS}`);
    assert.ok(Math.abs(s.perigee - parseFloat(st.PERIAPSIS)) < 0.05, `perigee ${s.perigee} vs ${st.PERIAPSIS}`);
    assert.ok(s.apogee > s.perigee);
  });

  it('a geostationary orbit comes out at about 35786 km', () => {
    const s = summarizeOrbit(1.0027379, 0);
    assert.ok(s);
    assert.ok(Math.abs(s.apogee - 35786) < 5, String(s.apogee));
    assert.ok(Math.abs(s.period - 1436.07) < 0.05, String(s.period));
  });

  it('refuses elements that are not a bound orbit', () => {
    assert.equal(summarizeOrbit(0, 0.1), null);
    assert.equal(summarizeOrbit(-1, 0.1), null);
    assert.equal(summarizeOrbit(15, 1), null);
    assert.equal(summarizeOrbit(15, -0.1), null);
    assert.equal(summarizeOrbit(Number.NaN, 0.1), null);
  });
});

describe('CelesTrak overlay keeps the cached metadata (the record has only 17 keys)', () => {
  /** A cached, fully enriched object as Space-Track built it. */
  const cachedIss = (): EnrichedTLEObject => buildFromSpaceTrack([issLikeSpaceTrack()])[0];

  it('the fixture really has only the 17 OMM keys', () => {
    assert.deepEqual(Object.keys(issLikeCelesTrak()).sort(), [...CELESTRAK_KEYS].sort());
    assert.deepEqual(Object.keys(celesTrakGp(1)[0]).sort(), [...CELESTRAK_KEYS].sort());
  });

  it('a newer record updates the orbit, period, apsides and regime and keeps type, country, launch date and size', () => {
    const cached = cachedIss();
    assert.equal(cached.objectType, 'satellite');
    assert.equal(cached.countryCode, 'ISS');
    assert.equal(cached.launchDate, '1998-11-20');
    assert.equal(cached.rcsSize, 'LARGE');
    assert.equal(cached.regime, 'LEO');

    // a changed orbit: mean motion 14.0 rev/day (higher, 102.86 min), ecc 0.01
    const newer = buildFromCelesTrak([
      issLikeCelesTrak({ MEAN_MOTION: 14.0, ECCENTRICITY: 0.01, INCLINATION: 51.7, MEAN_ANOMALY: 12.5 }),
    ]);
    const r = overlayCatalog([cached], newer, mergeNewerOrbit);
    assert.equal(r.replaced, 1);
    const out = r.catalog[0];

    // orbit data and what derives from it moved
    assert.equal(out.epoch, '2026-10-11T12:00:00.000000Z');
    assert.equal(out.omm.MEAN_MOTION, 14.0);
    assert.equal(out.omm.ECCENTRICITY, 0.01);
    assert.equal(out.omm.MEAN_ANOMALY, 12.5);
    assert.equal(out.inclination, 51.7);
    assert.ok(Math.abs(out.period - 1440 / 14) < 1e-9);
    const expected = summarizeOrbit(14.0, 0.01)!;
    assert.equal(out.apogee, expected.apogee);
    assert.equal(out.perigee, expected.perigee);
    assert.ok(out.apogee > out.perigee + 100, 'ecc 0.01 gives a clearly eccentric orbit');
    assert.equal(out.regime, 'LEO');

    // everything CelesTrak does not carry stayed
    assert.equal(out.objectType, 'satellite');
    assert.equal(out.category, cached.category);
    assert.equal(out.countryCode, 'ISS');
    assert.equal(out.launchDate, '1998-11-20');
    assert.equal(out.rcsSize, 'LARGE');
    assert.equal(out.name, cached.name);
    assert.deepEqual(out.sectors, cached.sectors);
    assert.equal(out.purpose, cached.purpose);
    assert.equal(out.status, cached.status);
  });

  it('the period it computes matches Space-Track\'s PERIOD within 0.01 minute for the same orbit', () => {
    const cached = cachedIss();
    const newer = buildFromCelesTrak([issLikeCelesTrak()]); // same 15.5 rev/day, ecc 0.0005 as the Space-Track fixture
    const out = overlayCatalog([cached], newer, mergeNewerOrbit).catalog[0];
    assert.ok(Math.abs(out.period - parseFloat(issLikeSpaceTrack().PERIOD)) < 0.01, String(out.period));
    assert.ok(Math.abs(out.period - 92.9) < 0.05);
    assert.ok(Math.abs(out.apogee - cached.apogee) < 0.05, `${out.apogee} vs ${cached.apogee}`);
    assert.ok(Math.abs(out.perigee - cached.perigee) < 0.05, `${out.perigee} vs ${cached.perigee}`);
  });

  it('the regime follows the NEW orbit (an object raised from LEO to MEO changes regime)', () => {
    const cached = cachedIss();
    assert.equal(cached.regime, 'LEO');
    // 2.0 rev/day = 720 min, near circular: MEO
    const newer = buildFromCelesTrak([issLikeCelesTrak({ MEAN_MOTION: 2.0, ECCENTRICITY: 0.001 })]);
    assert.equal(overlayCatalog([cached], newer, mergeNewerOrbit).catalog[0].regime, 'MEO');
    // high eccentricity: HEO
    const heo = buildFromCelesTrak([issLikeCelesTrak({ MEAN_MOTION: 2.0, ECCENTRICITY: 0.74 })]);
    assert.equal(overlayCatalog([cached], heo, mergeNewerOrbit).catalog[0].regime, 'HEO');
  });

  it('an older or equal epoch is ignored: the cached object is returned as it was', () => {
    const cached = cachedIss();
    const older = buildFromCelesTrak([issLikeCelesTrak({ EPOCH: '2026-10-09T12:00:00.000000', MEAN_MOTION: 14.0 })]);
    const equal = buildFromCelesTrak([issLikeCelesTrak({ EPOCH: '2026-10-10T12:00:00.000000', MEAN_MOTION: 14.0 })]);
    for (const fresh of [older, equal]) {
      const r = overlayCatalog([cached], fresh, mergeNewerOrbit);
      assert.equal(r.replaced, 0);
      assert.strictEqual(r.catalog[0], cached);
    }
  });

  it('no cached field becomes undefined, null or empty: the key set and every non-orbit value stay', () => {
    const cached = cachedIss();
    const before = JSON.parse(JSON.stringify(cached)) as Record<string, unknown>;
    const newer = buildFromCelesTrak([issLikeCelesTrak({ MEAN_MOTION: 15.2 })]);
    const out = overlayCatalog([cached], newer, mergeNewerOrbit).catalog[0] as unknown as Record<string, unknown>;

    assert.deepEqual(Object.keys(out).sort(), Object.keys(before).sort(), 'same key set');
    const orbitKeys = new Set(['omm', 'epoch', 'inclination', 'period', 'apogee', 'perigee', 'regime']);
    for (const key of Object.keys(before)) {
      assert.notEqual(out[key], undefined, `${key} undefined`);
      if (before[key] !== null && before[key] !== '') {
        assert.notEqual(out[key], null, `${key} became null`);
        assert.notEqual(out[key], '', `${key} became empty`);
      }
      if (!orbitKeys.has(key)) assert.deepEqual(out[key], before[key], `${key} must stay as cached`);
    }
    assert.equal(JSON.stringify(cached), JSON.stringify(before), 'the cached input object is not changed');
  });

  it('mergeNewerOrbit never writes a missing or non-finite value over a cached one', () => {
    const cached = cachedIss();
    const hollow = { noradId: cached.noradId, name: 'x' } as unknown as EnrichedTLEObject;
    assert.deepEqual(mergeNewerOrbit(cached, hollow), cached);
    const nan = { ...hollow, period: Number.NaN, apogee: undefined, perigee: null } as unknown as EnrichedTLEObject;
    assert.deepEqual(mergeNewerOrbit(cached, nan), cached);
  });

  it('an id that is not cached is added with CelesTrak\'s data and the pipeline\'s unknown defaults', () => {
    const cached = cachedIss();
    const fresh = buildFromCelesTrak([issLikeCelesTrak({ NORAD_CAT_ID: 100_777, OBJECT_NAME: 'BRAND NEW' })]);
    const r = overlayCatalog([cached], fresh, mergeNewerOrbit);
    assert.equal(r.added, 1);
    assert.equal(r.catalog.length, 2);
    const added = r.catalog[1];
    assert.equal(added.noradId, 100_777);
    assert.equal(added.name, 'BRAND NEW');
    assert.equal(added.objectType, 'unknown');
    assert.equal(added.category, 'unknown');
    assert.equal(added.countryCode, '');
    assert.equal(added.launchDate, null);
    assert.equal(added.rcsSize, null);
    assert.equal(added.regime, 'LEO');
    // derived, not zero
    assert.ok(Math.abs(added.period - 92.9) < 0.05);
    assert.ok(added.apogee > 400 && added.apogee < 440);
    assert.equal(added.status, 'unknown');
    assert.deepEqual(added.sectors, []);
    for (const [k, v] of Object.entries(added)) assert.notEqual(v, undefined, k);
  });

  it('the catalog never shrinks', () => {
    const cached = [cachedIss(), ...buildFromCelesTrak(celesTrakGp(5))];
    const r = overlayCatalog(cached, buildFromCelesTrak([issLikeCelesTrak()]), mergeNewerOrbit);
    assert.equal(r.catalog.length, cached.length);
  });
});

describe('buildFromCelesTrak', () => {
  it('keeps a record with NORAD_CAT_ID 100001 and its number unchanged', () => {
    const records = celesTrakGp(2);
    records.push({ ...celesTrakGp(1)[0], NORAD_CAT_ID: 100001, OBJECT_NAME: 'SIX DIGIT SAT', OBJECT_ID: '2026-200A' });
    const built = buildFromCelesTrak(records);
    assert.equal(built.length, 3);
    const six = built.find((o) => o.noradId === 100001);
    assert.ok(six, '100001 survives');
    assert.equal(six.name, 'SIX DIGIT SAT');
    assert.equal(six.omm.NORAD_CAT_ID, 100001);
  });

  it('drops a record whose id is not a positive integer', () => {
    const bad = { ...celesTrakGp(1)[0], NORAD_CAT_ID: Number.NaN };
    assert.equal(buildFromCelesTrak([bad]).length, 0);
  });

  it('drops a decayed record when the data carries a DECAY_DATE, and does not need the field', () => {
    const live = celesTrakGp(1)[0];
    const decayed = { ...celesTrakGp(1, 81_000)[0], DECAY_DATE: '2026-09-01' };
    const built = buildFromCelesTrak([live, decayed]);
    assert.deepEqual(built.map((o) => o.noradId), [live.NORAD_CAT_ID]);
  });

  it('drops a record that is not a bound orbit instead of writing NaN', () => {
    assert.equal(buildFromCelesTrak([{ ...celesTrakGp(1)[0], MEAN_MOTION: 0 }]).length, 0);
    assert.equal(buildFromCelesTrak([{ ...celesTrakGp(1)[0], ECCENTRICITY: 1.2 }]).length, 0);
  });

  it('uses OBJECT_TYPE, COUNTRY_CODE and the like when a record happens to carry them', () => {
    const built = buildFromCelesTrak([
      { ...celesTrakGp(1)[0], OBJECT_TYPE: 'DEBRIS', COUNTRY_CODE: 'PRC', LAUNCH_DATE: '2020-01-02', RCS_SIZE: 'SMALL' },
    ]);
    assert.equal(built[0].objectType, 'debris');
    assert.equal(built[0].category, 'debris');
    assert.equal(built[0].countryCode, 'PRC');
    assert.equal(built[0].launchDate, '2020-01-02');
    assert.equal(built[0].rcsSize, 'SMALL');
  });
});
