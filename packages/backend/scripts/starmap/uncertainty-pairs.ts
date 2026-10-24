// ============================================================
// SPIKE — not production. U5 step 1: collect (older element set propagated to the epoch of a newer one) offsets.
//
// Reads the daily history files (default 2026-09-20..2026-10-18), deduplicates element sets by (noradId, EPOCH),
// and for every pair of sets of one object with epoch gap 0.25..14 d propagates the older to the newer epoch and
// stores the position / velocity difference in the newer set's radial / in-track / cross-track frame.
// Output: data/uncertainty/pairs.bin (Float32 columns, see COLS in uncertainty-lib.ts) + pairs-meta.json.
// Usage: npx tsx packages/backend/scripts/starmap/uncertainty-pairs.ts [--workers 3] [--from 2026-09-20] [--to 2026-10-18]
// ============================================================
import { Worker } from 'node:worker_threads';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './catalog.js';
import { contiguousDays, loadDayCatalog, epochMsOf, identicalGroups } from './events.js';
import { classKey, normType, normRegime, NCOL, COLS, UDIR } from './uncertainty-lib.js';


async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workers = Math.min(3, Number(args.get('workers') ?? 3));
  const days = contiguousDays().filter((d) => d >= (args.get('from') ?? '2026-09-20') && d <= (args.get('to') ?? '2026-10-18'));
  mkdirSync(UDIR, { recursive: true });
  const t0 = Date.now();
  const byObj = new Map<number, { sets: Map<number, { epochMs: number; day: number; omm: Record<string, unknown> }>; meta: any }>();
  let rawSets = 0;
  let lastCat: ReturnType<typeof loadDayCatalog> = [];
  days.forEach((day, di) => {
    const cat = loadDayCatalog(day);
    lastCat = cat;
    for (const o of cat) {
      rawSets++;
      let e = byObj.get(o.noradId);
      if (!e) byObj.set(o.noradId, (e = { sets: new Map(), meta: null }));
      const ep = epochMsOf(o.omm);
      if (!e.sets.has(ep)) e.sets.set(ep, { epochMs: ep, day: di, omm: o.omm });
      e.meta = o; // latest day's metadata wins
    }
  });
  const { group } = identicalGroups(lastCat);
  const identicalNorads = new Set<number>();
  lastCat.forEach((o, i) => { if (group[i]! >= 0) identicalNorads.add(o.noradId); });
  const ids = [...byObj.keys()].sort((a, b) => a - b);
  const objects = ids.map((id, idx) => {
    const m = byObj.get(id)!.meta;
    const type = normType(m.objectType);
    return { idx, norad: id, name: m.name as string, regime: normRegime(m.regime), type, perigee: Number(m.perigee), apogee: Number(m.apogee), bstar: Number(m.omm.BSTAR), cls: classKey(m.regime, type, Number(m.perigee), Number(m.omm.BSTAR)), identical: identicalNorads.has(id), nSets: byObj.get(id)!.sets.size };
  });
  const dedupSets = objects.reduce((s, o) => s + o.nSets, 0);
  console.log(`loaded ${days.length} days, ${rawSets} file rows -> ${dedupSets} unique (noradId,EPOCH) sets, ${objects.length} objects, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // shard by interleaving so heavy objects spread evenly
  const shards: any[][] = Array.from({ length: workers }, () => []);
  objects.forEach((o, i) => {
    const sets = [...byObj.get(o.norad)!.sets.values()].sort((a, b) => a.epochMs - b.epochMs);
    shards[i % workers]!.push({ idx: o.idx, norad: o.norad, identical: o.identical, sets });
  });
  const parts = await Promise.all(shards.map((objs) => new Promise<any>((res, rej) => {
    const w = new Worker(fileURLToPath(new URL('./uncertainty-pairs-worker-boot.mjs', import.meta.url)), { workerData: { objs } });
    w.once('message', res); w.once('error', rej);
  })));
  const total = parts.reduce((s, p) => s + p.n, 0);
  const all = new Float32Array(total * NCOL);
  let off = 0;
  for (const p of parts) { all.set(p.out, off); off += p.out.length; }
  writeFileSync(UDIR + 'pairs.bin', Buffer.from(all.buffer, all.byteOffset, all.byteLength));
  const meta = {
    days, cols: COLS, nPairs: total, rawSets, dedupSets, objects: objects.length,
    pairsInGapRange: parts.reduce((s, p) => s + p.pairsSeen, 0), sgp4FailPairs: parts.reduce((s, p) => s + p.svFail, 0),
    sgp4FailSets: parts.reduce((s, p) => s + p.setFail, 0), identicalObjects: identicalNorads.size, workers, seconds: (Date.now() - t0) / 1000,
    objectsTable: objects.map(({ idx, norad, regime, type, perigee, apogee, bstar, cls, identical, nSets }) => ({ idx, norad, regime, type, perigee, apogee, bstar, cls, identical, nSets })),
  };
  writeFileSync(UDIR + 'pairs-meta.json', JSON.stringify(meta));
  console.log(`pairs ${total} (in gap range ${meta.pairsInGapRange}, sgp4-failed ${meta.sgp4FailPairs}; failed sets ${meta.sgp4FailSets}) in ${meta.seconds.toFixed(1)} s`);
}
main().catch((e) => { console.error(e); process.exit(1); });
