import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore } from './useStore';
import { emptyFacetCounts } from '../data/types';
import type { DsoObject } from '../data/dso-types';

// Pins the CURRENT shape + cross-slice behaviour of the monolithic store so the
// slice split (step 2.7) can be proven behaviour-preserving. Asserts today's behaviour only.

const initial = useStore.getState();

afterEach(() => {
  mock.restoreAll();
  useStore.getState().goLive(); // simClock is a singleton — reset it
  useStore.setState(initial, true);
});

const sat = (noradId: number) => ({ noradId, name: `SAT-${noradId}`, omm: {} }) as unknown as EnrichedTLEObject;
const dso = (id: string) =>
  ({ source: 'dso', dsoId: id, slug: id, name: id, mission: 'm', targetBody: 'moon', regime: 'LUNAR',
    provider: 'horizons', freshnessState: 'fresh', searchAliases: [] }) as unknown as DsoObject;

const STATE_KEYS = [
  'analyticAnswer',
  'analyticFilter',
  'applyQueryFilters',
  'cameraMode',
  'catalogData',
  'categoryCounts',
  'categoryFilters',
  'clearAnalyticAnswer',
  'clearCluster',
  'clearDsoEphemeris',
  'clearQueryFilters',
  'clusterItems',
  'clusterScreenX',
  'clusterScreenY',
  'colorBy',
  'countryFilter',
  'dataTimestamp',
  'dsoEphemerisById',
  'dsoLabelPositions',
  'dsoObjects',
  'facetCounts',
  'goLive',
  'historyCoverage',
  'historyDay',
  'historyLoading',
  'historyStatus',
  'hoverScreenX',
  'hoverScreenY',
  'hoveredName',
  'injectSearchQuery',
  'jumpToSimTime',
  'launchFilter',
  'loadingError',
  'loadingPhase',
  'objectCount',
  'observerHeadingRad',
  'observerLocation',
  'ownerFilter',
  'planetarium',
  'programFilter',
  'purposeFilters',
  'regimeCounts',
  'regimeFilters',
  'resetSimClock',
  'returnToPresent',
  'reviewAt',
  'scrubPreview',
  'scrubberMode',
  'sectorFilters',
  'selectByIndex',
  'selectedAltitude',
  'selectedDso',
  'selectedIndex',
  'selectedSatellite',
  'setAnalyticAnswer',
  'setAnalyticFilter',
  'setCameraMode',
  'setCatalogData',
  'setCatalogInfo',
  'setCluster',
  'setColorBy',
  'setCountryFilter',
  'setDsoEphemeris',
  'setDsoLabelPositions',
  'setDsoObjects',
  'setHistoryCoverage',
  'setHistoryDay',
  'setHistoryLoading',
  'setHover',
  'setInjectSearchQuery',
  'setLoadingError',
  'setLoadingPhase',
  'setObserverHeadingRad',
  'setObserverLocation',
  'setPlanetarium',
  'setScrubberMode',
  'setSelectByIndex',
  'setSelectedDso',
  'setSelectedSatellite',
  'setShowOrbitTrail',
  'setSimRate',
  'setSimTimeMs',
  'setTrackingStyle',
  'setTriggerFlyTo',
  'setTriggerFlyToDso',
  'setTriggerJoyride',
  'setTriggerJoyrideDso',
  'setTriggerResetCamera',
  'setTriggerReturnToPresent',
  'setTriggerRunAnalytic',
  'setTriggerScrubPreview',
  'setTriggerSimTimeJump',
  'setVisibilityMode',
  'setVisibleCounts',
  'setVisibleFacetCounts',
  'setVisualListState',
  'setWallClockMs',
  'showOrbitTrail',
  'simRate',
  'simTimeMs',
  'statusFilters',
  'toggleCategoryFilter',
  'togglePurposeFilter',
  'toggleRegimeFilter',
  'toggleSectorFilter',
  'toggleStatusFilter',
  'toggleTypeFilter',
  'trackingStyle',
  'triggerFlyTo',
  'triggerFlyToDso',
  'triggerJoyride',
  'triggerJoyrideDso',
  'triggerResetCamera',
  'triggerReturnToPresent',
  'triggerRunAnalytic',
  'triggerScrubPreview',
  'triggerSimTimeJump',
  'typeFilters',
  'viewMode',
  'visibilityMode',
  'visibleCategoryCounts',
  'visibleFacetCounts',
  'visibleRegimeCounts',
  'visualList',
  'wallClockMs',
];

