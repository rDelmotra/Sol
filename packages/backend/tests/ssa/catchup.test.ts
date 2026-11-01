// The catch-up loop of the nightly job: which days are missing (pure), the advisory lock, and the loop against a throwaway schema
// (statuses seeded, the right days processed oldest first, failures recorded and backed off, the screen only for the current batch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMissingDays, currentBatchTimeMs, markDone, markFailed, loadStatuses, DAY_MS, HOUR_MS } from '../../src/ssa/day-status.js';
import { runCatchUp, withJobLock, findMissing, type CatchUpDeps, type PartOutcome } from '../../src/ssa/catchup.js';
import { writeDayEvents } from '../../src/ssa/events/writer.js';
import { createTestDb, DB_URL } from './db-helper.js';
import type { Part } from '../../src/ssa/day-status.js';

const skip = DB_URL ? false : 'DATABASE_URL not set';
const t = (s: string) => Date.parse(s);
const counts = (days: string[], n = 5000): Map<string, number> => new Map(days.map((d) => [d, n]));
const range = (a: string, b: string): string[] => { const o: string[] = []; for (let x = t(a + 'T00:00:00Z'); x <= t(b + 'T00:00:00Z'); x += DAY_MS) o.push(new Date(x).toISOString().slice(0, 10)); return o; };
const NOW = t('2026-10-20T03:00:00Z'); // after the 02:30 tick: last complete day is 2026-10-19

