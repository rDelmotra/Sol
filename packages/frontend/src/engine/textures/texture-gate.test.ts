import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoadGate } from '../../data/load-gate';
import { textureStartGate } from './texture-gate';

const URLS = ['/textures/a.ktx2', '/textures/b.ktx2'] as const;

async function isResolved(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; });
  await new Promise<void>((r) => setImmediate(r));
  return done;
}

describe('textureStartGate', () => {
  it('waits for the catalog gate when the textures are not cached', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = createLoadGate();
    const p = textureStartGate(URLS, gate, async () => false);
    assert.equal(await isResolved(p), false);

    gate.settle();
    await p;
  });

  it('goes ahead after the maximum wait if the catalog never settles', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = createLoadGate();
    const p = textureStartGate(URLS, gate, async () => false, 15_000);
    assert.equal(await isResolved(p), false);

    t.mock.timers.tick(15_000);
    await p;
  });

  it('goes ahead at once when the gate is already open (warm catalog / fast catalog)', async () => {
    const gate = createLoadGate();
    gate.settle();
    let probed = false;
    await textureStartGate(URLS, gate, async () => { probed = true; return false; });
    assert.equal(probed, false, 'no cache lookup needed when the gate is open');
  });

  it('goes ahead at once when every texture is already cached locally', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = createLoadGate(); // never settled
    const p = textureStartGate(URLS, gate, async () => true);
    assert.equal(await isResolved(p), true);
  });

  it('treats a failing cache lookup as "not cached" and waits on the gate', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = createLoadGate();
    const p = textureStartGate(URLS, gate, async () => { throw new Error('caches blocked'); });
    assert.equal(await isResolved(p), false);

    gate.settle();
    await p;
  });
});
