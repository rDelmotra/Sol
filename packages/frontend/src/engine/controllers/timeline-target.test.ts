import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCatalogTarget, targetKey, type CatalogTarget } from './timeline-target';
import type { HistoryCoverage } from '../../data/history-client';

const DAY = 86_400_000;
const WALL = Date.UTC(2026, 9, 8, 12, 0, 0); // 2026-10-08
const H = 14;
const cov = (from: string | null, to: string | null): HistoryCoverage =>
  ({ from, to, objectCount: 1, lastIngestAt: null }) as unknown as HistoryCoverage;
const run = (simMs: number, coverage: HistoryCoverage | null) =>
  computeCatalogTarget({ simMs, wallMs: WALL, coverage, futureHorizonDays: H });
const at = (iso: string) => Date.parse(`${iso}T05:00:00Z`);

test('beyond horizon => hidden', () => {
  assert.deepEqual(run(WALL + (H + 1) * DAY, null), { kind: 'hidden' });
});
test('today..horizon => live (boundaries inclusive)', () => {
  assert.deepEqual(run(WALL, null), { kind: 'live' });
  assert.deepEqual(run(at('2026-10-08'), null), { kind: 'live' });
  assert.deepEqual(run(at('2026-10-22'), null), { kind: 'live' }); // horizon day
  assert.deepEqual(run(at('2026-10-23'), null), { kind: 'hidden' });
});
test('past with null coverage or missing from/to => hidden', () => {
  const past = at('2026-10-01');
  assert.deepEqual(run(past, null), { kind: 'hidden' });
  assert.deepEqual(run(past, cov(null, '2026-10-05')), { kind: 'hidden' });
  assert.deepEqual(run(past, cov('2026-09-01', null)), { kind: 'hidden' });
});
test('before from => hidden; after to => live; inside => day', () => {
  const c = cov('2026-09-01', '2026-10-05');
  assert.deepEqual(run(at('2026-08-31'), c), { kind: 'hidden' });
  assert.deepEqual(run(at('2026-10-06'), c), { kind: 'live' });
  assert.deepEqual(run(at('2026-09-20'), c), { kind: 'day', day: '2026-09-20' });
});
test('exact coverage boundaries are inside coverage', () => {
  const c = cov('2026-09-01', '2026-10-05');
  assert.deepEqual(run(at('2026-09-01'), c), { kind: 'day', day: '2026-09-01' });
  assert.deepEqual(run(at('2026-10-05'), c), { kind: 'day', day: '2026-10-05' });
});
test('yesterday vs today boundary', () => {
  const c = cov('2026-09-01', '2026-10-07');
  assert.deepEqual(run(at('2026-10-07'), c), { kind: 'day', day: '2026-10-07' });
  assert.deepEqual(run(at('2026-10-08'), c), { kind: 'live' });
});
test('targetKey per kind', () => {
  const t: CatalogTarget[] = [{ kind: 'live' }, { kind: 'hidden' }, { kind: 'day', day: '2026-09-20' }];
  assert.deepEqual(t.map(targetKey), ['live', 'hidden', '2026-09-20']);
});
