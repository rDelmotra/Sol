import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore, isDomeView, selectReticleCandidateName } from './useStore';
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
  'analysisPanelOpen',
  'analyticAnswer',
  'analyticFilter',
  'applyQueryFilters',
  'askBarOpen',
  'cameraGear',
  'cameraGearCount',
  'cameraMode',
  'cameraSpeedMps',
  'catalogData',
  'categoryCounts',
  'clearAnalyticAnswer',
  'clearCluster',
  'clearQueryFilters',
  'closePanels',
  'clusterItems',
  'clusterScreenX',
  'clusterScreenY',
  'colorBy',
  'controlsSheetOpen',
  'countryFilter',
  'cycleReticleCandidate',
  'dataTimestamp',
  'dsoEphemerisById',
  'dsoLabelPositions',
  'dsoObjects',
  'facetCounts',
  'focusPanelOpen',
  'gamepadConnected',
  'goLive',
  'historyCoverage',
  'historyDay',
  'historyLoading',
  'hoverScreenX',
  'hoverScreenY',
  'hoveredName',
  'injectSearchQuery',
  'jumpToSimTime',
  'launchFilter',
  'liveAltitudeKm',
  'liveSpeedKmS',
  'loadingError',
  'loadingPhase',
  'nextPasses',
  'objectCount',
  'observerHeadingRad',
  'observerLocation',
  'observerPlaceName',
  'ownerFilter',
  'passStatus',
  'planetarium',
  'programFilter',
  'purposeFilters',
  'regimeCounts',
  'regimeFilters',
  'resetSimClock',
  'reticleCandidateIndex',
  'reticleCandidates',
  'returnToPresent',
  'reviewAt',
  'scrubField',
  'scrubFocusOnReset',
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
  'setAskBarOpen',
  'setCameraGearState',
  'setCameraMode',
  'setCatalogData',
  'setCatalogInfo',
  'setCluster',
  'setColorBy',
  'setControlsSheetOpen',
  'setCountryFilter',
  'setDsoEphemeris',
  'setDsoLabelPositions',
  'setDsoObjects',
  'setGamepadConnected',
  'setHistoryCoverage',
  'setHistoryDay',
  'setHistoryLoading',
  'setHover',
  'setInjectSearchQuery',
  'setLiveKinematics',
  'setLoadingError',
  'setLoadingPhase',
  'setObserverHeadingRad',
  'setObserverLocation',
  'setObserverPlaceName',
  'setPassPlan',
  'setPlanetarium',
  'setReticleCandidates',
  'setScrubField',
  'setScrubFocusOnReset',
  'setScrubberMode',
  'setSelectByIndex',
  'setSelectedDso',
  'setSelectedSatellite',
  'setShowOrbitTrail',
  'setSimRate',
  'setSimTimeMs',
  'setSkyLens',
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
  'setVantage',
  'setVisibleCounts',
  'setVisibleFacetCounts',
  'setVisualListState',
  'setWallClockMs',
  'showOrbitTrail',
  'simRate',
  'simTimeMs',
  'skyLens',
  'statusFilters',
  'toggleAnalysisPanel',
  'toggleAskBar',
  'toggleControlsSheet',
  'toggleFocusPanel',
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
  'vantage',
  'viewMode',
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
  liveAltitudeKm: null,
  liveSpeedKmS: null,
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
  observerPlaceName: null,
  nextPasses: [],
  passStatus: 'no-selection',
  vantage: 'orbit',
  skyLens: 'all',
  observerHeadingRad: 0,
  visualList: { status: 'loading', version: null, source: null, stale: false, count: 0, updatedAt: null, message: null },
  regimeFilters: allOn(REGS),
  regimeCounts: zeros(REGS),
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
  scrubField: 'day',
  scrubFocusOnReset: false,
  historyCoverage: null,
  historyDay: null,
  historyLoading: false,
  planetarium: false,
  cameraGear: 5,
  cameraGearCount: 10,
  cameraSpeedMps: 1_000_000,
  gamepadConnected: false,
  reticleCandidates: [],
  reticleCandidateIndex: null,
  analysisPanelOpen: false,
  focusPanelOpen: false,
  askBarOpen: false,
  controlsSheetOpen: false,
};