const TRIGGER_SLOTS = [
  'selectByIndex', 'injectSearchQuery', 'triggerFlyTo', 'triggerJoyride', 'triggerResetCamera',
  'triggerRunAnalytic', 'triggerFlyToDso', 'triggerJoyrideDso', 'triggerSimTimeJump',
  'triggerScrubPreview', 'triggerReturnToPresent',
] as const;

const allOn = <T extends string>(ks: T[]) => Object.fromEntries(ks.map((k) => [k, true]));
const zeros = <T extends string>(ks: T[]) => Object.fromEntries(ks.map((k) => [k, 0]));
const CATS = ['active_satellite', 'inactive_satellite', 'rocket_body', 'debris', 'unknown', 'deep_space'];
const REGS = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];

const INITIAL_VALUES: Record<string, unknown> = {
  loadingPhase: 'fetching',
  loadingError: null,
  cameraMode: 'free',
  trackingStyle: 'follow',
  objectCount: 0,
  categoryCounts: zeros(CATS),
  dataTimestamp: null,
  catalogData: [],
  selectedIndex: null,
  selectedSatellite: null,
  selectedAltitude: null,
  showOrbitTrail: false,
  dsoObjects: [],
  dsoEphemerisById: {},
  selectedDso: null,
  dsoLabelPositions: [],
  hoveredName: null,
  hoverScreenX: 0,
  hoverScreenY: 0,
  clusterItems: [],
  clusterScreenX: 0,
  clusterScreenY: 0,
  observerLocation: null,
  visibilityMode: 'all',
  observerHeadingRad: 0,
  visualList: { status: 'loading', version: null, source: null, stale: false, count: 0, updatedAt: null, message: null },
  categoryFilters: allOn(CATS),
  regimeFilters: allOn(REGS),
  regimeCounts: zeros(REGS),
  visibleCategoryCounts: zeros(CATS),
  visibleRegimeCounts: zeros(REGS),
  colorBy: 'type',
  typeFilters: allOn(['satellite', 'rocket_body', 'debris', 'unknown', 'deep_space']),
  statusFilters: allOn(['in_orbit', 'decayed', 'deorbited', 'beyond_earth', 'exploded', 'unknown']),
  sectorFilters: allOn(['commercial', 'government', 'military', 'civil', 'unspecified']),
  purposeFilters: allOn([
    'communications', 'earth_observation', 'navigation', 'technology_dev', 'space_science',
    'space_observation', 'surveillance', 'meteorological', 'other',
  ]),
  countryFilter: { mode: 'all' },
  programFilter: { mode: 'all' },
  launchFilter: { mode: 'all' },
  ownerFilter: { mode: 'all' },
  analyticFilter: { mode: 'all' },
  analyticAnswer: null,
  facetCounts: emptyFacetCounts(),
  visibleFacetCounts: emptyFacetCounts(),
  simRate: 1,
  viewMode: 'live',
  scrubberMode: false,
  historyCoverage: null,
  historyStatus: 'unknown',
  historyDay: null,
  historyLoading: false,
  planetarium: false,
};

test('store exposes exactly today\'s keys (state + actions)', () => {
  assert.deepEqual(Object.keys(initial).sort(), [...STATE_KEYS].sort());
  assert.equal(STATE_KEYS.length, 125);
});

