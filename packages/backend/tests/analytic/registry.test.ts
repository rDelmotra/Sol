// P3 S0 — DataSourceRegistry tests (fixtures only; real providers land S1-S3).
// Spec: my_plans/marvin/p3/S0_contracts_registry.md "Tests" #5-8.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSourceRegistry } from '../../src/analytic/registry.js';
import type { FieldProvider, SpineProvider } from '../../src/analytic/types.js';

function spineOf(ids: number[]): SpineProvider {
  return { id: 'fixture:spine', spine: () => ids };
}

const SPINE10 = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10

/** Serves 'name' for noradIds 1-6 only. */
const providerA: FieldProvider = {
  id: 'fixture:a',
  fields: ['name'],
  getField: (noradId, field) => (field === 'name' && noradId >= 1 && noradId <= 6 ? `A${noradId}` : null),
};

/** Fills the 'name' gap for noradIds 7-8 (9-10 stay uncovered by anyone). */
const providerB: FieldProvider = {
  id: 'fixture:b',
  fields: ['name'],
  getField: (noradId, field) => (field === 'name' && noradId >= 7 && noradId <= 8 ? `B${noradId}` : null),
};

describe('DataSourceRegistry — registration guards', () => {
  it('duplicate spine registration throws', () => {
    const reg = new DataSourceRegistry();
    reg.registerSpine('live', spineOf([1]));
    assert.throws(() => reg.registerSpine('live', spineOf([2])));
  });

  it('unknown field claim throws', () => {
    const reg = new DataSourceRegistry();
    const bad: FieldProvider = { id: 'fixture:bogus', fields: ['warpFactor'], getField: () => null };
    assert.throws(() => reg.register('live', bad));
  });

  it('declared fn without a matching method throws', () => {
    const reg = new DataSourceRegistry();
    const bad: FieldProvider = {
      id: 'fixture:no-method',
      fields: [],
      fns: ['elevationDeg'],
      getField: () => null,
      // elevationDeg intentionally omitted
    };
    assert.throws(() => reg.register('live', bad));
  });
});

describe('DataSourceRegistry — chain order + coverage', () => {
  it('chain order: first-non-null wins; coverage is chain coverage, not the first provider\'s', () => {
    const reg = new DataSourceRegistry();
    reg.registerSpine('live', spineOf(SPINE10));
    reg.register('live', providerA);
    reg.register('live', providerB);

    const source = reg.buildSource('live')!;
    // id 3 -> served by A; id 7 -> A returns null, B fills it.
    const i3 = source.noradToIndex(3)!;
    const i7 = source.noradToIndex(7)!;
    assert.equal(source.getField(i3, 'name', Date.now()), 'A3');
    assert.equal(source.getField(i7, 'name', Date.now()), 'B7');

    const snap = reg.snapshot();
    const nameCap = snap.universes[0].fields.find((f) => f.field === 'name')!;
    // A alone covers 6/10; combined chain covers 8/10 (ids 9,10 stay null).
    assert.equal(nameCap.coverage, 0.8);
  });

  it('snapshot() coverage math on a 10-object fixture spine with known nulls', () => {
    const reg = new DataSourceRegistry();
    reg.registerSpine('live', spineOf(SPINE10));
    reg.register('live', providerA);
    reg.register('live', providerB);
    const snap = reg.snapshot();
    assert.equal(snap.universes.length, 1);
    assert.equal(snap.universes[0].spineSize, 10);
    const nameCap = snap.universes[0].fields.find((f) => f.field === 'name')!;
    assert.equal(nameCap.servedBy, 'fixture:a+fixture:b');
    assert.equal(nameCap.coverage, 0.8);
  });

  it('the expandability test (exit criterion, executable): a 3rd provider registers with zero other changes', () => {
    const reg = new DataSourceRegistry();
    reg.registerSpine('live', spineOf(SPINE10));
    reg.register('live', providerA);
    reg.register('live', providerB);

    // A future domain (weather-style) lands as ONE new provider serving a
    // REAL registry field for a subset — nothing else changes.
    const fixtureWeather: FieldProvider = {
      id: 'fixture:weather',
      fields: ['purpose'],
      getField: (noradId, field) => (field === 'purpose' && noradId === 1 ? 'space_science' : null),
    };
    reg.register('live', fixtureWeather);

    const snap = reg.snapshot();
    const purposeCap = snap.universes[0].fields.find((f) => f.field === 'purpose')!;
    assert.ok(purposeCap, 'new field must appear in the snapshot with zero other wiring');
    assert.equal(purposeCap.servedBy, 'fixture:weather');
    assert.equal(purposeCap.coverage, 1 / 10);

    const source = reg.buildSource('live')!;
    const i1 = source.noradToIndex(1)!;
    assert.equal(source.getField(i1, 'purpose', Date.now()), 'space_science');
  });
});

