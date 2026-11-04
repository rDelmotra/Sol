// ============================================================
// Per-day element-set files written by scripts/history/convert.py, and the object metadata file:
//
//   <elsets>/YYYY/YYYY-MM-DD.jsonl.gz   one OMM object per line (OBJECT_NAME, OBJECT_ID, EPOCH, MEAN_MOTION, ... NORAD_CAT_ID, BSTAR ...),
//                                       every set whose epoch is in that UTC day, ordered by (NORAD id, epoch)
//   <objects>                           objects.jsonl.gz: noradId, name, objectType, rcsSize, launchDate, decayDate, intlDesignator,
//                                       owner, firstEpoch, lastEpoch, nSets
// ============================================================
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export interface Elset { noradId: number; epochMs: number; omm: Record<string, unknown> }
export interface ObjectMeta {
  noradId: number;
  name: string;
  objectType: string;
  rcsSize: string | null;
  launchDate: string | null;
  decayDate: string | null;
  intlDesignator: string | null;
  owner?: string | null;
  firstEpoch?: string | null;
  lastEpoch?: string | null;
  nSets?: number;
}

export const elsetDayPath = (dir: string, day: string): string => join(dir, day.slice(0, 4), `${day}.jsonl.gz`);

const lines = (buf: Buffer, gz: boolean): string[] => {
  const text = (gz ? gunzipSync(buf) : buf).toString('utf8');
  return text.split('\n').filter((l) => l.length > 0);
};

const parseEpoch = (s: unknown): number => { const t = String(s); return Date.parse(t.endsWith('Z') ? t : t + 'Z'); };

/** The element sets of one UTC day (empty when the day has no file). Lines with an unusable epoch or id are dropped. */
export function readElsetDay(dir: string, day: string): Elset[] {
  const p = elsetDayPath(dir, day);
  if (!existsSync(p)) return [];
  const out: Elset[] = [];
  for (const l of lines(readFileSync(p), true)) {
    const omm = JSON.parse(l) as Record<string, unknown>;
    const noradId = Number(omm.NORAD_CAT_ID);
    const epochMs = parseEpoch(omm.EPOCH);
    if (Number.isInteger(noradId) && Number.isFinite(epochMs)) out.push({ noradId, epochMs, omm });
  }
  return out;
}

/** objects.jsonl.gz (or an uncompressed .jsonl) -> map by NORAD id. */
export function loadObjects(file: string): Map<number, ObjectMeta> {
  const m = new Map<number, ObjectMeta>();
  for (const l of lines(readFileSync(file), file.endsWith('.gz'))) {
    const o = JSON.parse(l) as ObjectMeta;
    if (Number.isInteger(o.noradId)) m.set(o.noradId, o);
  }
  return m;
}
