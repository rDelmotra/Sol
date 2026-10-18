import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from './InputManager';
import { useStore } from '../../store/useStore';
import type { DsoObject } from '../../data/dso-types';

// Pins the pointer paths of InputManager with fakes (no GPU, no DOM):
//  - a click selects only an ISOLATED satellite (a group of 2+ objects within the
//    cluster radius selects nothing; the popup that used to open there is gone),
//  - a click on empty sky deselects, a click on a DSO selects the DSO,
//  - moving the pointer never touches the GPU picker (the old hover pick did).

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));

const N = 4; // catalog size; DSO picker indices start at N

/** [x,y,z] per object in scene units; objects 0 and 1 sit well inside the cluster radius (0.0078). */
const POSITIONS = [
  [1, 0, 0],
  [1.001, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function attr(values: number[][] | number[]) {
  return {
    getX: (i: number) => (Array.isArray(values[i]) ? (values[i] as number[])[0] : (values[i] as number)),
    getY: (i: number) => (values[i] as number[])[1],
    getZ: (i: number) => (values[i] as number[])[2],
  };
}

function setup(opts: { sizes?: number[] } = {}) {
  const listeners = new Map<string, (e: unknown) => void>();
  const canvas = {
    style: { cursor: '' },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const sizes = opts.sizes ?? [1, 1, 1, 1];
  const satelliteRenderer = {
    material: { uniforms: { uT: { value: 0 }, uCameraDistance: { value: 1 }, uPixelRatio: { value: 1 } } },
    mesh: {
      geometry: {
        getAttribute: (name: string) => (name === 'currentPosition' ? attr(POSITIONS) : attr(sizes)),
      },
    },
  };
  const calls = { pickArea: 0, pickAreaRadius: 0, total: 0 };
  let hits: number[] = [];
  const picker = {
    syncUniforms: () => {},
    pickArea: () => { calls.pickArea++; calls.total++; return hits; },
    pickAreaRadius: () => { calls.pickAreaRadius++; calls.total++; return hits; },
  };
  const cb = {
    selectedTle: [] as number[],
    selectedDso: [] as number[],
    deselected: 0,
  };
  const im = new InputManager(
    { canvas: canvas as never, satelliteRenderer: satelliteRenderer as never, dsoRenderer: null, controls: {} as never },
    {
      onSelectTle: (i) => cb.selectedTle.push(i),
      onSelectDso: (i) => cb.selectedDso.push(i),
      onDeselect: () => { cb.deselected++; },
      onDragExitFollow: () => {},
      onJoyrideLookInput: () => {},
      onDomeLookInput: () => {},
      onDomeZoom: () => {},
    },
  );
  im.setGpuPicker(picker as never);
  im.setCatalogData(Array.from({ length: N }, (_, i) => ({ noradId: i, name: `SAT-${i}` })) as never);
  im.setFirstPositionReceived(true);

  const fire = (type: string, x = 100, y = 100) =>
    listeners.get(type)!({ pointerId: 1, clientX: x, clientY: y });
  const click = (pickerHits: number[]) => {
    hits = pickerHits;
    fire('pointerdown');
    fire('pointerup');
  };
  return { im, canvas, calls, cb, fire, click };
}

test('click on an isolated satellite selects it', () => {
  const { cb, click } = setup();
  click([2]);
  assert.deepEqual(cb.selectedTle, [2]);
  assert.equal(cb.deselected, 0);
});

test('click on a group of satellites within the cluster radius selects nothing', () => {
  const { cb, click } = setup();
  click([0]); // object 1 sits 0.001 away from object 0
  assert.deepEqual(cb.selectedTle, []);
  assert.deepEqual(cb.selectedDso, []);
  assert.equal(cb.deselected, 0);
});

test('a hidden neighbour (size < 0.01) does not count as a cluster member', () => {
  const { cb, click } = setup({ sizes: [1, 0, 1, 1] });
  click([0]);
  assert.deepEqual(cb.selectedTle, [0]);
});

test('click on empty sky deselects', () => {
  const { cb, click } = setup();
  click([]);
  assert.equal(cb.deselected, 1);
  assert.deepEqual(cb.selectedTle, []);
});

test('click on a DSO selects the DSO by its index past the TLE catalog', () => {
  useStore.setState({ dsoObjects: [{ dsoId: 'a' } as DsoObject, { dsoId: 'b' } as DsoObject] });
  const { cb, click } = setup();
  click([N + 1, 2]);
  assert.deepEqual(cb.selectedDso, [1]);
  assert.deepEqual(cb.selectedTle, []);
});

test('a drag (pointer moved more than 5 px) is not a click', () => {
  const { cb, calls, fire } = setup();
  fire('pointerdown', 100, 100);
  fire('pointerup', 140, 100);
  assert.equal(calls.total, 0);
  assert.deepEqual(cb.selectedTle, []);
  assert.equal(cb.deselected, 0);
});

test('moving the pointer never touches the GPU picker or the cursor', () => {
  const { canvas, calls, fire } = setup();
  for (let i = 0; i < 20; i++) fire('pointermove', 100 + i, 100);
  assert.equal(calls.total, 0);
  assert.equal(canvas.style.cursor, '');
});

test('the reticle pick still reads the picker (gamepad path unchanged)', () => {
  const { im, calls } = setup();
  assert.deepEqual(im.pickAtReticle(), []);
  assert.equal(calls.pickAreaRadius, 1);
});
