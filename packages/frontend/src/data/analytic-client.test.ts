// P2/S4 — compile client tests (my_plans/marvin/perceptor_p2_plan.md S4).
// fetch is mocked; covers every branch incl. the client-side re-validation reject.

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { compileQuestion } from './analytic-client';

const VALID_PROGRAM = {
  v: 1,
  universe: 'live',
  timeBinding: { mode: 'now' },
  interpretation: 'objects inside the umbra at sim-time',
  pipeline: [{ op: 'filter', where: { field: 'eclipsed' } }],
  output: { shape: 'ids' },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(status: number, body: unknown, ok = status >= 200 && status < 300): void {
  globalThis.fetch = (async () =>
    ({
      status,
      ok,
      json: async () => body,
    }) as unknown as Response) as typeof fetch;
}

describe('compileQuestion', () => {
  it('returns a validated program on ok', async () => {
    mockFetch(200, { ok: true, program: VALID_PROGRAM, interpretation: 'i', cached: false });
    const r = await compileQuestion('how many are in shadow');
    assert.ok(r.ok && r.program.output.shape === 'ids' && r.interpretation === 'i');
  });

  it('rejects a server-ok program that fails client re-validation (version skew)', async () => {
    mockFetch(200, { ok: true, program: { v: 1, universe: 'live' /* missing rest */ }, cached: false });
    const r = await compileQuestion('skewed');
    assert.ok(!r.ok && r.kind === 'invalid' && r.message.includes('refresh'));
  });

  it('maps a refusal', async () => {
    mockFetch(200, { ok: false, refused: true, code: 'OFF_DOMAIN', reason: 'not derivable' });
    const r = await compileQuestion('prettiest satellite');
    assert.ok(!r.ok && r.kind === 'refused' && r.code === 'OFF_DOMAIN' && r.reason === 'not derivable');
  });

  it('maps 422 to invalid', async () => {
    mockFetch(422, { ok: false, issues: [{ code: 'V-ENUM', path: 'p', message: 'm' }] }, false);
    const r = await compileQuestion('bad');
    assert.ok(!r.ok && r.kind === 'invalid');
  });

  it('maps 503 to unavailable', async () => {
    mockFetch(503, { ok: false, error: 'nope' }, false);
    const r = await compileQuestion('anything');
    assert.ok(!r.ok && r.kind === 'unavailable');
  });

  it('maps 429 to ratelimited', async () => {
    mockFetch(429, { error: 'slow down' }, false);
    const r = await compileQuestion('anything');
    assert.ok(!r.ok && r.kind === 'ratelimited');
  });

  it('maps a fetch throw to network', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const r = await compileQuestion('anything');
    assert.ok(!r.ok && r.kind === 'network' && r.message === 'offline');
  });
});
