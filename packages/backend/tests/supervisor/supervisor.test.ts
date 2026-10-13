// superviseChildren — pure supervisor logic with fake children, fake clock, fake timers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultChildren,
  isEntryPoint,
  superviseChildren,
  type ChildHandle,
  type ChildSpec,
  type SupervisorDeps,
} from '../../src/supervisor.js';

type ExitCb = (code: number | null, signal: NodeJS.Signals | null) => void;

class FakeChild implements ChildHandle {
  killed: NodeJS.Signals[] = [];
  private cb: ExitCb | null = null;
  /** signals that make this child exit by itself (default: SIGTERM and SIGINT). */
  honours = new Set<NodeJS.Signals>(['SIGTERM', 'SIGINT', 'SIGKILL']);
  constructor(readonly spec: ChildSpec) {}
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    if (this.honours.has(signal)) this.die(null, signal);
    return true;
  }
  onExit(cb: ExitCb): void {
    this.cb = cb;
  }
  die(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.cb?.(code, signal);
  }
}

const SPECS: ChildSpec[] = [
  { name: 'api', script: '/app/dist/index.js' },
  { name: 'dso-worker', script: '/app/dist/dso-worker.js' },
];

function harness(overrides: Partial<SupervisorDeps> = {}) {
  const children: FakeChild[] = [];
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let clock = 1_000_000;
  const deps: SupervisorDeps = {
    spawn: (spec) => {
      const c = new FakeChild(spec);
      children.push(c);
      return c;
    },
    exit: (code) => exits.push(code),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
    log: { info: () => undefined, error: () => undefined },
    ...overrides,
  };
  const sup = superviseChildren(SPECS, deps);
  return {
    sup,
    children,
    exits,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
    fireTimers: () => timers.filter((t) => !t.cancelled).forEach((t) => t.fn()),
  };
}

describe('superviseChildren', () => {
  it('spawns every child', () => {
    const h = harness();
    assert.deepEqual(h.children.map((c) => c.spec.name), ['api', 'dso-worker']);
    assert.deepEqual(h.exits, []);
  });

  it('forwards SIGTERM to all children and exits 0 once they are gone', () => {
    const h = harness();
    h.sup.shutdown('SIGTERM');
    assert.deepEqual(h.children.map((c) => c.killed), [['SIGTERM'], ['SIGTERM']]);
    assert.deepEqual(h.exits, [0]);
  });

  it('forwards SIGINT as SIGINT and still exits 0', () => {
    const h = harness();
    h.sup.shutdown('SIGINT');
    assert.deepEqual(h.children.map((c) => c.killed), [['SIGINT'], ['SIGINT']]);
    assert.deepEqual(h.exits, [0]);
  });

  it('waits for a slow child on shutdown, then exits 0', () => {
    const h = harness();
    h.children[1].honours.clear();
    h.sup.shutdown('SIGTERM');
    assert.deepEqual(h.exits, []);
    h.children[1].die(0);
    assert.deepEqual(h.exits, [0]);
  });

  it('SIGKILLs a child that ignores the stop signal after the grace period', () => {
    const h = harness();
    h.children[1].honours = new Set(['SIGKILL']);
    h.children[0].honours = new Set(['SIGKILL', 'SIGTERM']);
    h.sup.shutdown('SIGTERM');
    assert.deepEqual(h.exits, []);
    h.fireTimers();
    assert.deepEqual(h.children[1].killed, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(h.exits.length, 1);
  });

  it('if the API dies, kills the worker and exits non-zero (child code)', () => {
    const h = harness();
    h.advance(60_000); // long-lived: no backoff
    h.children[0].die(3);
    assert.deepEqual(h.children[1].killed, ['SIGTERM']);
    assert.deepEqual(h.exits, [3]);
  });

  it('if the worker dies with code 0, still exits non-zero (1)', () => {
    const h = harness();
    h.advance(60_000);
    h.children[1].die(0);
    assert.deepEqual(h.children[0].killed, ['SIGTERM']);
    assert.deepEqual(h.exits, [1]);
  });

  it('if a child is killed by a signal, exits 1', () => {
    const h = harness();
    h.advance(60_000);
    h.children[0].die(null, 'SIGKILL');
    assert.deepEqual(h.exits, [1]);
  });

  it('delays the exit when a child dies right after start (crash-loop backoff)', () => {
    const h = harness({ minUptimeMs: 10_000, exitBackoffMs: 5_000 });
    h.advance(500);
    h.children[0].die(1);
    assert.deepEqual(h.exits, []);
    const backoff = h.timers.find((t) => t.ms === 5_000);
    assert.ok(backoff, 'expected a 5 s backoff timer');
    backoff!.fn();
    assert.deepEqual(h.exits, [1]);
  });

  it('does not delay the exit when the child had a long uptime', () => {
    const h = harness({ minUptimeMs: 10_000, exitBackoffMs: 5_000 });
    h.advance(11_000);
    h.children[0].die(1);
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.timers.some((t) => t.ms === 5_000), false);
  });

  it('exits once even if both children report exit twice', () => {
    const h = harness();
    h.advance(60_000);
    h.children[0].die(2);
    h.children[0].die(2);
    h.children[1].die(null, 'SIGTERM');
    assert.deepEqual(h.exits, [2]);
  });

  it('a failed spawn stops the children already started and exits 1', () => {
    const exits: number[] = [];
    const started: FakeChild[] = [];
    superviseChildren(SPECS, {
      spawn: (spec) => {
        if (spec.name === 'dso-worker') throw new Error('ENOENT');
        const c = new FakeChild(spec);
        started.push(c);
        return c;
      },
      exit: (code) => exits.push(code),
      log: { info: () => undefined, error: () => undefined },
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    assert.deepEqual(started[0].killed, ['SIGTERM']);
    assert.deepEqual(exits, [1]);
  });

  it('a signal after a child death does not change the exit code', () => {
    const h = harness();
    h.advance(60_000);
    h.children[1].honours.clear();
    h.children[0].die(7);
    h.sup.shutdown('SIGTERM');
    h.children[1].die(null, 'SIGTERM');
    assert.deepEqual(h.exits, [7]);
  });
});

describe('defaultChildren', () => {
  it('runs the API and the DSO worker from the given dist directory', () => {
    const specs = defaultChildren('/app/packages/backend/dist');
    assert.deepEqual(specs, [
      { name: 'api', script: '/app/packages/backend/dist/index.js' },
      { name: 'dso-worker', script: '/app/packages/backend/dist/dso-worker.js' },
    ]);
  });
});

describe('isEntryPoint', () => {
  it('is false when argv[1] is another file or missing', () => {
    assert.equal(isEntryPoint('/tmp/some-other-file.js'), false);
    assert.equal(isEntryPoint(undefined as unknown as string), false);
    assert.equal(isEntryPoint(''), false);
  });
});