test('initial values of every non-function key', () => {
  const s = initial as unknown as Record<string, unknown>;
  assert.equal(typeof s.simTimeMs, 'number');
  assert.equal(typeof s.wallClockMs, 'number');
  const nonFn = Object.keys(s).filter((k) => typeof s[k] !== 'function' && k !== 'simTimeMs' && k !== 'wallClockMs');
  const triggerNulls = Object.fromEntries(TRIGGER_SLOTS.map((k) => [k, null]));
  const expected = { ...INITIAL_VALUES, ...triggerNulls };
  assert.deepEqual(Object.keys(expected).sort(), nonFn.sort());
  for (const k of nonFn) assert.deepEqual(s[k], expected[k], k);
});

test('the 11 command trigger slots start null; every other non-state key is an action', () => {
  const s = initial as unknown as Record<string, unknown>;
  for (const k of TRIGGER_SLOTS) assert.equal(s[k], null, k);
  const nonSlotFns = Object.keys(s).filter((k) => !(TRIGGER_SLOTS as readonly string[]).includes(k) && !(k in INITIAL_VALUES) && k !== 'simTimeMs' && k !== 'wallClockMs');
  assert.ok(nonSlotFns.length > 0);
  for (const k of nonSlotFns) assert.equal(typeof s[k], 'function', k);
});

test('setSelectedSatellite(index, data) clears selectedDso and resets trail', () => {
  const s = useStore.getState();
  s.setSelectedDso(dso('a'));
  s.setShowOrbitTrail(true);
  s.setSelectedSatellite(1, sat(1), 500);
  const n = useStore.getState();
  assert.equal(n.selectedDso, null);
  assert.equal(n.selectedIndex, 1);
  assert.equal(n.selectedAltitude, 500);
  assert.equal(n.showOrbitTrail, false);
});

test('setSelectedSatellite(null) while following sets cameraMode returning (flying too, free untouched)', () => {
  const s = useStore.getState();
  s.setCameraMode('following');
  s.setSelectedSatellite(null, null);
  assert.equal(useStore.getState().cameraMode, 'returning');
  s.setCameraMode('flying');
  s.setSelectedSatellite(null, null);
  assert.equal(useStore.getState().cameraMode, 'returning');
  s.setCameraMode('free');
  s.setSelectedSatellite(null, null);
  assert.equal(useStore.getState().cameraMode, 'free');
  assert.equal(useStore.getState().selectedAltitude, null);
});

test('setSelectedDso(d) clears the three TLE selection fields; null while following -> returning', () => {
  const s = useStore.getState();
  s.setSelectedSatellite(3, sat(3), 400);
  s.setSelectedDso(dso('a'));
  let n = useStore.getState();
  assert.equal(n.selectedIndex, null);
  assert.equal(n.selectedSatellite, null);
  assert.equal(n.selectedAltitude, null);
  assert.equal(n.selectedDso?.dsoId, 'a');
  s.setCameraMode('following');
  s.setSelectedDso(null);
  n = useStore.getState();
  assert.equal(n.selectedDso, null);
  assert.equal(n.cameraMode, 'returning');
});

test('setDsoObjects writes deep_space count into categoryCounts, facetCounts.type, visibleFacetCounts.type', () => {
  useStore.getState().setDsoObjects([dso('a'), dso('b')]);
  const n = useStore.getState();
  assert.equal(n.dsoObjects.length, 2);
  assert.equal(n.categoryCounts.deep_space, 2);
  assert.equal(n.facetCounts.type.deep_space, 2);
  assert.equal(n.visibleFacetCounts.type.deep_space, 2);
  assert.equal(n.categoryCounts.debris, 0);
  assert.equal(n.visibleCategoryCounts.deep_space, 0); // visibleCategoryCounts is NOT touched
});

test('setVisibleFacetCounts keeps the deep_space total from facetCounts', () => {
  useStore.getState().setDsoObjects([dso('a'), dso('b')]);
  const counts = emptyFacetCounts();
  counts.type.satellite = 7;
  counts.type.deep_space = 0;
  useStore.getState().setVisibleFacetCounts(counts);
  const n = useStore.getState();
  assert.equal(n.visibleFacetCounts.type.satellite, 7);
  assert.equal(n.visibleFacetCounts.type.deep_space, 2);
  assert.equal(counts.type.deep_space, 0); // input not mutated
});

