import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnalyticDataSource, AnalyticProgram } from '@orbitwatch/analytic';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { AnalyticRuntime, type LiveDataPort, type AnalyticRuntimeDeps } from './AnalyticRuntime';
import type { LiveSourceDeps } from '../../query/analytic/live-source';

const PROGRAM = { version: 1 } as unknown as AnalyticProgram;

function makePort(over: Partial<LiveDataPort> = {}): LiveDataPort {
  return {
    isReady: () => true,
    getCatalog: () => [],
    getLatestBuffers: () => null,
    getVisualNoradIds: () => new Set<number>(),
    ...over,
  };
}

function makeDeps(over: Partial<AnalyticRuntimeDeps> = {}): AnalyticRuntimeDeps {
  return {
    createSource: () => ({}) as AnalyticDataSource,
    getVocab: () => null,
    getObserver: () => null,
    nowMs: () => 1_700_000_000_000,
    ...over,
  };
}

test('run returns notReady and builds no source when the port is not ready', () => {
  let created = 0;
  const rt = new AnalyticRuntime(
    makePort({ isReady: () => false }),
    makeDeps({ createSource: () => { created++; return {} as AnalyticDataSource; } }),
  );
  assert.deepEqual(rt.run(PROGRAM), { notReady: true });
  assert.equal(created, 0);
});

test('run forwards the port catalog and builds a fresh source per call', () => {
  const catalog = [{ noradId: 1 }] as unknown as EnrichedTLEObject[];
  const seen: LiveSourceDeps[] = [];
  const rt = new AnalyticRuntime(
    makePort({ getCatalog: () => catalog }),
    makeDeps({
      createSource: (d) => { seen.push(d); throw new Error('stop'); },
    }),
  );
  assert.throws(() => rt.run(PROGRAM), /stop/);
  assert.throws(() => rt.run(PROGRAM), /stop/);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.catalog, catalog);
  assert.notEqual(seen[0], seen[1]);
});

test('tick delegates to the ResidentSet with the injected clock', () => {
  const rt = new AnalyticRuntime(makePort({ isReady: () => false }), makeDeps());
  const calls: number[] = [];
  const orig = rt.residentSet.tick.bind(rt.residentSet);
  rt.residentSet.tick = (fn, now) => {
    calls.push(now);
    assert.deepEqual(fn(PROGRAM), { notReady: true });
    return orig(fn, now);
  };
  assert.deepEqual(rt.tick(), []);
  assert.deepEqual(calls, [1_700_000_000_000]);
});
