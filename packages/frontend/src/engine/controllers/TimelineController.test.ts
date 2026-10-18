import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { TimelineController, type TimelineHost } from './TimelineController';
import { useStore } from '../../store/useStore';
import { simClock } from '../../time/SimClock';
import type { TleCatalogResult } from '../../data/tle-client';
import type { DsoObject } from '../../data/dso-types';

const obj = (noradId: number) => ({ noradId, name: `SAT-${noradId}`, omm: {} }) as unknown as EnrichedTLEObject;

const counts = {
  categoryCounts: {
    active_satellite: 0, inactive_satellite: 0, rocket_body: 0, debris: 0, unknown: 0, deep_space: 0,
  },
  regimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },
  facetCounts: {},
};
const live = (ids: number[]): TleCatalogResult =>
  ({ catalogData: ids.map(obj), tles: [], ...counts }) as unknown as TleCatalogResult;

interface Fake {
  host: TimelineHost;
  calls: string[];
  state: { disposed: boolean; halted: boolean };
  ctl: () => TimelineController;
}

function makeFake(): Fake {
  const calls: string[] = [];
  const state = { disposed: false, halted: false };
  let ctl: TimelineController;
  const host: TimelineHost = {
    isDisposed: () => state.disposed,
    isHalted: () => state.disposed || state.halted,
    onCatalogSwapped: (c) => calls.push(`swapped:${c.length}`),
    satellitesSetHidden: (h) => calls.push(`satHidden:${h}`),
    satellitesReseed: (c) => calls.push(`reseed:${c.length}`),
    satellitesSnap: () => calls.push('snap'),
    refreshOrbitTrail: () => calls.push('trail'),
  };
  ctl = new TimelineController({ apiUrl: '', host });
  return { host, calls, state, ctl: () => ctl };
}

const DAY = 86_400_000;
// Real "now" is read through Date.now(); mocked Date makes everything deterministic.
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  simClock.reset();
  // performance.now() is tiny in a fresh process; keep it past the scrub-debounce window.
  mock.method(performance, 'now', () => 100_000);
  // History off → past views are planetarium.
  mock.method(globalThis, 'fetch', async () => ({ ok: false }) as Response);
  useStore.setState({ historyCoverage: null, planetarium: false });
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

