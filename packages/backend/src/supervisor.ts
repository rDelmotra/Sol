// ============================================================
// Process supervisor — one container, two processes (API + DSO worker).
//
// Replaces `sh -c "node index.js & node dso-worker.js & wait"`, where a dead
// child went unnoticed (`wait` only returns when ALL children are gone, so a
// crashed API or worker left the container "healthy" but broken).
//
// Rules:
//   - spawn every child, forward SIGTERM/SIGINT to all of them;
//   - CRITICAL children (the `api`, the default): if one exits on its own, stop
//     the others and exit non-zero so the platform restarts the whole container;
//     if it dies within MIN_UPTIME_MS of starting, wait EXIT_BACKOFF_MS before
//     exiting, so a crash loop cannot spin;
//   - NON-CRITICAL children (`critical: false`, the `dso-worker`): the deep-space
//     feature is fully parallel and must never take the site down. If one exits on
//     its own (any code, even 0) or fails to spawn, ONLY that child is restarted,
//     after an exponential backoff (5 s, 10 s, 20 s ... capped at 5 min). The
//     backoff resets once the child has stayed up for 10 minutes. It never touches
//     the other children and never makes the supervisor exit. The backoff is also
//     the protection for upstream APIs (NASA Horizons): a crash loop cannot hammer
//     them;
//   - on shutdown every pending restart timer is cancelled and nothing is revived.
//
// `superviseChildren` is pure: spawn, exit, clock and timers are injected, so
// it is unit-tested without real processes. The bottom of the file is the
// real entry point (runs only when this file is the program, not on import).
// ============================================================

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './utils/logger.js';

export interface ChildSpec {
  name: string;
  /** Absolute path of the JS entry file to run with the current node binary. */
  script: string;
  /**
   * Default true. A critical child's unexpected exit stops everything and exits the
   * supervisor non-zero. A non-critical child is restarted alone, with backoff.
   */
  critical?: boolean;
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
  /** First restart delay for a non-critical child; doubles on each repeated crash. */
  restartBaseMs?: number;
  /** Longest restart delay for a non-critical child. */
  restartMaxMs?: number;
  /** A non-critical child that stayed up this long gets its restart delay reset. */
  restartStableMs?: number;
}

export interface Supervisor {
  /** Ask all children to stop (what SIGTERM/SIGINT do). Exits 0 when they are gone. */
  shutdown(signal: NodeJS.Signals): void;
}

export const DEFAULT_KILL_GRACE_MS = 10_000;
export const DEFAULT_MIN_UPTIME_MS = 10_000;
export const DEFAULT_EXIT_BACKOFF_MS = 5_000;
export const DEFAULT_RESTART_BASE_MS = 5_000;
export const DEFAULT_RESTART_MAX_MS = 5 * 60_000;
export const DEFAULT_RESTART_STABLE_MS = 10 * 60_000;

interface Running {
  spec: ChildSpec;
  /** The live process, or null while a restart is pending. */
  handle: ChildHandle | null;
  startedAt: number;
  /** True when no process is alive for this child (exited, or waiting for a restart). */
  exited: boolean;
  /** Delay to use for the next restart (non-critical only). */
  nextDelayMs: number;
  restartTimer: unknown;
}

