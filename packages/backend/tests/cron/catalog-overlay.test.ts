// The CelesTrak overlay: pure merge rules, plus the 6-digit id path through the builder.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { overlayCatalog } from '../../src/cache/catalog-overlay.js';
import { buildFromCelesTrak } from '../../src/cron/tle-updater.js';
import { celesTrakGp } from './gp-fixtures.js';

function obj(noradId: number, epoch: string, name = `OBJ ${noradId}`): EnrichedTLEObject {
  return { noradId, name, epoch } as unknown as EnrichedTLEObject;
}

describe('overlayCatalog', () => {
  const cached = [
    obj(1, '2026-10-10T00:00:00.000000Z', 'cached 1'),
    obj(2, '2026-10-10T00:00:00.000000Z', 'cached 2'),
    obj(3, '2026-10-10T00:00:00.000000Z', 'cached 3'),
  ];

  it('a newer CelesTrak epoch replaces the cached object', () => {
    const r = overlayCatalog(cached, [obj(1, '2026-10-11T00:00:00.000000Z', 'fresh 1')]);
    assert.equal(r.catalog.find((o) => o.noradId === 1)?.name, 'fresh 1');
    assert.equal(r.replaced, 1);
    assert.equal(r.added, 0);
  });

  it('an older or equal CelesTrak epoch never replaces', () => {
    const r = overlayCatalog(cached, [
      obj(1, '2026-10-09T00:00:00.000000Z', 'older 1'),
      obj(2, '2026-10-10T00:00:00.000000Z', 'equal 2'),
    ]);
    assert.equal(r.catalog.find((o) => o.noradId === 1)?.name, 'cached 1');
    assert.equal(r.catalog.find((o) => o.noradId === 2)?.name, 'cached 2');
    assert.equal(r.replaced, 0);
  });

  it('epochs are compared as times, not as text (different fraction lengths)', () => {
    const r = overlayCatalog(
      [obj(1, '2026-10-10T00:00:00.5Z', 'cached')],
      [obj(1, '2026-10-10T00:00:00.123456Z', 'fresh')],
    );
    assert.equal(r.catalog[0].name, 'cached', '.123 is older than .5');
  });

  it('an id that is not cached is added; every other cached object stays untouched', () => {
    const r = overlayCatalog(cached, [obj(99, '2026-10-11T00:00:00.000000Z', 'new 99')]);
    assert.equal(r.catalog.length, 4);
    assert.equal(r.added, 1);
    assert.equal(r.catalog[3].name, 'new 99');
    for (let i = 0; i < 3; i++) assert.strictEqual(r.catalog[i], cached[i]);
  });

  it('the result is never smaller than the cache', () => {
    const r = overlayCatalog(cached, []);
    assert.equal(r.catalog.length, cached.length);
    const r2 = overlayCatalog(cached, [obj(7, '2026-10-11T00:00:00.000000Z')]);
    assert.ok(r2.catalog.length >= cached.length);
  });

  it('does not change its inputs', () => {
    const before = JSON.stringify(cached);
    overlayCatalog(cached, [obj(1, '2027-01-01T00:00:00.000000Z'), obj(50, '2027-01-01T00:00:00.000000Z')]);
    assert.equal(JSON.stringify(cached), before);
  });

  it('no cache: the result is just the CelesTrak records', () => {
    const fresh = [obj(5, '2026-10-11T00:00:00.000000Z'), obj(6, '2026-10-11T00:00:00.000000Z')];
    for (const none of [null, []]) {
      const r = overlayCatalog(none, fresh);
      assert.equal(r.catalog.length, 2);
      assert.equal(r.added, 2);
      assert.equal(r.replaced, 0);
    }
  });

  it('duplicates inside the CelesTrak set keep the newest epoch', () => {
    const r = overlayCatalog(null, [
      obj(5, '2026-10-11T00:00:00.000000Z', 'old'),
      obj(5, '2026-10-12T00:00:00.000000Z', 'new'),
    ]);
    assert.equal(r.catalog.length, 1);
    assert.equal(r.catalog[0].name, 'new');
  });

  it('a cached object with an unreadable epoch is replaced by any readable one', () => {
    const r = overlayCatalog([obj(1, 'garbage', 'broken')], [obj(1, '2026-10-11T00:00:00.000000Z', 'fresh')]);
    assert.equal(r.catalog[0].name, 'fresh');
  });

  it('6-digit catalog numbers behave like any other id', () => {
    const r = overlayCatalog([obj(100001, '2026-10-10T00:00:00.000000Z', 'six old')], [
      obj(100001, '2026-10-11T00:00:00.000000Z', 'six new'),
      obj(100002, '2026-10-11T00:00:00.000000Z', 'six added'),
    ]);
    assert.deepEqual(
      r.catalog.map((o) => [o.noradId, o.name]),
      [
        [100001, 'six new'],
        [100002, 'six added'],
      ],
    );
  });
});

describe('buildFromCelesTrak — catalog numbers of 100000 and up', () => {
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
});