/** Spin microtasks so the awaited reseed chain settles. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('installLive owns the catalog and notifies the host', () => {
  const f = makeFake();
  f.ctl().installLive(live([1, 2, 3]));
  assert.equal(f.ctl().getCatalog().length, 3);
  assert.deepEqual(f.calls, ['swapped:3']);
});

test('hidden path: catalog emptied first, hooks in order, before store writes; planetarium on', async () => {
  const f = makeFake();
  const c = f.ctl();
  c.installLive(live([1, 2, 3]));
  f.calls.length = 0;
  useStore.getState().setSelectedSatellite(1, obj(2));

  // Record store writes relative to host calls.
  const unsub = useStore.subscribe(() => {
    if (!f.calls.includes('store')) f.calls.push('store');
  });

  simClock.jumpTo(new Date(NOW - 30 * DAY)); // uncovered past → hidden
  c.reconcileCatalogForTime();
  mock.timers.tick(200);
  await flush();
  unsub();

  assert.deepEqual(f.calls, ['satHidden:true', 'swapped:0', 'store', 'trail']);
  assert.equal(c.getCatalog().length, 0);
  assert.equal(useStore.getState().planetarium, true);
  assert.equal(useStore.getState().selectedSatellite, null);
});

test('live restore re-selects by noradId and clears planetarium', async () => {
  const f = makeFake();
  const c = f.ctl();
  c.installLive(live([10, 20, 30]));
  useStore.getState().setSelectedSatellite(2, obj(30));

  simClock.jumpTo(new Date(NOW - 30 * DAY));
  c.reconcileCatalogForTime();
  mock.timers.tick(200);
  await flush();
  assert.equal(useStore.getState().planetarium, true);

  simClock.reset();
  c.reconcileCatalogForTime();
  mock.timers.tick(200);
  await flush();

  assert.equal(useStore.getState().planetarium, false);
  assert.equal(c.getCatalog().length, 3);
  assert.equal(useStore.getState().selectedIndex, 2);
  assert.equal(useStore.getState().selectedSatellite?.noradId, 30);
  assert.ok(f.calls.includes('satHidden:false'));
  assert.ok(f.calls.includes('reseed:3'));
  // reseed -> swapped (the host re-syncs DSO pick IDs there), in that order
  const i = f.calls.lastIndexOf('reseed:3');
  assert.equal(f.calls[i + 1], 'swapped:3');
});

test('DSOs are never hidden: planetarium and restore swaps keep the DSO selection and resync via onCatalogSwapped', async () => {
  const f = makeFake();
  const c = f.ctl();
  c.installLive(live([1, 2, 3]));
  const dso = { dsoId: 'artemis-ii' } as unknown as DsoObject;
  useStore.getState().setSelectedDso(dso);
  f.calls.length = 0;

  // Planetarium (no coverage): TLE count goes to 0, the DSO selection survives.
  simClock.jumpTo(new Date(NOW - 30 * DAY));
  c.reconcileCatalogForTime();
  mock.timers.tick(200);
  await flush();
  assert.equal(useStore.getState().planetarium, true);
  assert.equal(useStore.getState().selectedDso, dso);
  assert.ok(f.calls.includes('swapped:0'), 'host resyncs DSO pick IDs against TLE count 0');

  // Back to live: TLE count restored, DSO still selected.
  simClock.reset();
  c.reconcileCatalogForTime();
  mock.timers.tick(200);
  await flush();
  assert.ok(f.calls.includes('swapped:3'));
  assert.equal(useStore.getState().selectedDso, dso);
  assert.ok(!f.calls.some((x) => x.startsWith('dso')), 'the host has no DSO hide call');
});

test('glide completes: lands live, goLive, catalog restored', async () => {
  const f = makeFake();
  const c = f.ctl();
  c.installLive(live([1, 2]));
  // Move to the hidden planetarium first.
  simClock.jumpTo(new Date(NOW - 30 * DAY));
  c.reconcileCatalogForTime();
  mock.timers.tick(200);
  await flush();
  assert.equal(c.getCatalog().length, 0);

  let perf = 1000;
  (performance.now as unknown as { mock: { mockImplementation(f: () => number): void } }).mock.mockImplementation(() => perf);
  c.startGlideToLive();
  assert.equal(c.isGliding(), true);

  perf += 600;
  c.tickFrame();
  assert.equal(c.isGliding(), true);

  perf += 700; // past 1200 ms
  c.tickFrame();
  assert.equal(c.isGliding(), false);
  await flush();
  assert.equal(useStore.getState().viewMode, 'live');
  assert.equal(useStore.getState().planetarium, false);
  assert.equal(c.getCatalog().length, 2);
});

test('halted: public entry points early-out', () => {
  const f = makeFake();
  const c = f.ctl();
  c.installLive(live([1]));
  f.calls.length = 0;
  f.state.halted = true;
  simClock.jumpTo(new Date(NOW - 30 * DAY));
  c.startGlideToLive();
  assert.equal(c.isGliding(), false);
  c.onScrubPreview();
  c.reconcileCatalogForTime();
  mock.timers.tick(1000);
  assert.deepEqual(f.calls, []);
  assert.equal(c.getCatalog().length, 1);
});

test('dispose clears the pending reconcile timer', () => {
  const f = makeFake();
  const c = f.ctl();
  c.installLive(live([1]));
  f.calls.length = 0;
  simClock.jumpTo(new Date(NOW - 30 * DAY));
  c.reconcileCatalogForTime();
  c.dispose();
  mock.timers.tick(1000);
  assert.deepEqual(f.calls, []);
});