export function superviseChildren(specs: readonly ChildSpec[], deps: SupervisorDeps): Supervisor {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const log = deps.log ?? logger;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const minUptimeMs = deps.minUptimeMs ?? DEFAULT_MIN_UPTIME_MS;
  const exitBackoffMs = deps.exitBackoffMs ?? DEFAULT_EXIT_BACKOFF_MS;
  const restartBaseMs = deps.restartBaseMs ?? DEFAULT_RESTART_BASE_MS;
  const restartMaxMs = deps.restartMaxMs ?? DEFAULT_RESTART_MAX_MS;
  const restartStableMs = deps.restartStableMs ?? DEFAULT_RESTART_STABLE_MS;

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
      // A pending restart must never revive a child after shutdown began.
      if (r.restartTimer !== undefined) {
        clearTimer(r.restartTimer);
        r.restartTimer = undefined;
      }
    }
    for (const r of running) {
      if (!r.exited) r.handle?.kill(signal);
    }
    if (running.every((r) => r.exited)) {
      finish();
      return;
    }
    graceTimer = setTimer(() => {
      for (const r of running) {
        if (!r.exited) {
          log.error(`Supervisor: ${r.spec.name} ignored ${signal}; sending SIGKILL`);
          r.handle?.kill('SIGKILL');
        }
      }
    }, killGraceMs);
  }

  let requestedSignal: NodeJS.Signals | null = null;

  /** Schedule the restart of a non-critical child. Only this child is touched. */
  function scheduleRestart(r: Running, code: number | null, signal: NodeJS.Signals | null, uptime: number): void {
    if (uptime >= restartStableMs) r.nextDelayMs = restartBaseMs;
    const delay = r.nextDelayMs;
    r.nextDelayMs = Math.min(delay * 2, restartMaxMs);
    log.error(
      `Supervisor: ${r.spec.name} (non-critical) exited (code=${code} signal=${signal} uptime=${uptime} ms); ` +
        `restarting it alone in ${delay} ms. The rest keeps running.`,
    );
    r.restartTimer = setTimer(() => {
      r.restartTimer = undefined;
      if (stopping) return;
      startChild(r);
    }, delay);
  }

  /** Spawn (or respawn) one child. Returns false if it could not be started. */
  function startChild(r: Running): boolean {
    const startedAt = now();
    let handle: ChildHandle;
    try {
      handle = deps.spawn(r.spec);
    } catch (err) {
      log.error(`Supervisor: could not start ${r.spec.name}: ${(err as Error).message}`);
      r.handle = null;
      r.exited = true;
      if (r.spec.critical !== false) return false;
      scheduleRestart(r, null, null, 0);
      return false;
    }
    r.handle = handle;
    r.startedAt = startedAt;
    r.exited = false;
    log.info(`Supervisor: started ${r.spec.name} (${r.spec.script})`);
    handle.onExit((code, signal) => {
      if (r.handle !== handle || r.exited) return; // a stale or repeated report
      onChildExit(r, code, signal);
    });
    return true;
  }

  function onChildExit(r: Running, code: number | null, signal: NodeJS.Signals | null): void {
    r.exited = true;
    r.handle = null;
    const uptime = now() - r.startedAt;

    if (!stopping && r.spec.critical === false) {
      scheduleRestart(r, code, signal, uptime);
      return;
    }

    if (!stopping) {
      // Unexpected: a critical child died on its own. Take the container down.
      log.error(
        `Supervisor: ${r.spec.name} exited unexpectedly (code=${code} signal=${signal} uptime=${uptime} ms); stopping the rest`,
      );
      exitCode = code !== null && code !== 0 ? code : 1;
      if (uptime < minUptimeMs) backoffMs = exitBackoffMs;
      stopAll('SIGTERM');
      return;
    }

    // We asked for the stop. A clean shutdown is exit 0, or death by the signal we sent.
    // A non-critical child's exit code does not decide the supervisor's exit code.
    const clean = code === 0 || (code === null && signal !== null && signal === (requestedSignal ?? 'SIGTERM'));
    if (!clean && exitCode === 0 && r.spec.critical !== false) {
      exitCode = code !== null && code !== 0 ? code : 1;
    }
    if (running.every((x) => x.exited)) finish();
  }

  for (const spec of specs) {
    const r: Running = {
      spec,
      handle: null,
      startedAt: now(),
      exited: true,
      nextDelayMs: restartBaseMs,
      restartTimer: undefined,
    };
    running.push(r);
    if (!startChild(r) && spec.critical !== false) {
      exitCode = 1;
      stopAll('SIGTERM');
      return { shutdown: () => undefined };
    }
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
      // 'error' also fires when kill() fails on a child that is still running; only a child
      // that never started (no pid) is dead, or a non-critical child would be started twice.
      child.on('error', () => {
        if (child.pid === undefined) cb(1, null);
      });
      child.once('exit', (code, signal) => cb(code, signal));
    },
  };
};

export function defaultChildren(
  dir: string = path.dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env,
): ChildSpec[] {
  const specs: ChildSpec[] = [
    { name: 'api', script: path.join(dir, 'index.js') },
    // Non-critical: the deep-space feature is isolated. A dead worker is restarted alone.
    { name: 'dso-worker', script: path.join(dir, 'dso-worker.js'), critical: false },
  ];
  // Non-critical, and only when the history database is configured: the nightly encounter screening writes to it.
  if (env.DATABASE_URL) specs.push({ name: 'ssa-worker', script: path.join(dir, 'ssa-worker.js'), critical: false });
  return specs;
}

function main(): void {
  const sup = superviseChildren(defaultChildren(), {
    spawn: spawnReal,
    exit: (code) => process.exit(code),
  });
  process.on('SIGTERM', () => sup.shutdown('SIGTERM'));
  process.on('SIGINT', () => sup.shutdown('SIGINT'));
}

/** True when this file is the program (node dist/supervisor.js), not an import. Follows symlinks. */
export function isEntryPoint(entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