test('missing days: oldest first, bounded look-back, only days with element sets, done days left out', () => {
  const all = range('2026-09-01', '2026-10-19');
  const base = { part: 'coverage' as const, nowMs: NOW, lookbackDays: 5, counts: counts(all), minRows: 1000, done: new Set<string>(), failed: new Map() };
  assert.deepEqual(computeMissingDays(base).days, ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']);
  assert.deepEqual(computeMissingDays({ ...base, done: new Set(['2026-10-16', '2026-10-19']) }).days, ['2026-10-15', '2026-10-17', '2026-10-18']);
  // a gap in the data: the day has nothing to process
  const gap = counts(all.filter((d) => d !== '2026-10-17'));
  assert.deepEqual(computeMissingDays({ ...base, counts: gap }).days, ['2026-10-15', '2026-10-16', '2026-10-18', '2026-10-19']);
  // too few rows is no data
  assert.deepEqual(computeMissingDays({ ...base, counts: new Map([['2026-10-19', 999], ['2026-10-18', 1000]]) }).days, ['2026-10-18']);
});

test('missing days: the current day and a day that has not settled yet are not taken', () => {
  const all = range('2026-09-01', '2026-10-20');
  const base = { part: 'coverage' as const, lookbackDays: 3, counts: counts(all), minRows: 1000, done: new Set<string>(), failed: new Map() };
  assert.deepEqual(computeMissingDays({ ...base, nowMs: t('2026-10-20T12:00:00Z') }).days, ['2026-10-17', '2026-10-18', '2026-10-19']);
  // 01:00 on the 20th: the 02:00 ingest has not delivered the last element sets of the 19th
  assert.deepEqual(computeMissingDays({ ...base, nowMs: t('2026-10-20T01:00:00Z') }).days, ['2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual(computeMissingDays({ ...base, nowMs: t('2026-10-20T02:29:00Z') }).days, ['2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual(computeMissingDays({ ...base, nowMs: t('2026-10-20T02:31:00Z') }).days, ['2026-10-17', '2026-10-18', '2026-10-19']);
});

test('missing days: changes needs the catalog of the day before (earlier data), coverage does not', () => {
  const only = counts(['2026-10-12', '2026-10-13']);
  const base = { nowMs: NOW, lookbackDays: 30, counts: only, minRows: 1000, done: new Set<string>(), failed: new Map() };
  assert.deepEqual(computeMissingDays({ ...base, part: 'changes' }).days, ['2026-10-13']);
  assert.deepEqual(computeMissingDays({ ...base, part: 'coverage' }).days, ['2026-10-12', '2026-10-13']);
  // earlier data beyond the 30-day catalog window does not count
  assert.deepEqual(computeMissingDays({ ...base, part: 'changes', counts: counts(['2026-09-01', '2026-10-13']) }).days, []);
});

test('missing days: failures back off exponentially and give up after the maximum number of attempts', () => {
  const all = range('2026-10-10', '2026-10-19');
  const base = { part: 'coverage' as const, nowMs: NOW, lookbackDays: 3, counts: counts(all), minRows: 1000, done: new Set<string>() };
  const failed = new Map([
    ['2026-10-17', { attempts: 1, lastAttemptMs: NOW - 30 * 60_000 }], // 1 h back-off, 30 min ago: wait
    ['2026-10-18', { attempts: 2, lastAttemptMs: NOW - 3 * HOUR_MS }], // 2 h back-off, 3 h ago: retry
    ['2026-10-19', { attempts: 5, lastAttemptMs: NOW - 99 * HOUR_MS }], // given up
  ]);
  const r = computeMissingDays({ ...base, failed });
  assert.deepEqual(r.days, ['2026-10-18']);
  assert.deepEqual(r.skippedBackoff, ['2026-10-17']);
  assert.deepEqual(r.gaveUp, ['2026-10-19']);
});

test('current batch time: 02:00 UTC of the latest day whose 02:30 tick has passed', () => {
  assert.equal(new Date(currentBatchTimeMs(t('2026-10-20T02:30:00Z'))).toISOString(), '2026-10-20T02:00:00.000Z');
  assert.equal(new Date(currentBatchTimeMs(t('2026-10-20T23:59:00Z'))).toISOString(), '2026-10-20T02:00:00.000Z');
  assert.equal(new Date(currentBatchTimeMs(t('2026-10-20T02:29:59Z'))).toISOString(), '2026-10-19T02:00:00.000Z');
  assert.equal(new Date(currentBatchTimeMs(t('2026-10-20T00:10:00Z'))).toISOString(), '2026-10-19T02:00:00.000Z');
});

test('advisory lock: a second holder is refused while the first runs, and the lock is released afterwards', { skip }, async () => {
  const db = await createTestDb(false);
  const key: [number, number] = [0x7e57, Math.floor(Math.random() * 1e6)];
  try {
    let inner: Awaited<ReturnType<typeof withJobLock>> | undefined;
    const outer = await withJobLock(db.pool, async () => {
      inner = await withJobLock(db.pool, async () => 'second', key);
      return 'first';
    }, key);
    assert.deepEqual(outer, { locked: true, value: 'first' });
    assert.deepEqual(inner, { locked: false });
    // released: a new holder gets it, even after the holder threw
    await assert.rejects(withJobLock(db.pool, async () => { throw new Error('boom'); }, key), /boom/);
    assert.deepEqual(await withJobLock(db.pool, async () => 'again', key), { locked: true, value: 'again' });
  } finally {
    await db.drop();
  }
});

test('catch-up loop: seeded statuses decide the days, they run oldest first, failures are recorded and backed off', { skip }, async () => {
  const db = await createTestDb();
  const lockKey: [number, number] = [0x7e57, Math.floor(Math.random() * 1e6)];
  try {
    // element sets on 2026-10-10..10-19 (3 per day is enough with minRows 2)
    for (const d of range('2026-10-10', '2026-10-19')) {
      for (let k = 0; k < 3; k++) await db.pool.query('INSERT INTO omm_updates (norad_id, epoch, omm) VALUES ($1, $2, $3)', [k + 1, `${d}T0${k}:00:00Z`, '{}']);
    }
    // statuses: changes done for 10-16..10-19 except 10-17 (failed once, long ago); coverage done for 10-15 and 10-19
    for (const d of ['2026-10-16', '2026-10-18', '2026-10-19']) await markDone(db.pool, d, 'changes', { x: 1 });
    await markFailed(db.pool, '2026-10-17', 'changes', 'earlier failure', NOW - 5 * HOUR_MS);
    for (const d of ['2026-10-15', '2026-10-19']) await markDone(db.pool, d, 'coverage');
    // the latest run is from the previous batch
    await db.pool.query(`INSERT INTO ssa_run (batch_time) VALUES ('2026-10-19T02:00:00Z')`);

    const calls: string[] = [];
    const screens: number[] = [];
    const failOn = new Set(['coverage 2026-10-14']);
    const deps: CatchUpDeps = {
      runPart: async (part: Part, day: string): Promise<PartOutcome> => {
        calls.push(`${part} ${day}`);
        if (failOn.has(`${part} ${day}`)) throw new Error('synthetic failure');
        await markDone(db.pool, day, part);
        return { status: 'done' };
      },
      runScreen: async (batchMs) => { screens.push(batchMs); await db.pool.query('INSERT INTO ssa_run (batch_time) VALUES (to_timestamp($1::float8 / 1000.0))', [batchMs]); },
    };
    const opts = { nowMs: NOW, lookbackDays: 6, minRows: 2, lockKey };
    // window = 10-14..10-19. changes missing: 10-14, 10-15 (10-13 and earlier are outside the window), 10-17 (retry: failed 5 h ago, back-off 1 h)
    assert.deepEqual((await findMissing(db.pool, deps, opts)).changes.days, ['2026-10-14', '2026-10-15', '2026-10-17']);
    const rep = await runCatchUp(db.pool, deps, opts);
    assert.equal(rep.locked, true);
    // days oldest first; within a day changes then coverage; a failing part does not stop the others
    assert.deepEqual(calls, [
      'changes 2026-10-14', 'coverage 2026-10-14',
      'changes 2026-10-15',
      'coverage 2026-10-16',
      'changes 2026-10-17', 'coverage 2026-10-17',
      'coverage 2026-10-18',
    ]);
    assert.deepEqual(rep.processed.filter((p) => p.outcome === 'failed').map((p) => `${p.part} ${p.day}`), ['coverage 2026-10-14']);
    // the current batch (2026-10-20 02:00) was not screened yet: exactly one screen, for that batch
    assert.deepEqual(screens, [t('2026-10-20T02:00:00Z')]);
    assert.equal(rep.screen, 'ran');

    // the failure is recorded with its attempt count; the others are done
    const st = await loadStatuses(db.pool, '2026-10-14', '2026-10-19');
    const f = st.find((s) => s.part === 'coverage' && s.day === '2026-10-14')!;
    assert.equal(f.done, false); assert.equal(f.attempts, 1); assert.match(f.error ?? '', /synthetic/);
    assert.equal(st.filter((s) => s.done).length, 5 + 6);

    // a second pass right away: the failed day is in back-off (1 h), nothing else is missing, the batch is already screened
    calls.length = 0;
    const again = await runCatchUp(db.pool, deps, { ...opts, nowMs: NOW + 10 * 60_000 });
    assert.deepEqual(calls, []);
    assert.deepEqual(again.skippedBackoff.coverage, ['2026-10-14']);
    assert.equal(again.screen, 'up-to-date');
    assert.deepEqual(screens.length, 1);

    // two hours later it is retried (and now succeeds); a day that keeps failing is eventually given up
    failOn.clear();
    const later = await runCatchUp(db.pool, deps, { ...opts, nowMs: NOW + 2 * HOUR_MS });
    assert.deepEqual(calls, ['coverage 2026-10-14']);
    assert.deepEqual(later.processed.map((p) => p.outcome), ['done']);
    const st2 = await loadStatuses(db.pool, '2026-10-14', '2026-10-14');
    assert.equal(st2.find((s) => s.part === 'coverage')!.done, true);

    // a job that holds the lock makes a second catch-up skip without touching anything
    calls.length = 0;
    const held = await withJobLock(db.pool, () => runCatchUp(db.pool, deps, { ...opts, nowMs: NOW + 3 * HOUR_MS }), lockKey);
    assert.equal(held.locked, true);
    if (held.locked) { assert.equal(held.value.locked, false); assert.deepEqual(calls, []); }
  } finally {
    await db.drop();
  }
});

test('the changes writer records completion in its own transaction: a failed write leaves no status, a good one leaves exactly one', { skip }, async () => {
  const db = await createTestDb();
  try {
    const row = { kind: 'elements.jump' as const, subjects: [7], tStart: t('2026-10-12T01:00:00Z'), tEnd: t('2026-10-12T01:00:01Z'), payload: {} };
    // a row of a kind outside the set is rejected before anything is written
    await assert.rejects(writeDayEvents(db.pool, '2026-10-12', ['object.appeared'], [row], { stats: { a: 1 } }));
    assert.equal((await loadStatuses(db.pool, '2026-10-12', '2026-10-12')).length, 0);
    // a database error inside the transaction (payload that is not JSON-serialisable to jsonb is fine; a bad subject is not)
    await assert.rejects(writeDayEvents(db.pool, '2026-10-12', ['elements.jump'], [{ ...row, subjects: [Number.NaN] }], { stats: {} }));
    assert.equal((await loadStatuses(db.pool, '2026-10-12', '2026-10-12')).length, 0);
    await writeDayEvents(db.pool, '2026-10-12', ['elements.jump'], [row], { stats: { n: 1 } });
    await writeDayEvents(db.pool, '2026-10-12', ['elements.jump'], [row], { stats: { n: 2 } });
    const st = await loadStatuses(db.pool, '2026-10-12', '2026-10-12');
    assert.equal(st.length, 1); assert.equal(st[0]!.part, 'changes'); assert.equal(st[0]!.done, true);
    assert.equal((await db.pool.query(`SELECT stats FROM ssa_day_status`)).rows[0].stats.n, 2);
    // a day that is done is never turned into a failure
    await markFailed(db.pool, '2026-10-12', 'changes', 'late error');
    assert.equal((await loadStatuses(db.pool, '2026-10-12', '2026-10-12'))[0]!.done, true);
  } finally {
    await db.drop();
  }
});
