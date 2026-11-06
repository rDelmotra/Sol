import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCatalogTarget, LIVE_REACH_DAYS, prefetchNeighbour, targetKey, type CatalogTarget } from './timeline-target';
import type { HistoryCoverage } from '../../data/history-client';
import type { HistoryRange } from '../../data/replay-types';

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

// ── History REPLAY rule ─────────────────────────────────────────────────────

const range = (firstDay: string, lastDay: string): HistoryRange =>
  ({ firstDay, lastDay, days: 1, eventsFirstDay: null, eventsLastDay: null, hasCoverage: true });
const runR = (simMs: number, replayRange: HistoryRange | null, coverage: HistoryCoverage | null = null) =>
  computeCatalogTarget({ simMs, wallMs: WALL, coverage, futureHorizonDays: H, replayRange });

test('replay: a date older than the live reach and inside the archive replays that day', () => {
  const r = range('1959-01-11', '2026-03-31');
  assert.deepEqual(runR(at('1998-11-20'), r), { kind: 'replay', day: '1998-11-20' });
  assert.deepEqual(runR(at('1959-01-11'), r), { kind: 'replay', day: '1959-01-11' });
  assert.deepEqual(runR(at('2026-03-31'), r), { kind: 'replay', day: '2026-03-31' });
});
test('replay: before the archive / after its last day falls through to the unchanged rules', () => {
  const r = range('1965-06-01', '2009-03-10');
  assert.deepEqual(runR(at('1965-05-31'), r), { kind: 'hidden' });
  assert.deepEqual(runR(at('2015-01-01'), r), { kind: 'hidden' }); // no legacy coverage → planetarium as before
});
test('replay: within the live reach (< 30 d back) the archive is NOT used', () => {
  const r = range('1959-01-11', '2026-10-07'); // archive reaching yesterday
  const inReach = WALL - (LIVE_REACH_DAYS - 1) * DAY;
  assert.deepEqual(runR(inReach, r), { kind: 'hidden' }); // unchanged rule (no legacy coverage)
  assert.deepEqual(runR(WALL - (LIVE_REACH_DAYS + 1) * DAY, r).kind, 'replay');
});
test('replay: exit — today and the future stay live; no archive (503) changes nothing', () => {
  const r = range('1959-01-11', '2026-03-31');
  assert.deepEqual(runR(WALL, r), { kind: 'live' });
  assert.deepEqual(runR(WALL + 3 * DAY, r), { kind: 'live' });
  assert.deepEqual(runR(at('1998-11-20'), null), { kind: 'hidden' });
  const c = cov('2026-09-01', '2026-10-05');
  assert.deepEqual(runR(at('2026-09-20'), null, c), { kind: 'day', day: '2026-09-20' });
});
test('replay target key differs from a legacy day', () => {
  assert.equal(targetKey({ kind: 'replay', day: '1998-11-20' }), 'replay:1998-11-20');
});
test('prefetchNeighbour follows the playback direction and stays in the archive', () => {
  const r = range('1998-11-15', '1998-12-31');
  assert.equal(prefetchNeighbour('1998-11-20', 1000, r), '1998-11-21');
  assert.equal(prefetchNeighbour('1998-11-20', 0, r), '1998-11-21');
  assert.equal(prefetchNeighbour('1998-11-20', -60, r), '1998-11-19');
  assert.equal(prefetchNeighbour('1998-12-31', 1, r), null);
  assert.equal(prefetchNeighbour('1998-11-15', -1, r), null);
  assert.equal(prefetchNeighbour('1998-11-20', 1, null), null);
});
