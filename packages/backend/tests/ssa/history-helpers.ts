// A small synthetic world for the history-file tests: element sets over ~35 days with every case the catalog / change rules care about
// (maneuver, object that goes stale, new object, decayed object, close pair, sparse object), written as per-day jsonl.gz files + objects file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { synthOmm } from './coverage-helpers.js';
import type { ObjectMeta } from '../../src/ssa/history/elset-files.js';

export const D0 = '2026-10-11';
export const D1 = '2026-10-12';
export const DAY = 86_400_000;
export const dms = (d: string): number => Date.parse(d + 'T00:00:00Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export interface SynthSet { noradId: number; epochMs: number; omm: Record<string, unknown> }

export function synthWorld(): { sets: SynthSet[]; objects: ObjectMeta[] } {
  const sets: SynthSet[] = [];
  const objects: ObjectMeta[] = [];
  const add = (id: number, epochMs: number, over: Record<string, unknown> = {}, name = `SYN-${id}`): void => {
    const omm = synthOmm(id, iso(epochMs), { OBJECT_NAME: name, ...over });
    sets.push({ noradId: id, epochMs, omm });
  };
  const meta = (id: number, o: Partial<ObjectMeta> = {}): void => {
    objects.push({ noradId: id, name: `SYN-${id}`, objectType: 'unknown', rcsSize: null, launchDate: '2020-01-01', decayDate: null, intlDesignator: `2020-0${id}A`, ...o });
  };
  const t1 = dms(D1);
  // 40 ordinary LEO objects, one set per day for the six days up to D1 (several per day for a few)
  for (let i = 0; i < 40; i++) {
    const id = 100 + i;
    const inc = [53, 98, 28.5, 70, 97.5, 51.6][i % 6]!;
    for (let k = 5; k >= 0; k--) {
      const ep = t1 - k * DAY + (3 * 3_600_000 + i * 60_000);
      let mm = 14.2 + (i % 5) * 0.4;
      if (id === 101 && k === 0) mm = 14.9; // a manoeuvre on D1 (semi-major axis drops ~90 km)
      add(id, ep, { INCLINATION: inc, RA_OF_ASC_NODE: (i * 37) % 360, MEAN_ANOMALY: (i * 91 + k * 5) % 360, MEAN_MOTION: mm, ECCENTRICITY: 0.0001 + (i % 4) * 0.001 });
    }
    if (i % 7 === 0) add(id, t1 - 2 * DAY + 20 * 3_600_000, { INCLINATION: inc, RA_OF_ASC_NODE: (i * 37) % 360, MEAN_ANOMALY: (i * 91 + 7) % 360, MEAN_MOTION: 14.2 + (i % 5) * 0.4 });
    meta(id, { name: i % 2 ? `NAME-${id}` : '', rcsSize: i % 3 ? 'SMALL' : 'LARGE' });
  }
  // 150: last set 29 d 18 h before the end of D0 -> in D0's catalog, out of D1's (disappeared on D1)
  add(150, t1 - 30 * DAY + 6 * 3_600_000, { MEAN_ANOMALY: 33 }); meta(150);
  // 200: first set on D1 (appeared on D1)
  add(200, t1 + 5 * 3_600_000, { MEAN_ANOMALY: 12 }); meta(200, { launchDate: '2026-10-05' });
  // 300 / 301: a close pair (formation)
  for (let k = 3; k >= 0; k--) { add(300, t1 - k * DAY + 2 * 3_600_000, { MEAN_ANOMALY: 100 }); add(301, t1 - k * DAY + 2 * 3_600_000, { MEAN_ANOMALY: 100.004 }); }
  meta(300); meta(301);
  // 400: decayed on D0 -> in D0's catalog, not in D1's
  add(400, t1 - 3 * DAY, { MEAN_ANOMALY: 250 }); add(400, t1 - 1 * DAY, { MEAN_ANOMALY: 250 }); meta(400, { decayDate: D0 });
  // 500: sparse, one set 20 days before D1
  add(500, t1 - 20 * DAY + 1000, { MEAN_ANOMALY: 80 }); meta(500);
  // an old set of 100 outside every window, to be ignored
  add(100, t1 - 40 * DAY, { MEAN_ANOMALY: 1 });
  sets.sort((a, b) => a.noradId - b.noradId || a.epochMs - b.epochMs);
  objects.sort((a, b) => a.noradId - b.noradId);
  // first-seen from the data
  for (const o of objects) o.firstEpoch = iso(Math.min(...sets.filter((s) => s.noradId === o.noradId).map((s) => s.epochMs)));
  return { sets, objects };
}

/** Write per-day files <dir>/elsets/YYYY/YYYY-MM-DD.jsonl.gz and <dir>/objects.jsonl.gz, in the converter's layout. */
export function writeWorld(dir: string, w: { sets: SynthSet[]; objects: ObjectMeta[] }): { elsets: string; objects: string } {
  const by = new Map<string, string[]>();
  for (const s of w.sets) {
    const day = iso(s.epochMs).slice(0, 10);
    (by.get(day) ?? by.set(day, []).get(day)!).push(JSON.stringify(s.omm));
  }
  const elsets = join(dir, 'elsets');
  for (const [day, ls] of by) {
    const p = join(elsets, day.slice(0, 4), `${day}.jsonl.gz`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, gzipSync(ls.join('\n') + '\n'));
  }
  const objects = join(dir, 'objects.jsonl.gz');
  writeFileSync(objects, gzipSync(w.objects.map((o) => JSON.stringify(o)).join('\n') + '\n'));
  return { elsets, objects };
}
