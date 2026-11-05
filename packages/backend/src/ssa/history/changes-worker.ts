// Worker half of the history backfill's change detection (pool: ../pool.ts with workerBase 'history/changes-worker'): one task =
// the change detection of one day from two catalogs, so the main thread stays free to feed the coverage workers.
import { parentPort } from 'node:worker_threads';
import { deriveDayFromCatalogs, type DeriveFilesResult } from './derive-files.js';
import type { ChangeObject } from '../events/types.js';

export interface ChangesTask {
  kind: 'changes';
  day: string;
  prev: ChangeObject[];
  cur: ChangeObject[];
  /** first-seen day of the objects that appear today */
  firstSeen: Array<[number, string]>;
  skipFormation?: boolean;
  jumpDposKm?: number;
  jumpDaKm?: number;
  /** era position accuracy, quoted in elements.jump payloads (history backfill) */
  accuracy?: { medianKm: number; p95Km: number };
}
export type ChangesOut = DeriveFilesResult & { wallS: number };

parentPort!.on('message', (m: { id: number; msg: ChangesTask | { kind: 'init' } }) => {
  const t = m.msg;
  if (t.kind === 'init') { parentPort!.postMessage({ id: m.id, out: true }); return; }
  const T = Date.now();
  const fs = new Map(t.firstSeen);
  const r = deriveDayFromCatalogs(t.prev, t.cur, t.day, {
    firstSeen: (id) => fs.get(id), ...(t.skipFormation ? { skipFormation: true } : {}),
    ...(t.jumpDposKm !== undefined ? { jumpDposKm: t.jumpDposKm } : {}), ...(t.jumpDaKm !== undefined ? { jumpDaKm: t.jumpDaKm } : {}),
    ...(t.accuracy ? { accuracy: t.accuracy } : {}),
  });
  parentPort!.postMessage({ id: m.id, out: { ...r, wallS: +((Date.now() - T) / 1000).toFixed(2) } satisfies ChangesOut });
});