test('setCatalogInfo seeds visible counts as clones of the totals', () => {
  const facetCounts = emptyFacetCounts();
  facetCounts.type.satellite = 5;
  const categoryCounts = { ...(INITIAL_VALUES.categoryCounts as Record<string, number>), debris: 4 } as never;
  const regimeCounts = { LEO: 3, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 };
  useStore.getState().setCatalogInfo({ objectCount: 9, categoryCounts, regimeCounts, facetCounts });
  const n = useStore.getState();
  assert.equal(n.objectCount, 9);
  assert.equal(typeof n.dataTimestamp, 'number');
  assert.deepEqual(n.visibleCategoryCounts, n.categoryCounts);
  assert.notEqual(n.visibleCategoryCounts, n.categoryCounts);
  assert.deepEqual(n.visibleRegimeCounts, n.regimeCounts);
  assert.notEqual(n.visibleRegimeCounts, n.regimeCounts);
  assert.equal(n.facetCounts, facetCounts); // totals stored by reference
  assert.deepEqual(n.visibleFacetCounts, n.facetCounts);
  assert.notEqual(n.visibleFacetCounts, n.facetCounts);
  assert.notEqual(n.visibleFacetCounts.type, n.facetCounts.type);
});

test('setCatalogInfo without facetCounts seeds empty facets', () => {
  useStore.getState().setCatalogInfo({
    objectCount: 1,
    categoryCounts: INITIAL_VALUES.categoryCounts as never,
    regimeCounts: INITIAL_VALUES.regimeCounts as never,
  });
  assert.deepEqual(useStore.getState().facetCounts, emptyFacetCounts());
});

test('setAnalyticFilter: same set keeps reference; different set replaces; null resets', () => {
  const s = useStore.getState();
  s.setAnalyticFilter(new Set([1, 2]));
  const first = useStore.getState().analyticFilter;
  assert.equal(first.mode, 'only');
  s.setAnalyticFilter(new Set([2, 1]));
  assert.equal(useStore.getState().analyticFilter, first);
  s.setAnalyticFilter(new Set([1, 3]));
  assert.notEqual(useStore.getState().analyticFilter, first);
  s.setAnalyticFilter(null);
  assert.deepEqual(useStore.getState().analyticFilter, { mode: 'all' });
  const all = useStore.getState().analyticFilter;
  s.setAnalyticFilter(null);
  assert.equal(useStore.getState().analyticFilter, all); // already 'all' -> no new object
});

test('clearAnalyticAnswer clears both the answer and the filter', () => {
  const s = useStore.getState();
  s.setAnalyticAnswer({ status: 'ready', question: 'q' });
  s.setAnalyticFilter(new Set([9]));
  s.clearAnalyticAnswer();
  const n = useStore.getState();
  assert.equal(n.analyticAnswer, null);
  assert.deepEqual(n.analyticFilter, { mode: 'all' });
});

test('applyQueryFilters({}) on an all-on state keeps every filter reference', () => {
  const before = useStore.getState();
  before.applyQueryFilters({});
  const after = useStore.getState();
  for (const k of [
    'typeFilters', 'statusFilters', 'sectorFilters', 'purposeFilters', 'regimeFilters',
    'countryFilter', 'programFilter', 'launchFilter', 'ownerFilter',
  ] as const) {
    assert.equal(after[k], before[k], k);
  }
  before.clearQueryFilters();
  assert.equal(useStore.getState().typeFilters, before.typeFilters);
});

test('setSimRate(2) enters review and calls triggerSimTimeJump', () => {
  const jump = mock.fn();
  useStore.getState().setTriggerSimTimeJump(jump);
  useStore.getState().setSimRate(2);
  const n = useStore.getState();
  assert.equal(n.simRate, 2);
  assert.equal(n.viewMode, 'review');
  assert.equal(jump.mock.callCount(), 1);
  assert.equal(typeof n.simTimeMs, 'number');
});