describe('DataSourceRegistry — topValues (D-1: measured string vocabulary)', () => {
  it('counts distinct values for a string-kind field and orders them by frequency, most frequent first', () => {
    const reg = new DataSourceRegistry();
    reg.registerSpine('live', spineOf(SPINE10));
    // 'program' is FIELD_REGISTRY kind:'string'. 5x starlink, 3x cosmos, 1x kuiper, 1 uncovered.
    const providerProgram: FieldProvider = {
      id: 'fixture:program',
      fields: ['program'],
      getField: (noradId, field) => {
        if (field !== 'program') return null;
        if (noradId <= 5) return 'starlink';
        if (noradId <= 8) return 'cosmos';
        if (noradId === 9) return 'kuiper';
        return null;
      },
    };
    reg.register('live', providerProgram);

    const snap = reg.snapshot();
    const cap = snap.universes[0].fields.find((f) => f.field === 'program')!;
    assert.deepEqual(cap.topValues, ['starlink', 'cosmos', 'kuiper']);
  });

  it('never attaches topValues to a non-string-kind field', () => {
    const reg = new DataSourceRegistry();
    reg.registerSpine('live', spineOf(SPINE10));
    // 'inclination' is kind:'number'.
    const providerIncl: FieldProvider = {
      id: 'fixture:incl',
      fields: ['inclination'],
      getField: (noradId, field) => (field === 'inclination' ? 51.6 : null),
    };
    reg.register('live', providerIncl);

    const snap = reg.snapshot();
    const cap = snap.universes[0].fields.find((f) => f.field === 'inclination')!;
    assert.equal(cap.topValues, undefined);
  });

  it('skips topValues (stores nothing) when a string field is effectively unique per object', () => {
    const ids = Array.from({ length: 2001 }, (_, i) => i + 1);
    const reg = new DataSourceRegistry();
    reg.registerSpine('live', spineOf(ids));
    // 'name' is kind:'string'; every object gets a distinct value -> 2001 distinct > ceiling.
    const providerUniqueName: FieldProvider = {
      id: 'fixture:unique-name',
      fields: ['name'],
      getField: (noradId, field) => (field === 'name' ? `OBJ-${noradId}` : null),
    };
    reg.register('live', providerUniqueName);

    const snap = reg.snapshot();
    const cap = snap.universes[0].fields.find((f) => f.field === 'name')!;
    assert.equal(cap.topValues, undefined);
    assert.equal(cap.coverage, 1, 'coverage measurement itself is unaffected by the vocabulary skip');
  });

  it('caps topValues at 40 entries, keeping the most frequent', () => {
    // 45 distinct 'program' values; value vK appears (K+1) times, so v44 is most
    // frequent (45x) and v0 least frequent (1x). Top 40 by frequency excludes v0-v4.
    const reg = new DataSourceRegistry();
    const ids: number[] = [];
    let nextId = 1;
    const idToValue = new Map<number, string>();
    for (let k = 0; k < 45; k++) {
      const count = k + 1;
      for (let c = 0; c < count; c++) {
        idToValue.set(nextId, `v${k}`);
        ids.push(nextId);
        nextId++;
      }
    }
    reg.registerSpine('live', spineOf(ids));
    const provider: FieldProvider = {
      id: 'fixture:program45',
      fields: ['program'],
      getField: (noradId, field) => (field === 'program' ? idToValue.get(noradId) ?? null : null),
    };
    reg.register('live', provider);

    const snap = reg.snapshot();
    const cap = snap.universes[0].fields.find((f) => f.field === 'program')!;
    assert.equal(cap.topValues?.length, 40);
    assert.equal(cap.topValues?.[0], 'v44', 'most frequent value first');
    assert.ok(!cap.topValues?.includes('v0'), 'least-frequent values beyond the top 40 are dropped');
    assert.ok(!cap.topValues?.includes('v4'), 'least-frequent values beyond the top 40 are dropped');
    assert.ok(cap.topValues?.includes('v5'), '40th-most-frequent value is kept');
  });
});
