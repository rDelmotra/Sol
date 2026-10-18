import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoadGate, DEFAULT_GATE_MAX_WAIT_MS } from './load-gate';
import { fetchTleCatalog } from './tle-client';

/** Resolves true if `p` has resolved by now (after flushing microtasks), else false. */
async function isResolved(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; });
  await new Promise<void>((r) => setImmediate(r));
  return done;
}

describe('createLoadGate', () => {
  it('stays closed until settled, then resolves every waiter', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = createLoadGate();
    const a = gate.whenOpen();
    const b = gate.whenOpen();
    assert.equal(gate.settled, false);
    assert.equal(await isResolved(a), false);

    gate.settle();
    assert.equal(gate.settled, true);
    await a;
    await b;
  });

  it('resolves on timeout when never settled', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = createLoadGate();
    const p = gate.whenOpen(15_000);

    t.mock.timers.tick(14_999);
    assert.equal(await isResolved(p), false);

    t.mock.timers.tick(1);
    await p;
    assert.equal(gate.settled, false, 'a timeout does not mark the gate settled');
  });

  it('default max wait is 15 s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(DEFAULT_GATE_MAX_WAIT_MS, 15_000);
    const p = createLoadGate().whenOpen();
    t.mock.timers.tick(DEFAULT_GATE_MAX_WAIT_MS);
    await p;
  });

  it('resolves immediately when already settled, and settle() twice is harmless', async () => {
    const gate = createLoadGate();
    gate.settle();
    gate.settle();
    assert.equal(await isResolved(gate.whenOpen()), true);
  });

  it('settling clears the pending timer (no late wake-up)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = createLoadGate();
    const p = gate.whenOpen(15_000);
    gate.settle();
    await p;
    // Ticking past the old deadline must not throw or re-resolve anything.
    t.mock.timers.tick(20_000);
  });
});

describe('fetchTleCatalog opens the catalog gate', () => {
  const realFetch = globalThis.fetch;
  const restore = () => { globalThis.fetch = realFetch; };

  function fakeGate() {
    let settleCount = 0;
    return { gate: { settle: () => { settleCount++; } }, count: () => settleCount };
  }

  it('settles after a successful download', async (t) => {
    t.after(restore);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: 'v1', data: [] }), { status: 200 })) as typeof fetch;
    const { gate, count } = fakeGate();

    const result = await fetchTleCatalog('http://catalog.test', gate);

    assert.equal(result.catalogData.length, 0);
    assert.equal(count(), 1);
  });

  it('settles when the catalog request fails (HTTP error)', async (t) => {
    t.after(restore);
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const { gate, count } = fakeGate();

    await assert.rejects(fetchTleCatalog('http://catalog.test', gate), /TLE fetch failed: 503/);

    assert.equal(count(), 1);
  });

  it('settles when the network itself throws', async (t) => {
    t.after(restore);
    globalThis.fetch = (async () => { throw new TypeError('network down'); }) as typeof fetch;
    const { gate, count } = fakeGate();

    await assert.rejects(fetchTleCatalog('http://catalog.test', gate), /network down/);

    assert.equal(count(), 1);
  });
});
