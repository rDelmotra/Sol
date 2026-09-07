// P3 S4 — POST /api/query/ask integration tests.
// Spec: my_plans/marvin/p3/S4_ask_route.md "Tests".
//
// Mounts createQueryRouter({compiler: fake, registry: fixture, nowMs}) on an
// ephemeral express app and hits it with global fetch — no supertest, matches
// the spec's stated constraint.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { DataSourceRegistry } from '../../src/analytic/registry.js';
import { createQueryRouter } from '../../src/routes/query.js';
import type { AnalyticCompiler, CompileOutcome } from '../../src/services/analytic-compiler.js';
import type { AnalyticProgram } from '@orbitwatch/analytic';
import type { FieldProvider, SpineProvider } from '../../src/analytic/types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const LIVE_SPINE: SpineProvider = { id: 'fixture:live-spine', spine: () => [201, 202, 203] };
const ALL_SPINE: SpineProvider = { id: 'fixture:all-spine', spine: () => [201, 202, 203, 999] };

const nameProvider: FieldProvider = {
  id: 'fixture:name',
  fields: ['name'],
  getField: (noradId, field) =>
    field === 'name' ? ({ 201: 'Alpha', 202: 'Beta', 203: 'Gamma', 999: 'Delta' }[noradId] ?? null) : null,
};

const massProvider: FieldProvider = {
  id: 'fixture:mass',
  fields: ['launchMassKg'],
  getField: (noradId, field) =>
    field === 'launchMassKg' ? ({ 201: 1200, 202: 300 }[noradId] ?? null) : null,
};

let lastElevationTMs: number | null = null;
const elevProvider: FieldProvider = {
  id: 'fixture:elev',
  fields: [],
  fns: ['elevationDeg'],
  getField: () => null,
  elevationDeg: (_i, _obs, tMs) => {
    lastElevationTMs = tMs;
    return 45;
  },
};

function freshFixtureRegistry(): DataSourceRegistry {
  const registry = new DataSourceRegistry();
  registry.registerSpine('live', LIVE_SPINE);
  registry.register('live', nameProvider);
  registry.register('live', massProvider);
  registry.register('live', elevProvider);
  registry.registerSpine('all', ALL_SPINE);
  registry.register('all', nameProvider);
  return registry;
}

/** Records whether buildSource was ever called — proves the client fast path never touches the registry. */
class SpyRegistry extends DataSourceRegistry {
  buildSourceCalls = 0;
  override buildSource(universe: 'live' | 'all') {
    this.buildSourceCalls++;
    return super.buildSource(universe);
  }
}

function freshSpyRegistry(): SpyRegistry {
  const registry = new SpyRegistry();
  registry.registerSpine('live', LIVE_SPINE);
  registry.register('live', nameProvider);
  registry.register('live', massProvider);
  registry.register('live', elevProvider);
  registry.registerSpine('all', ALL_SPINE);
  registry.register('all', nameProvider);
  return registry;
}

function fakeCompiler(outcome: CompileOutcome | ((question: string) => CompileOutcome)): AnalyticCompiler {
  return {
    compile: async (question: string) => (typeof outcome === 'function' ? outcome(question) : outcome),
  };
}

function program(overrides: Partial<AnalyticProgram>): AnalyticProgram {
  return {
    v: 1,
    universe: 'live',
    timeBinding: { mode: 'now' },
    interpretation: 'test program',
    pipeline: [{ op: 'limit', n: 10 }],
    output: { shape: 'ids' },
    ...overrides,
  } as AnalyticProgram;
}

