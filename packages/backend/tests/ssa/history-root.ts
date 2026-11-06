// A history root (SSA_HISTORY_DIR layout) built end to end for the API tests: the synthetic world of history-helpers.ts as element-set
// files, then build-range.ts for two days (coverage + events), plus a tiny 1965 world (B* = 0 sets -> SGP) built for two days.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthOmm } from './coverage-helpers.js';
import { D0, D1, DAY, dms, iso, synthWorld, writeWorld } from './history-helpers.js';
import { runBuildRange } from './history-run.js';
import type { ObjectMeta } from '../../src/ssa/history/elset-files.js';

export interface TestRoot { root: string; elsets: string; objects: string; cleanup: () => void }

/** A 1965 world: 12 SGP-era objects (BSTAR 0, drag in MEAN_MOTION_DOT), one set per day for 6 days up to 1965-06-06. */
export function world1965(): { sets: Array<{ noradId: number; epochMs: number; omm: Record<string, unknown> }>; objects: ObjectMeta[] } {
  const sets: Array<{ noradId: number; epochMs: number; omm: Record<string, unknown> }> = [];
  const objects: ObjectMeta[] = [];
  const t = dms('1965-06-06');
  for (let i = 0; i < 12; i++) {
    const id = 700 + i;
    for (let k = 5; k >= 0; k--) {
      const ep = t - k * DAY + 4 * 3_600_000 + i * 60_000;
      sets.push({ noradId: id, epochMs: ep, omm: synthOmm(id, iso(ep), { OBJECT_NAME: `OLD-${id}`, OBJECT_ID: `1964-0${id}A`, BSTAR: 0, MEAN_MOTION_DOT: 0.0002, MEAN_MOTION: 14.0 + (i % 4) * 0.5, INCLINATION: [50, 65, 80, 90][i % 4], RA_OF_ASC_NODE: (i * 41) % 360, MEAN_ANOMALY: (i * 77 + k * 5) % 360, ECCENTRICITY: 0.002 }) });
    }
    objects.push({ noradId: id, name: `OLD-${id}`, objectType: 'satellite', rcsSize: null, launchDate: '1964-03-01', decayDate: null, intlDesignator: `1964-0${id}A`, firstEpoch: iso(t - 5 * DAY + 4 * 3_600_000) });
  }
  return { sets, objects };
}

let cached: TestRoot | null = null;
export function buildTestRoot(): TestRoot {
  if (cached) return cached;
  const root = mkdtempSync(join(tmpdir(), 'histroot-'));
  const w = synthWorld(), w65 = world1965();
  // both worlds in one tree: the 1965 sets are separate day files, the objects file holds both
  const merged = { sets: [...w.sets, ...w65.sets], objects: [...w.objects, ...w65.objects].sort((a, b) => a.noradId - b.noradId) };
  const files = writeWorld(root, merged);
  for (const [from, to] of [[D0, D1], ['1965-06-05', '1965-06-06']] as const) {
    const r = runBuildRange(['--elsets', files.elsets, '--objects', files.objects, '--out', root, '--from', from, '--to', to, '--workers', '2']);
    if (r.status !== 0) throw new Error(`build-range ${from}..${to} failed: ${r.stderr}${r.stdout}`);
  }
  cached = { root, elsets: files.elsets, objects: files.objects, cleanup: () => { rmSync(root, { recursive: true, force: true }); cached = null; } };
  return cached;
}