test('store exposes exactly today\'s keys (state + actions)', () => {
  assert.deepEqual(Object.keys(initial).sort(), [...STATE_KEYS].sort());
  assert.equal(STATE_KEYS.length, 155);
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

test('setHistoryCoverage stores the coverage object (null clears it)', () => {
  const s = useStore.getState();
  const cov = { from: null, to: null, objectCount: 0, lastIngestAt: null } as never;
  s.setHistoryCoverage(cov);
  assert.equal(useStore.getState().historyCoverage, cov);
  s.setHistoryCoverage(null);
  assert.equal(useStore.getState().historyCoverage, null);
});

test('setVantage(ground) turns lens all into horizon; other lenses survive', () => {
  const s = useStore.getState();
  s.setVantage('ground');
  assert.equal(useStore.getState().skyLens, 'horizon');
  s.setSkyLens('radio');
  assert.equal(useStore.getState().skyLens, 'radio');
  s.setVantage('orbit');
  s.setVantage('ground');
  assert.equal(useStore.getState().skyLens, 'radio');
});

test('setSkyLens(all) on the ground becomes horizon; in orbit it sticks', () => {
  const s = useStore.getState();
  s.setVantage('ground');
  s.setSkyLens('all');
  assert.equal(useStore.getState().skyLens, 'horizon');
  s.setVantage('orbit');
  assert.equal(useStore.getState().skyLens, 'horizon'); // leaving the ground keeps the lens
  s.setSkyLens('all');
  assert.equal(useStore.getState().skyLens, 'all');
});

test('isDomeView needs free camera + ground vantage + an observer, whatever the lens', () => {
  const loc = { lat: 0, lon: 0, alt: 0 };
  assert.equal(isDomeView({ cameraMode: 'free', vantage: 'ground', observerLocation: loc }), true);
  assert.equal(isDomeView({ cameraMode: 'free', vantage: 'orbit', observerLocation: loc }), false);
  assert.equal(isDomeView({ cameraMode: 'following', vantage: 'ground', observerLocation: loc }), false);
  assert.equal(isDomeView({ cameraMode: 'free', vantage: 'ground', observerLocation: null }), false);
});

test('setLiveKinematics skips no-op writes; setSelectedSatellite clears the readout', () => {
  const s = useStore.getState();
  let writes = 0;
  const unsub = useStore.subscribe(() => { writes++; });
  s.setLiveKinematics(400, 7.6);
  s.setLiveKinematics(400, 7.6);
  assert.equal(writes, 1);
  s.setLiveKinematics(null, null);
  s.setLiveKinematics(null, null);
  assert.equal(writes, 2);
  unsub();
  s.setLiveKinematics(410, 7.5);
  s.setSelectedSatellite(2, sat(2));
  assert.equal(useStore.getState().liveAltitudeKm, null);
  assert.equal(useStore.getState().liveSpeedKmS, null);
});

test('setPassPlan writes list and status together', () => {
  const pass = { aosMs: 1 } as never;
  useStore.getState().setPassPlan([pass], 'ok');
  const n = useStore.getState();
  assert.deepEqual(n.nextPasses, [pass]);
  assert.equal(n.passStatus, 'ok');
});

test('setCameraGearState writes gear, gear count and speed', () => {
  useStore.getState().setCameraGearState(3, 8, 5000);
  const n = useStore.getState();
  assert.equal(n.cameraGear, 3);
  assert.equal(n.cameraGearCount, 8);
  assert.equal(n.cameraSpeedMps, 5000);
});

test('setReticleCandidates keeps a present highlight, else takes the first; equal list = no write', () => {
  useStore.getState().setCatalogData([sat(10), sat(11), sat(12)]);
  const s = useStore.getState();
  s.setReticleCandidates([1, 2]);
  assert.equal(useStore.getState().reticleCandidateIndex, 1);
  assert.equal(selectReticleCandidateName(useStore.getState()), 'SAT-11');
  s.cycleReticleCandidate(1);
  assert.equal(useStore.getState().reticleCandidateIndex, 2);
  s.setReticleCandidates([0, 2]);
  assert.equal(useStore.getState().reticleCandidateIndex, 2); // still present → kept
  s.setReticleCandidates([0, 1]);
  assert.equal(useStore.getState().reticleCandidateIndex, 0); // gone → first
  let writes = 0;
  const unsub = useStore.subscribe(() => { writes++; });
  s.setReticleCandidates([0, 1]);
  unsub();
  assert.equal(writes, 0);
  s.setReticleCandidates([]);
  assert.equal(useStore.getState().reticleCandidateIndex, null);
  assert.equal(selectReticleCandidateName(useStore.getState()), null);
});

test('cycleReticleCandidate wraps both ways and is a no-op with no candidates', () => {
  useStore.getState().setCatalogData([sat(10), sat(11), sat(12)]);
  const s = useStore.getState();
  s.cycleReticleCandidate(1);
  assert.equal(useStore.getState().reticleCandidateIndex, null);
  s.setReticleCandidates([0, 1, 2]);
  s.cycleReticleCandidate(-1);
  assert.equal(useStore.getState().reticleCandidateIndex, 2);
  assert.equal(selectReticleCandidateName(useStore.getState()), 'SAT-12');
  s.cycleReticleCandidate(1);
  assert.equal(useStore.getState().reticleCandidateIndex, 0);
});

test('HUD panel toggles; closePanels shuts both side panels only', () => {
  const s = useStore.getState();
  s.toggleAnalysisPanel();
  s.toggleFocusPanel();
  s.toggleAskBar();
  s.toggleControlsSheet();
  s.closePanels();
  const n = useStore.getState();
  assert.equal(n.analysisPanelOpen, false);
  assert.equal(n.focusPanelOpen, false);
  assert.equal(n.askBarOpen, true);
  assert.equal(n.controlsSheetOpen, true);
  s.setAskBarOpen(false);
  s.setControlsSheetOpen(false);
  assert.equal(useStore.getState().askBarOpen, false);
  assert.equal(useStore.getState().controlsSheetOpen, false);
});

test('setScrubField and setScrubberMode clear scrubFocusOnReset', () => {
  const s = useStore.getState();
  s.setScrubFocusOnReset(true);
  s.setScrubField('hour');
  assert.equal(useStore.getState().scrubField, 'hour');
  assert.equal(useStore.getState().scrubFocusOnReset, false);
  s.setScrubFocusOnReset(true);
  s.setScrubberMode(true);
  assert.equal(useStore.getState().scrubFocusOnReset, false);
});

test('setDsoEphemeris adds per-id snapshots', () => {
  const s = useStore.getState();
  s.setDsoEphemeris('a', { a: 1 } as never);
  s.setDsoEphemeris('b', { b: 1 } as never);
  assert.deepEqual(Object.keys(useStore.getState().dsoEphemerisById).sort(), ['a', 'b']);
});
