import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resyncDsoCatalog } from './dso-resync';
import type { DsoObject } from '../../data/dso-types';

const dso = (id: string) => ({ dsoId: id }) as unknown as DsoObject;

function make() {
  const initCalls: Array<{ n: number; tleCount: number }> = [];
  const geom: number[] = [];
  const ids: string[][] = [];
  let tleCount = 100;
  const geometry = {} as never;
  const targets = {
    renderer: { geometry, init: (o: DsoObject[], n: number) => initCalls.push({ n: o.length, tleCount: n }) },
    client: { syncIds: (x: string[]) => ids.push(x) },
    getTleCount: () => tleCount,
    onDsoGeometry: (_g: unknown, count: number) => geom.push(count),
  };
  return { targets, initCalls, geom, ids, setTle: (n: number) => (tleCount = n) };
}

test('re-encodes pick IDs against the current TLE count, including 0 (planetarium)', () => {
  const t = make();
  const objs = [dso('a'), dso('b')];
  resyncDsoCatalog(t.targets, objs);
  t.setTle(0);
  resyncDsoCatalog(t.targets, objs);
  t.setTle(4321);
  resyncDsoCatalog(t.targets, objs);

  assert.deepEqual(t.initCalls, [
    { n: 2, tleCount: 100 },
    { n: 2, tleCount: 0 },
    { n: 2, tleCount: 4321 },
  ]);
  assert.deepEqual(t.geom, [2, 2, 2], 'picker geometry is always registered with the real count, never pulled');
  assert.deepEqual(t.ids[0], ['a', 'b']);
});

test('works without a worker client', () => {
  const t = make();
  assert.doesNotThrow(() => resyncDsoCatalog({ ...t.targets, client: null }, [dso('a')]));
  assert.deepEqual(t.geom, [1]);
});