test('setSimRate(1) keeps the existing viewMode', () => {
  useStore.setState({ viewMode: 'review' });
  useStore.getState().setSimRate(1);
  assert.equal(useStore.getState().viewMode, 'review');
});

test('returnToPresent with a trigger calls only the trigger; simTimeMs/viewMode/simRate unchanged', () => {
  const glide = mock.fn();
  const jump = mock.fn();
  useStore.getState().setTriggerReturnToPresent(glide);
  useStore.getState().setTriggerSimTimeJump(jump);
  useStore.setState({ viewMode: 'review', simRate: 4, simTimeMs: 123 });
  useStore.getState().returnToPresent();
  const n = useStore.getState();
  assert.equal(glide.mock.callCount(), 1);
  assert.equal(jump.mock.callCount(), 0);
  assert.equal(n.simTimeMs, 123);
  assert.equal(n.viewMode, 'review');
  assert.equal(n.simRate, 4);
});

test('returnToPresent without a trigger behaves like goLive', () => {
  const jump = mock.fn();
  useStore.getState().setTriggerSimTimeJump(jump);
  useStore.setState({ viewMode: 'review', simRate: 4, simTimeMs: 123 });
  useStore.getState().returnToPresent();
  const n = useStore.getState();
  assert.equal(jump.mock.callCount(), 1);
  assert.equal(n.viewMode, 'live');
  assert.equal(n.simRate, 1);
  assert.notEqual(n.simTimeMs, 123);
});

test('goLive and resetSimClock both snap to live and call triggerSimTimeJump', () => {
  const jump = mock.fn();
  useStore.getState().setTriggerSimTimeJump(jump);
  useStore.setState({ viewMode: 'review', simRate: 4 });
  useStore.getState().goLive();
  assert.equal(useStore.getState().viewMode, 'live');
  assert.equal(useStore.getState().simRate, 1);
  useStore.setState({ viewMode: 'review', simRate: 4 });
  useStore.getState().resetSimClock();
  assert.equal(useStore.getState().viewMode, 'live');
  assert.equal(useStore.getState().simRate, 1);
  assert.equal(jump.mock.callCount(), 2);
});

test('reviewAt / scrubPreview enter review; scrubPreview calls the preview hook, not the jump hook', () => {
  const jump = mock.fn();
  const preview = mock.fn();
  useStore.getState().setTriggerSimTimeJump(jump);
  useStore.getState().setTriggerScrubPreview(preview);
  const d = new Date(Date.UTC(2026, 0, 1));
  useStore.getState().scrubPreview(d);
  assert.equal(useStore.getState().viewMode, 'review');
  assert.equal(preview.mock.callCount(), 1);
  assert.equal(jump.mock.callCount(), 0);
  useStore.getState().reviewAt(d);
  assert.equal(jump.mock.callCount(), 1);
});

test('setHistoryCoverage: from=null -> unavailable; from set -> available; null -> unavailable', () => {
  const s = useStore.getState();
  const cov = { from: null, to: null, objectCount: 0, lastIngestAt: null } as never;
  s.setHistoryCoverage(cov);
  assert.equal(useStore.getState().historyStatus, 'unavailable');
  assert.equal(useStore.getState().historyCoverage, cov);
  s.setHistoryCoverage({ from: '2026-01-01', to: '2026-02-01', objectCount: 1, lastIngestAt: null } as never);
  assert.equal(useStore.getState().historyStatus, 'available');
  s.setHistoryCoverage(null);
  assert.equal(useStore.getState().historyStatus, 'unavailable');
  assert.equal(useStore.getState().historyCoverage, null);
});

test('clearDsoEphemeris removes only that id; setDsoEphemeris adds', () => {
  const s = useStore.getState();
  s.setDsoEphemeris('a', { a: 1 } as never);
  s.setDsoEphemeris('b', { b: 1 } as never);
  s.clearDsoEphemeris('a');
  assert.deepEqual(Object.keys(useStore.getState().dsoEphemerisById), ['b']);
});
