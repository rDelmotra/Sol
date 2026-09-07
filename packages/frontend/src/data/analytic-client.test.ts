// P2/S4 — compile client tests (my_plans/marvin/perceptor_p2_plan.md S4).
// fetch is mocked; covers every branch incl. the client-side re-validation reject.

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { compileQuestion, askQuestion } from './analytic-client';

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

function mockFetchCapture(status: number, body: unknown, ok = status >= 200 && status < 300): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, ok, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

const META = {
  interpretation: 'i', universe: 'live' as const, evaluatedAt: '2026-07-20T00:00:00.000Z',
  matched: 1, scanned: 1, coverage: [],
};

describe('askQuestion', () => {
  it('sends question/tMs; omits observer when null; maps lat/lon/alt when set', async () => {
    const { calls } = mockFetchCapture(200, { ok: true, mode: 'program', program: VALID_PROGRAM, interpretation: 'i', cached: false });
    await askQuestion({ question: 'q1', tMs: 1000, observer: null });
    const body1 = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body1, { question: 'q1', tMs: 1000 });
    assert.equal('observer' in body1, false);

    await askQuestion({ question: 'q2', tMs: 2000, observer: { latDeg: 51.5, lonDeg: -0.1, altKm: 0.05 } });
    const body2 = JSON.parse(calls[1].init.body as string);
    assert.deepEqual(body2, { question: 'q2', tMs: 2000, observer: { latDeg: 51.5, lonDeg: -0.1, altKm: 0.05 } });
  });

  it("mode:'program' response → AskResult mode 'program', program validated", async () => {
    mockFetch(200, { ok: true, mode: 'program', program: VALID_PROGRAM, interpretation: 'i', cached: true });
    const r = await askQuestion({ question: 'q', tMs: 1000, observer: null });
    assert.ok(r.ok && r.mode === 'program' && r.cached === true && r.program.output.shape === 'ids');
  });

  it("mode:'result' response → rehydrated result: ids instanceof Uint32Array, nested compare rehydrated, meta passthrough", async () => {
    mockFetch(200, {
      ok: true, mode: 'result', program: VALID_PROGRAM, interpretation: 'i', cached: false,
      result: {
        shape: 'ids', ids: [1, 2, 3], meta: META,
        compare: { shape: 'ids', ids: [4, 5], meta: { ...META, interpretation: 'cmp' } },
      },
    });
    const r = await askQuestion({ question: 'q', tMs: 1000, observer: null });
    assert.ok(r.ok && r.mode === 'result');
    if (!r.ok || r.mode !== 'result') return;
    assert.ok(r.result.ids instanceof Uint32Array);
    assert.deepEqual(Array.from(r.result.ids as Uint32Array), [1, 2, 3]);
    assert.ok(r.result.compare?.ids instanceof Uint32Array);
    assert.deepEqual(Array.from(r.result.compare!.ids as Uint32Array), [4, 5]);
    assert.equal(r.result.meta.matched, 1);
  });

  it('skew guard: server-ok body whose program fails local validation → kind:invalid, in both modes', async () => {
    const badProgram = { v: 1, universe: 'live' /* missing rest */ };
    mockFetch(200, { ok: true, mode: 'program', program: badProgram, cached: false });
    const r1 = await askQuestion({ question: 'q', tMs: 1000, observer: null });
    assert.ok(!r1.ok && r1.kind === 'invalid');

    mockFetch(200, { ok: true, mode: 'result', program: badProgram, cached: false, result: { shape: 'ids', ids: [], meta: META } });
    const r2 = await askQuestion({ question: 'q', tMs: 1000, observer: null });
    assert.ok(!r2.ok && r2.kind === 'invalid');
  });

  it('runtime body → kind:runtime with code preserved', async () => {
    mockFetch(200, { ok: false, runtime: { code: 'E-OBSERVER', message: 'need location' } });
    const r = await askQuestion({ question: 'q', tMs: 1000, observer: null });
    assert.ok(!r.ok && r.kind === 'runtime' && r.code === 'E-OBSERVER' && r.message === 'need location');
  });

  it('429 → ratelimited; 503 → unavailable; malformed JSON → network; refusal body → refused', async () => {
    mockFetch(429, { error: 'slow down' }, false);
    assert.equal((await askQuestion({ question: 'q', tMs: 1000, observer: null }) as any).kind, 'ratelimited');

    mockFetch(503, { ok: false, error: 'nope' }, false);
    assert.equal((await askQuestion({ question: 'q', tMs: 1000, observer: null }) as any).kind, 'unavailable');

    globalThis.fetch = (async () => ({ status: 200, ok: true, json: async () => { throw new Error('bad json'); } }) as unknown as Response) as typeof fetch;
    assert.equal((await askQuestion({ question: 'q', tMs: 1000, observer: null }) as any).kind, 'network');

    mockFetch(200, { ok: false, refused: true, code: 'OFF_DOMAIN', reason: 'nope' });
    const r = await askQuestion({ question: 'q', tMs: 1000, observer: null });
    assert.ok(!r.ok && r.kind === 'refused' && r.code === 'OFF_DOMAIN');
  });

  it("mode:'result' with missing result key → network/malformed", async () => {
    mockFetch(200, { ok: true, mode: 'result', program: VALID_PROGRAM, interpretation: 'i', cached: false });
    const r = await askQuestion({ question: 'q', tMs: 1000, observer: null });
    assert.ok(!r.ok && r.kind === 'network');
  });
});
