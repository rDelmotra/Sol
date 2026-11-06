import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { TimelineController, type TimelineHost } from './TimelineController';
import { useStore } from '../../store/useStore';
import { simClock } from '../../time/SimClock';
import type { TleCatalogResult } from '../../data/tle-client';
import type { DsoObject } from '../../data/dso-types';
import type { ReplayClient } from '../../data/replay-client';
import type { HistoryCatalogResponse, HistoryRange } from '../../data/replay-types';
import { histObj } from '../../data/replay-fixtures';
import { REPLAY_MAX_TSINCE_MIN } from '../../data/replay-catalog';

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
  useStore.setState({
    historyCoverage: null,
    planetarium: false,
    replayRange: null,
    replayDay: null,
    replayAccuracy: null,
    replaySgpCount: 0,
    replayFragments: null,
    analyticFilter: { mode: 'all' },
    selectedIndex: null,
    selectedSatellite: null,
    historyLoading: false,
  });
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

// ── History REPLAY ───────────────────────────────────────────────────────────

interface FakeReplay {
  client: ReplayClient;
  prefetched: string[];
  fetched: string[];
}

function fakeReplay(range: HistoryRange | null, days: Record<string, HistoryCatalogResponse>): FakeReplay {
  const prefetched: string[] = [];
  const fetched: string[] = [];
  const memory = new Set<string>();
  const client: ReplayClient = {
    range: async () => range,
    catalog: async (day) => {
      fetched.push(day);
      memory.add(day);
      return days[day] ?? null;
    },
    prefetch: (day) => {
      prefetched.push(day);
      if (days[day]) memory.add(day);
    },
    hasInMemory: (day) => memory.has(day),
    timeline: async () => null,
    events: async () => null,
    clear: () => {},
  };
  return { client, prefetched, fetched };
}

const RANGE: HistoryRange = { firstDay: '1998-11-15', lastDay: '1998-12-31', days: 47, eventsFirstDay: null, eventsLastDay: null, hasCoverage: true };
const dayResp = (day: string, ids: number[], over: Partial<HistoryCatalogResponse> = {}): HistoryCatalogResponse => ({
  day,
  accuracy: { medianKm: 2.5, p95Km: 12 },
  objects: ids.map((n) => histObj(n, { intlDesignator: n >= 900 ? '1993-036B' : '1998-067A' })),
  ...over,
});

function makeReplayFake(range: HistoryRange | null, days: Record<string, HistoryCatalogResponse>) {
  const calls: string[] = [];
  const replay = fakeReplay(range, days);
  const host: TimelineHost = {
    isDisposed: () => false,
    isHalted: () => false,
    onCatalogSwapped: (c) => calls.push(`swapped:${c.length}`),
    satellitesSetHidden: (h) => calls.push(`satHidden:${h}`),
    satellitesReseed: (c, _t, maxT) => calls.push(`reseed:${c.length}:${maxT ?? 'live'}`),
    satellitesSnap: () => calls.push('snap'),
    refreshOrbitTrail: () => calls.push('trail'),
  };
  const ctl = new TimelineController({ apiUrl: '', host, replay: replay.client });
  return { ctl, calls, replay };
}

const settle = async () => {
  mock.timers.tick(200);
  await flush();
};

test('replay: entering a date > 30 d back installs that day’s archive catalog (wide window, accuracy, sgp count) and prefetches the next day', async () => {
  const f = makeReplayFake(RANGE, {
    '1998-11-20': dayResp('1998-11-20', [25544, 10, 20], { objects: [histObj(25544), histObj(10, { propagator: 'sgp' }), histObj(20)] }),
  });
  f.ctl.installLive(live([1, 2, 3, 4]));
  await flush();
  assert.equal(useStore.getState().replayRange?.firstDay, '1998-11-15');

  simClock.jumpTo(new Date('1998-11-20T15:00:00Z'));
  f.ctl.reconcileCatalogForTime();
  await settle();

  const s = useStore.getState();
  assert.equal(s.replayDay, '1998-11-20');
  assert.equal(s.historyDay, '1998-11-20');
  assert.deepEqual(s.replayAccuracy, { medianKm: 2.5, p95Km: 12 });
  assert.equal(s.replaySgpCount, 1);
  assert.equal(s.planetarium, false);
  assert.deepEqual(f.ctl.getCatalog().map((o) => o.noradId), [25544, 10, 20]);
  assert.ok(f.calls.includes(`reseed:3:${REPLAY_MAX_TSINCE_MIN}`), f.calls.join(','));
  assert.ok(f.replay.prefetched.includes('1998-11-21'));
  assert.equal(s.historyLoading, false);
});

