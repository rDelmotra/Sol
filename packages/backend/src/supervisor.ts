// ============================================================
// Process supervisor — one container, two processes (API + DSO worker).
//
// Replaces `sh -c "node index.js & node dso-worker.js & wait"`, where a dead
// child went unnoticed (`wait` only returns when ALL children are gone, so a
// crashed API or worker left the container "healthy" but broken).
//
// Rules:
//   - spawn every child, forward SIGTERM/SIGINT to all of them;
//   - if ANY child exits on its own, stop the others and exit non-zero so the
//     platform restarts the whole container;
//   - if a child dies within MIN_UPTIME_MS of starting, wait EXIT_BACKOFF_MS
//     before exiting, so a crash loop cannot spin (and cannot hammer upstream
//     APIs on every restart).
//
// `superviseChildren` is pure: spawn, exit, clock and timers are injected, so
// it is unit-tested without real processes. The bottom of the file is the
// real entry point (runs only when this file is the program, not on import).
// ============================================================

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from './utils/logger.js';

export interface ChildSpec {
  name: string;
  /** Absolute path of the JS entry file to run with the current node binary. */
  script: string;
}

export interface ChildHandle {
  kill(signal?: NodeJS.Signals): boolean;
  /** Called once when the child is gone (exit, signal, or failure to spawn). */
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export type SpawnFn = (spec: ChildSpec) => ChildHandle;

export interface SupervisorDeps {
  spawn: SpawnFn;
  /** Ends the supervisor process with this exit code. */
  exit: (code: number) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  /** How long children get to stop after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /** A child that dies sooner than this after start counts as a crash loop. */
  minUptimeMs?: number;
  /** Delay before exiting after a crash-loop death. */
  exitBackoffMs?: number;
}

export interface Supervisor {
  /** Ask all children to stop (what SIGTERM/SIGINT do). Exits 0 when they are gone. */
  shutdown(signal: NodeJS.Signals): void;
}

export const DEFAULT_KILL_GRACE_MS = 10_000;
export const DEFAULT_MIN_UPTIME_MS = 10_000;
export const DEFAULT_EXIT_BACKOFF_MS = 5_000;

interface Running {
  spec: ChildSpec;
  handle: ChildHandle;
  startedAt: number;
  exited: boolean;
}

export function superviseChildren(specs: readonly ChildSpec[], deps: SupervisorDeps): Supervisor {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const log = deps.log ?? logger;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const minUptimeMs = deps.minUptimeMs ?? DEFAULT_MIN_UPTIME_MS;
  const exitBackoffMs = deps.exitBackoffMs ?? DEFAULT_EXIT_BACKOFF_MS;

  const running: Running[] = [];
  let stopping = false;   // we asked everyone to stop (either a signal or a child died)
  let finished = false;   // exit() was called
  let exitCode = 0;
  let backoffMs = 0;
  let graceTimer: unknown;

  function finish(): void {
    if (finished) return;
    finished = true;
    if (graceTimer !== undefined) clearTimer(graceTimer);
    const doExit = () => deps.exit(exitCode);
    if (backoffMs > 0) {
      log.error(`Supervisor: waiting ${backoffMs} ms before exit (child died right after start)`);
      setTimer(doExit, backoffMs);
    } else {
      doExit();
    }
  }

  function stopAll(signal: NodeJS.Signals): void {
    if (stopping) return;
    stopping = true;
    for (const r of running) {
      if (!r.exited) r.handle.kill(signal);
    }
    if (running.every((r) => r.exited)) {
      finish();
      return;
    }
    graceTimer = setTimer(() => {
      for (const r of running) {
        if (!r.exited) {
          log.error(`Supervisor: ${r.spec.name} ignored ${signal}; sending SIGKILL`);
          r.handle.kill('SIGKILL');
        }
      }
    }, killGraceMs);
  }

  let requestedSignal: NodeJS.Signals | null = null;

  function onChildExit(r: Running, code: number | null, signal: NodeJS.Signals | null): void {
    if (r.exited) return;
    r.exited = true;

    if (!stopping) {
      // Unexpected: this child died on its own. Take the container down.
      const uptime = now() - r.startedAt;
      log.error(
        `Supervisor: ${r.spec.name} exited unexpectedly (code=${code} signal=${signal} uptime=${uptime} ms); stopping the rest`,
      );
      exitCode = code !== null && code !== 0 ? code : 1;
      if (uptime < minUptimeMs) backoffMs = exitBackoffMs;
      stopAll('SIGTERM');
      return;
    }

    // We asked for the stop. A clean shutdown is exit 0, or death by the signal we sent.
    const clean = code === 0 || (code === null && signal !== null && signal === (requestedSignal ?? 'SIGTERM'));
    if (!clean && exitCode === 0) {
      exitCode = code !== null && code !== 0 ? code : 1;
    }
    if (running.every((x) => x.exited)) finish();
  }

  for (const spec of specs) {
    let handle: ChildHandle;
    const startedAt = now();
    try {
      handle = deps.spawn(spec);
    } catch (err) {
      log.error(`Supervisor: could not start ${spec.name}: ${(err as Error).message}`);
      exitCode = 1;
      stopAll('SIGTERM');
      return { shutdown: () => undefined };
    }
    const r: Running = { spec, handle, startedAt, exited: false };
    running.push(r);
    log.info(`Supervisor: started ${spec.name} (${spec.script})`);
    handle.onExit((code, signal) => onChildExit(r, code, signal));
  }

  return {
    shutdown(signal) {
      if (stopping) return;
      requestedSignal = signal;
      log.info(`Supervisor: received ${signal}; stopping children`);
      stopAll(signal);
    },
  };
}

// ── Real process wiring ──────────────────────────────────────────────────────

/** SpawnFn backed by child_process: runs the script with this node binary, stdio inherited. */
export const spawnReal: SpawnFn = (spec) => {
  const child = nodeSpawn(process.execPath, [spec.script], { stdio: 'inherit', env: process.env });
  return {
    kill: (signal) => child.kill(signal),
    onExit(cb) {
      // 'error' (spawn failure) can be followed by 'exit'; superviseChildren ignores the second.
      child.once('error', () => cb(1, null));
      child.once('exit', (code, signal) => cb(code, signal));
    },
  };
};

export function defaultChildren(dir: string = path.dirname(fileURLToPath(import.meta.url))): ChildSpec[] {
  return [
    { name: 'api', script: path.join(dir, 'index.js') },
    { name: 'dso-worker', script: path.join(dir, 'dso-worker.js') },
  ];
}

function main(): void {
  const sup = superviseChildren(defaultChildren(), {
    spawn: spawnReal,
    exit: (code) => process.exit(code),
  });
  process.on('SIGTERM', () => sup.shutdown('SIGTERM'));
  process.on('SIGINT', () => sup.shutdown('SIGINT'));
}

// Run only when this file is the program (node dist/supervisor.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
