// Runs scripts/history/build-range.ts in a child process (tsx), as the lab does.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BUILD_RANGE = fileURLToPath(new URL('../../scripts/history/build-range.ts', import.meta.url));
const CWD = fileURLToPath(new URL('../..', import.meta.url));

export function runBuildRange(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', BUILD_RANGE, ...args], { cwd: CWD, encoding: 'utf8', timeout: 540_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