test('replay: exit — back to now restores the live catalog and clears the replay state (no badge)', async () => {
  const f = makeReplayFake(RANGE, { '1998-11-20': dayResp('1998-11-20', [25544]) });
  f.ctl.installLive(live([1, 2, 3]));
  await flush();
  simClock.jumpTo(new Date('1998-11-20T15:00:00Z'));
  f.ctl.reconcileCatalogForTime();
  await settle();
  assert.equal(useStore.getState().replayDay, '1998-11-20');

  simClock.reset();
  f.ctl.reconcileCatalogForTime();
  await settle();
  const s = useStore.getState();
  assert.equal(s.replayDay, null);
  assert.equal(s.replayAccuracy, null);
  assert.equal(f.ctl.getCatalog().length, 3);
  assert.ok(f.calls.includes('reseed:3:live'));
});

test('replay: crossing midnight swaps to the prefetched day; survivors keep their slot and the selection follows by noradId', async () => {
  const f = makeReplayFake(RANGE, {
    '1998-11-20': dayResp('1998-11-20', [10, 20, 25544]),
    '1998-11-21': dayResp('1998-11-21', [10, 25544, 40]), // 20 decayed, 40 launched
  });
  f.ctl.installLive(live([1]));
  await flush();
  simClock.jumpTo(new Date('1998-11-20T23:59:00Z'));
  f.ctl.reconcileCatalogForTime();
  await settle();
  const zarya = f.ctl.getCatalog().findIndex((o) => o.noradId === 25544);
  useStore.getState().setSelectedSatellite(zarya, f.ctl.getCatalog()[zarya]);
  assert.ok(f.replay.prefetched.includes('1998-11-21') && f.replay.client.hasInMemory('1998-11-21'));

  let loadingSeen = false;
  const unsub = useStore.subscribe((s) => {
    if (s.historyLoading) loadingSeen = true;
  });
  simClock.jumpTo(new Date('1998-11-21T00:00:30Z'));
  f.ctl.reconcileCatalogForTime();
  await settle();
  unsub();

  const ids = f.ctl.getCatalog().map((o) => o.noradId);
  assert.deepEqual(ids, [10, 40, 25544], 'the new launch takes the decayed slot; Zarya keeps index 2');
  const s = useStore.getState();
  assert.equal(s.replayDay, '1998-11-21');
  assert.equal(s.selectedIndex, 2);
  assert.equal(s.selectedSatellite?.noradId, 25544);
  assert.equal(loadingSeen, false, 'prefetched day: no loading cue');
});

test('replay: "show fragments" is re-derived from each newly loaded day', async () => {
  const f = makeReplayFake(RANGE, {
    '1998-11-20': dayResp('1998-11-20', [10, 900]),
    '1998-11-21': dayResp('1998-11-21', [10, 900, 901, 902]),
  });
  f.ctl.installLive(live([1]));
  await flush();
  simClock.jumpTo(new Date('1998-11-20T12:00:00Z'));
  f.ctl.reconcileCatalogForTime();
  await settle();
  useStore.getState().setReplayFragments({ launches: ['1993-036'], parentNorads: [] });
  useStore.getState().setAnalyticFilter(new Set([900]));

  simClock.jumpTo(new Date('1998-11-21T12:00:00Z'));
  f.ctl.reconcileCatalogForTime();
  await settle();
  const af = useStore.getState().analyticFilter;
  assert.equal(af.mode, 'only');
  assert.deepEqual(af.mode === 'only' ? [...af.ids].sort() : [], [900, 901, 902]);

  // Leaving replay ends the fragments filter.
  simClock.reset();
  f.ctl.reconcileCatalogForTime();
  await settle();
  assert.equal(useStore.getState().replayFragments, null);
  assert.equal(useStore.getState().analyticFilter.mode, 'all');
});

test('replay: 503 (no archive) keeps today’s behaviour — the far past is the planetarium, no replay state', async () => {
  const f = makeReplayFake(null, {});
  f.ctl.installLive(live([1, 2]));
  await flush();
  assert.equal(useStore.getState().replayRange, null);
  simClock.jumpTo(new Date('1998-11-20T12:00:00Z'));
  f.ctl.reconcileCatalogForTime();
  await settle();
  assert.equal(useStore.getState().planetarium, true);
  assert.equal(useStore.getState().replayDay, null);
  assert.deepEqual(f.replay.fetched, []);
});

test('replay: a day the archive cannot serve (gap) shows the planetarium once and is not re-requested every tick', async () => {
  const f = makeReplayFake(RANGE, {});
  f.ctl.installLive(live([1, 2]));
  await flush();
  simClock.jumpTo(new Date('1998-11-25T12:00:00Z'));
  f.ctl.reconcileCatalogForTime();
  await settle();
  assert.equal(useStore.getState().planetarium, true);
  const n = f.replay.fetched.filter((d) => d === '1998-11-25').length;
  for (let i = 0; i < 5; i++) {
    f.ctl.reconcileCatalogForTime();
    await settle();
  }
  assert.equal(f.replay.fetched.filter((d) => d === '1998-11-25').length, n);
});
