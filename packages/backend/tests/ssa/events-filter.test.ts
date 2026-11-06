// GET /api/ssa/events: kind lists (dotted names), from + to as an event-time window, the old parameters keep working.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { SsaEventsResponse } from '@orbitwatch/contracts';
import { createSsaRouter } from '../../src/routes/ssa.js';
import { createTestDb, DB_URL } from './db-helper.js';

const skip = DB_URL ? false : 'DATABASE_URL not set';
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

test('events: kind list, from / to window, bad input; since and a single kind as before', { skip, timeout: 60_000 }, async () => {
  const db = await createTestDb();
  const app = express();
  app.use('/api/ssa', createSsaRouter({ getDb: () => db.pool }));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ssa`;
  try {
    const ins = (day: string, kind: string, subject: number, t?: string) => db.pool.query(`INSERT INTO ssa_event (day, kind, subjects, t_start) VALUES ($1, $2, $3, $4)`, [day, kind, `{${subject}}`, t ?? `${day}T12:00:00Z`]);
    await ins('2009-02-10', 'object.appeared', 1); await ins('2009-02-11', 'object.appeared', 2); await ins('2009-02-12', 'object.breakup', 3);
    await ins('2009-03-01', 'elements.jump', 4); await ins('2010-01-01', 'object.appeared', 5);
    const get = async (q: string): Promise<{ status: number; body: SsaEventsResponse & { error?: string } }> => { const r = await fetch(`${base}/events${q}`); return { status: r.status, body: (await r.json()) as never }; };
    const subj = (r: { body: SsaEventsResponse }) => r.body.events.map((e) => e.subjects[0]).sort();

    assert.deepEqual(subj(await get('?kind=object.appeared')), [1, 2, 5], 'dotted kind names work');
    assert.deepEqual(subj(await get('?kind=object.appeared,object.breakup')), [1, 2, 3, 5]);
    assert.deepEqual(subj(await get('?kind=object.appeared,object.breakup&from=2009-02-01&to=2009-12-31')), [1, 2, 3]);
    assert.deepEqual(subj(await get('?from=2009-02-11&to=2009-02-12T23:59:59Z')), [2, 3]);
    assert.deepEqual(subj(await get('?from=2009-03-01')), [4, 5]);
    assert.deepEqual(subj(await get('?to=2009-02-10T12:00:00Z')), [1]);
    assert.deepEqual(subj(await get('?kind=object.breakup&since=2009-02-13')), []);
    assert.equal((await get('?limit=2')).body.count, 2);
    // newest first, as before
    assert.deepEqual((await get('?kind=object.appeared')).body.events.map((e) => e.subjects[0]), [5, 2, 1]);
    for (const q of ['?kind=a%20b', '?kind=object.appeared,', '?kind=x1,y-2', '?from=nope', '?to=2009-99-99', '?from=2010-01-01&to=2009-01-01', '?kind=' + 'k,'.repeat(20)]) {
      const r = await get(q);
      assert.equal(r.status, 400, q);
    }
  } finally { await close(server); await db.drop(); }
});
