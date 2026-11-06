// ============================================================
// object.breakup: clusters of newly catalogued debris pieces of one launch (src/ssa/history/breakup.ts), derived from the
// object.appeared events and the objects file. Two sources of the appeared events:
//
//   tsx derive-breakups.ts --in <history root>  [--objects FILE] [--from D] [--to D] [--min-pieces 10] [--window-days 60] [--print]
//        reads <root>/events/YYYY/*.jsonl.gz and writes <root>/events/breakups.jsonl.gz (import-events.ts then loads it)
//   DATABASE_URL=... tsx derive-breakups.ts --db --objects FILE [--from D] [--to D] [--min-pieces 10] [--window-days 60] [--print] [--dry-run]
//        one-off over events already imported into ssa_event: replaces the object.breakup rows of the range
//
// build-range.ts --parts breakups does the first form at the end of a (not sharded) build; after a sharded build run it once.
// ============================================================
import { join } from 'node:path';
import pg from 'pg';
import { deriveBreakups } from '../../src/ssa/history/breakup.js';
import { breakupLine, writeBreakups, readAppeared } from '../../src/ssa/history/breakup-files.js';
import { loadAppearedFromDb, replaceBreakups } from '../../src/ssa/history/breakup-db.js';
import { loadObjects } from '../../src/ssa/history/elset-files.js';

const arg = (argv: string[], k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const from = arg(argv, 'from'), to = arg(argv, 'to');
  const opts = { ...(arg(argv, 'min-pieces') ? { minPieces: Number(arg(argv, 'min-pieces')) } : {}), ...(arg(argv, 'window-days') ? { windowDays: Number(arg(argv, 'window-days')) } : {}) };
  const root = arg(argv, 'in');
  const objFile = arg(argv, 'objects') ?? (root ? join(root, 'objects.jsonl.gz') : undefined);
  if (!objFile) throw new Error('usage: derive-breakups.ts (--in <root> | --db --objects FILE) [--from D] [--to D] [--min-pieces N] [--window-days N] [--print] [--dry-run]');
  const objects = loadObjects(objFile);
  const t0 = Date.now();
  let events;
  if (argv.includes('--db')) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      const appeared = await loadAppearedFromDb(pool, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
      events = deriveBreakups(appeared, objects, opts);
      console.log(`${appeared.length} appeared events -> ${events.length} breakups`);
      if (!argv.includes('--dry-run')) {
        const r = await replaceBreakups(pool, events.map(breakupLine), { ...(from ? { from } : {}), ...(to ? { to } : {}) });
        console.log(`ssa_event: ${r.deleted} object.breakup rows replaced by ${r.inserted}`);
      }
    } finally { await pool.end(); }
  } else if (root) {
    events = argv.includes('--dry-run') ? deriveBreakups(readAppeared(root, from, to), objects, opts) : writeBreakups(root, objects, opts, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
    console.log(`${events.length} breakups${argv.includes('--dry-run') ? '' : ` -> ${join(root, 'events', 'breakups.jsonl.gz')}`}`);
  } else throw new Error('give --in <root> or --db');
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (argv.includes('--print')) for (const e of events) console.log(`${e.payload.firstDay}..${e.payload.lastDay}  ${e.payload.launch}  ${String(e.payload.pieces).padStart(5)} pieces  parent ${e.payload.parentNorad ?? '-'} ${e.payload.parentName ?? ''}  [${e.payload.names.join(', ')}]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
