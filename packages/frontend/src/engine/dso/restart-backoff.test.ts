import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DSO_WORKER_RESTART_BASE_MS,
  DSO_WORKER_RESTART_MAX_MS,
  nextWorkerRestartDelay,
} from './restart-backoff';

describe('DSO worker restart backoff', () => {
  it('doubles from the base and caps at 5 minutes', () => {
    let d = DSO_WORKER_RESTART_BASE_MS;
    const seen = [d];
    for (let i = 0; i < 14; i += 1) {
      d = nextWorkerRestartDelay(d);
      seen.push(d);
    }
    assert.deepEqual(seen.slice(0, 4), [500, 1000, 2000, 4000]);
    assert.equal(Math.max(...seen), DSO_WORKER_RESTART_MAX_MS);
    assert.equal(seen[seen.length - 1], DSO_WORKER_RESTART_MAX_MS);
  });
});
