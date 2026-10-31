import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore } from '../../store/useStore';
import { EncounterFlyby, FLYBY_LEAD_MS } from './EncounterFlyby';
import { encounterFixture } from '../../data/ssa-fixtures';

const initial = useStore.getState();
const sat = (noradId: number) => ({ noradId, name: `SAT-${noradId}`, omm: {} }) as unknown as EnrichedTLEObject;

const TCA = '2026-11-01T14:03:22.000Z';
const ENC = encounterFixture(10, 25544, 90001, TCA);

type Fn<A extends unknown[]> = ReturnType<typeof mock.fn<(...a: A) => void>>;
let camera: { selectByIndex: Fn<[number]>; flyTo: Fn<[number]>; frameSeparation: Fn<[number]> };
let jump: ReturnType<typeof mock.fn>;

beforeEach(() => {
  jump = mock.fn();
  camera = {
    // Selecting through the camera selects in the store, like NavigationController does.
    selectByIndex: mock.fn((i: number): void => useStore.getState().setSelectedSatellite(i, useStore.getState().catalogData[i], 400)),
    flyTo: mock.fn((_i: number): void => {}),
    frameSeparation: mock.fn((_km: number): void => {}),
  };
  useStore.setState({
    catalogData: [sat(1), sat(25544), sat(90001)],
    encountersByNorad: { 25544: [ENC] },
    // Replace the real action so the shared sim clock is untouched.
    jumpToSimTime: jump as never,
  });
});

afterEach(() => {
  mock.restoreAll();
  useStore.setState(initial, true);
});

describe('EncounterFlyby.show', () => {
  it('jumps the clock to TCA minus 2 minutes and filters to the pair', () => {
    useStore.getState().setSelectedSatellite(1, sat(25544), 400);
    new EncounterFlyby(camera).show(10);

    assert.equal(jump.mock.callCount(), 1);
    const date = jump.mock.calls[0].arguments[0] as Date;
    assert.equal(date.getTime(), Date.parse(TCA) - 120_000);
    assert.equal(FLYBY_LEAD_MS, 120_000);

    const f = useStore.getState().analyticFilter;
    assert.equal(f.mode, 'only');
    assert.deepEqual(f.mode === 'only' ? [...f.ids].sort((a, b) => a - b) : [], [25544, 90001]);
    assert.equal(useStore.getState().selectedEncounterId, 10);
    assert.equal(useStore.getState().viewMode, 'review');
  });

  it('frames the primary: selects it when another object is focused, then flies to it', () => {
    useStore.getState().setSelectedSatellite(0, sat(1), 400);
    new EncounterFlyby(camera).show(10);
    assert.deepEqual(camera.selectByIndex.mock.calls.map((c) => c.arguments), [[1]]);
    assert.deepEqual(camera.flyTo.mock.calls.map((c) => c.arguments), [[1]]);
    // 11.2 km/s relative speed for 120 s: the pair starts about 1344 km apart
    assert.deepEqual(camera.frameSeparation.mock.calls.map((c) => c.arguments[0]), [11.2 * 120]);
  });

  it('runs at 1x', () => {
    useStore.getState().setSelectedSatellite(1, sat(25544), 400);
    const setRate = mock.fn();
    useStore.setState({ simRate: 8, setSimRate: setRate as never });
    new EncounterFlyby(camera).show(10);
    assert.deepEqual(setRate.mock.calls.map((c) => c.arguments), [[1]]);
  });

  it('ignores an unknown encounter id', () => {
    new EncounterFlyby(camera).show(999);
    assert.equal(jump.mock.callCount(), 0);
    assert.equal(useStore.getState().selectedEncounterId, null);
    assert.equal(useStore.getState().analyticFilter.mode, 'all');
  });
});

describe('EncounterFlyby.clear', () => {
  it('clears the selection and restores the previous filter', () => {
    useStore.getState().setSelectedSatellite(1, sat(25544), 400);
    useStore.getState().setAnalyticFilter(new Set([7, 8]));
    const flyby = new EncounterFlyby(camera);
    flyby.show(10);
    flyby.clear();
    const f = useStore.getState().analyticFilter;
    assert.equal(f.mode, 'only');
    assert.deepEqual(f.mode === 'only' ? [...f.ids].sort() : [], [7, 8]);
    assert.equal(useStore.getState().selectedEncounterId, null);
  });

  it('restores "all" when there was no filter', () => {
    useStore.getState().setSelectedSatellite(1, sat(25544), 400);
    const flyby = new EncounterFlyby(camera);
    flyby.show(10);
    flyby.clear();
    assert.equal(useStore.getState().analyticFilter.mode, 'all');
  });

  it('selecting another object ends the flyby', () => {
    useStore.getState().setSelectedSatellite(1, sat(25544), 400);
    new EncounterFlyby(camera).show(10);
    useStore.getState().setSelectedSatellite(0, sat(1), 400);
    assert.equal(useStore.getState().selectedEncounterId, null);
    assert.equal(useStore.getState().analyticFilter.mode, 'all');
  });

  it('does not overwrite a filter set by a query after the flyby began', () => {
    useStore.getState().setSelectedSatellite(1, sat(25544), 400);
    const flyby = new EncounterFlyby(camera);
    flyby.show(10);
    useStore.getState().setAnalyticFilter(new Set([5]));
    flyby.clear();
    const f = useStore.getState().analyticFilter;
    assert.deepEqual(f.mode === 'only' ? [...f.ids] : null, [5]);
  });
});