/** Mounts a router with the given deps on an ephemeral port; returns the base URL + a teardown fn. */
async function startApp(deps: Parameters<typeof createQueryRouter>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/query', createQueryRouter(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/api/query`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/query/ask', () => {
  it('1. client-servable program → mode:program, no result key, registry never touched', async () => {
    const clientProgram = program({ pipeline: [{ op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } }] });
    const outcome: CompileOutcome = { ok: true, program: clientProgram, interpretation: 'leo objects', cached: false, tookMs: 1 };
    const spyRegistry = freshSpyRegistry();
    const { url, close } = await startApp({ compiler: fakeCompiler(outcome), registry: spyRegistry });
    try {
      const { status, json } = await post(url, { question: 'which satellites are in LEO' });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.mode, 'program');
      assert.deepEqual(json.program, clientProgram);
      assert.equal('result' in json, false);
      assert.equal(spyRegistry.buildSourceCalls, 0);
    } finally {
      await close();
    }
  });

  it('2. server-only program (launchMassKg) → mode:result, executed over the live fixture, ids is a plain array', async () => {
    const serverProgram = program({
      pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'launchMassKg' }, { lit: 500 }] } }],
    });
    const outcome: CompileOutcome = { ok: true, program: serverProgram, interpretation: 'heavy objects', cached: false, tookMs: 1 };
    const { url, close } = await startApp({ compiler: fakeCompiler(outcome), registry: freshFixtureRegistry() });
    try {
      const { status, json } = await post(url, { question: 'what is the heaviest object' });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.mode, 'result');
      assert.ok(Array.isArray(json.result.ids));
      assert.deepEqual(json.result.ids, [201]); // only 201 has launchMassKg > 500
      assert.equal(json.result.meta.scanned, 3);
      assert.equal(json.result.meta.matched, 1);
    } finally {
      await close();
    }
  });

  it("3. universe 'all' program → routed server, executed over the fixture 'all' source", async () => {
    const allProgram = program({
      universe: 'all',
      pipeline: [{ op: 'filter', where: { op: 'in', field: 'name', values: ['Delta'] } }],
    });
    const outcome: CompileOutcome = { ok: true, program: allProgram, interpretation: 'named Delta', cached: false, tookMs: 1 };
    const { url, close } = await startApp({ compiler: fakeCompiler(outcome), registry: freshFixtureRegistry() });
    try {
      const { status, json } = await post(url, { question: 'find the object named delta' });
      assert.equal(status, 200);
      assert.equal(json.mode, 'result');
      assert.deepEqual(json.result.ids, [999]); // 999 only exists in the 'all' spine
      assert.equal(json.result.meta.universe, 'all');
    } finally {
      await close();
    }
  });

  it('4. program needing observer, none sent → 200 runtime.code === E-OBSERVER', async () => {
    const obsProgram = program({
      pipeline: [{
        op: 'filter',
        where: {
          op: 'and',
          args: [
            { op: '>', args: [{ fn: 'elevationDeg', observer: 'user' }, { lit: 10 }] },
            { op: '>', args: [{ field: 'launchMassKg' }, { lit: 0 }] },
          ],
        },
      }],
    });
    const outcome: CompileOutcome = { ok: true, program: obsProgram, interpretation: 'visible heavy objects', cached: false, tookMs: 1 };
    const { url, close } = await startApp({ compiler: fakeCompiler(outcome), registry: freshFixtureRegistry() });
    try {
      const { status, json } = await post(url, { question: 'what heavy objects are overhead' });
      assert.equal(status, 200);
      assert.equal(json.ok, false);
      assert.equal(json.runtime.code, 'E-OBSERVER');
    } finally {
      await close();
    }
  });

  it('5. tMs is forwarded to the source, clamped into the propagation window', async () => {
    const massProgram2 = program({
      pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'launchMassKg' }, { lit: 0 }] } }],
    });
    const outcome: CompileOutcome = { ok: true, program: massProgram2, interpretation: 'heavy', cached: false, tookMs: 1 };
    const NOW = Date.parse('2026-07-20T00:00:00Z');
    const farFuture = NOW + 400 * 86_400_000; // far beyond FUTURE_CAP_DAYS
    const { url, close } = await startApp({
      compiler: fakeCompiler(outcome),
      registry: freshFixtureRegistry(),
      nowMs: () => NOW,
    });
    try {
      const { json } = await post(url, { question: 'heavy objects', tMs: farFuture });
      const evaluatedAtMs = Date.parse(json.result.meta.evaluatedAt);
      assert.ok(evaluatedAtMs < farFuture, 'must be clamped, not the raw far-future value');
      assert.ok(evaluatedAtMs > NOW, 'must still be in the future (clamped to +FUTURE_CAP_DAYS, not dropped to now)');
    } finally {
      await close();
    }
  });

  it('6. refusal / invalid / unavailable passthrough parity with /compile', async () => {
    const refused: CompileOutcome = { ok: false, kind: 'refused', code: 'OFF_DOMAIN', reason: 'nope', cached: false };
    const invalid: CompileOutcome = { ok: false, kind: 'invalid', issues: [{ code: 'V-ENUM', path: 'p', message: 'm' }] };
    const unavailable: CompileOutcome = { ok: false, kind: 'unavailable' };

    for (const [outcome, expectedStatus] of [[refused, 200], [invalid, 422], [unavailable, 503]] as const) {
      const { url, close } = await startApp({ compiler: fakeCompiler(outcome), registry: freshFixtureRegistry() });
      try {
        const { status, json } = await post(url, { question: 'irrelevant question here' });
        assert.equal(status, expectedStatus);
        assert.equal(json.ok, false);
      } finally {
        await close();
      }
    }
  });

  it('7. missing live source + server-routed program → runtime.code === E-UNIVERSE', async () => {
    const serverProgram = program({
      pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'launchMassKg' }, { lit: 0 }] } }],
    });
    const outcome: CompileOutcome = { ok: true, program: serverProgram, interpretation: 'heavy', cached: false, tookMs: 1 };
    const emptyRegistry = new DataSourceRegistry(); // no spine registered at all
    const { url, close } = await startApp({ compiler: fakeCompiler(outcome), registry: emptyRegistry });
    try {
      const { status, json } = await post(url, { question: 'heavy objects' });
      assert.equal(status, 200);
      assert.equal(json.ok, false);
      assert.equal(json.runtime.code, 'E-UNIVERSE');
    } finally {
      await close();
    }
  });

  it('8. /compile regression: still answers exactly as before via the shared factory', async () => {
    const clientProgram = program({});
    const outcome: CompileOutcome = { ok: true, program: clientProgram, interpretation: 'x', cached: true, tookMs: 0 };
    const { url, close } = await startApp({ compiler: fakeCompiler(outcome), registry: freshFixtureRegistry() });
    try {
      const res = await fetch(`${url}/compile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'anything at all here' }),
      });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(json, { ok: true, program: clientProgram, interpretation: 'x', cached: true });
    } finally {
      await close();
    }
  });

  it('bad question → 400 { error }', async () => {
    const { url, close } = await startApp({ compiler: fakeCompiler({ ok: false, kind: 'unavailable' }), registry: freshFixtureRegistry() });
    try {
      const { status, json } = await post(url, { question: 'x' });
      assert.equal(status, 400);
      assert.ok(typeof json.error === 'string');
    } finally {
      await close();
    }
  });
});
