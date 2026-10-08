import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { TimelineController, type TimelineHost } from './TimelineController';
import { useStore } from '../../store/useStore';
import { simClock } from '../SimClock';
import type { TleCatalogResult } from '../../data/tle-client';

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
  /** catalog the controller reported at each dsoSetHidden call */
  catalogAtDso: number[];
  ctl: () => TimelineController;
}

function makeFake(): Fake {
  const calls: string[] = [];
  const state = { disposed: false, halted: false };
  const catalogAtDso: number[] = [];
  let ctl: TimelineController;
  const host: TimelineHost = {
    isDisposed: () => state.disposed,
    isHalted: () => state.disposed || state.halted,
    onCatalogSwapped: (c) => calls.push(`swapped:${c.length}`),
    satellitesSetHidden: (h) => calls.push(`satHidden:${h}`),
    satellitesReseed: (c) => calls.push(`reseed:${c.length}`),
    satellitesSnap: () => calls.push('snap'),
    dsoSetHidden: (h) => {
      catalogAtDso.push(ctl.getCatalog().length);
      calls.push(`dsoHidden:${h}`);
    },
    refreshOrbitTrail: () => calls.push('trail'),
  };
  ctl = new TimelineController({ apiUrl: '', host });
  return { host, calls, state, catalogAtDso, ctl: () => ctl };
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

  assert.deepEqual(f.calls, ['satHidden:true', 'dsoHidden:true', 'swapped:0', 'store', 'trail']);
  assert.deepEqual(f.catalogAtDso, [0], 'catalog already empty when DSO is hidden');
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
  // reseed -> swapped -> dso hide, in that order
  const i = f.calls.lastIndexOf('reseed:3');
  assert.equal(f.calls[i + 1], 'swapped:3');
  assert.match(f.calls[i + 2], /^dsoHidden:/);
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
