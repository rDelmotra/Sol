import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DSO_WORKER_RESTART_BASE_MS,
  DSO_WORKER_RESTART_MAX_MS,
  DSO_WORKER_STABLE_MS,
  nextWorkerRestartDelay,
  workerBackoffAfterMessage,
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

  it('resets to the base only after the worker has stayed up long enough', () => {
    assert.equal(workerBackoffAfterMessage(8000, DSO_WORKER_STABLE_MS), DSO_WORKER_RESTART_BASE_MS);
    assert.equal(workerBackoffAfterMessage(8000, DSO_WORKER_STABLE_MS + 5000), DSO_WORKER_RESTART_BASE_MS);
  });

  it('a worker that posts one message and then dies keeps its growing delay', () => {
    assert.equal(workerBackoffAfterMessage(8000, 50), 8000);
    assert.equal(workerBackoffAfterMessage(8000, DSO_WORKER_STABLE_MS - 1), 8000);
  });
});
