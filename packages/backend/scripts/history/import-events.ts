// ============================================================
// Import event files written by build-range.ts into the database (the app side, later):
//
//   DATABASE_URL=... tsx import-events.ts --in <build-range out dir> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--coverage <dir>] [--dry-run]
//
// events/breakups.jsonl.gz (object.breakup, derive-breakups.ts / build-range --parts breakups) is imported last: the object.breakup rows of
// the --from/--to range are replaced by the file's rows of that range (one transaction), so a re-import never duplicates them.
//
// Per day, ONE transaction (writeDayEvents): delete the day's rows of the kinds in the file's marker, insert the file's rows, record the
// 'changes' completion in ssa_day_status. A day whose marker says the formation pass failed is written without close.formation and is
// NOT marked done (the nightly catch-up loop will derive it). Re-running replaces the days: it is idempotent.
// With --coverage <dir> (the coverage directory on the volume, e.g. $SSA_COVERAGE_DIR) the days that have a manifest there are also marked
// 'coverage' done, so the catch-up loop does not rebuild them. The migrations must be applied first (the app does it on boot).
// ============================================================
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { writeDayEvents } from '../../src/ssa/events/writer.js';
import { markDone } from '../../src/ssa/day-status.js';
import { CHANGE_KINDS, type ChangeKind } from '../../src/ssa/events/types.js';
import { eventRow, type EventLine } from '../../src/ssa/history/derive-files.js';
import { hasDay } from '../../src/ssa/coverage/store.js';
import { readBreakupLines } from '../../src/ssa/history/breakup-files.js';
import { replaceBreakups } from '../../src/ssa/history/breakup-db.js';

export interface ImportOpts { from?: string; to?: string; coverageDir?: string; dryRun?: boolean; log?: (m: string) => void }
export interface ImportResult { days: number; rows: number; markedChanges: number; markedCoverage: number; skippedNoMarker: number; /** object.breakup rows written (events/breakups.jsonl.gz) */ breakups: number }

/** Days (ascending) that have an events file in `dir/events/YYYY/`. */
export function eventDays(dir: string, from?: string, to?: string): string[] {
  const root = join(dir, 'events');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const y of readdirSync(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const f of readdirSync(join(root, y))) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(f);
      if (m && (!from || m[1]! >= from) && (!to || m[1]! <= to)) out.push(m[1]!);
    }
  }
  return out.sort();
}

export async function importEvents(pool: pg.Pool, dir: string, o: ImportOpts = {}): Promise<ImportResult> {
  const log = o.log ?? (() => undefined);
  const res: ImportResult = { days: 0, rows: 0, markedChanges: 0, markedCoverage: 0, skippedNoMarker: 0, breakups: 0 };
  for (const day of eventDays(dir, o.from, o.to)) {
    const markerFile = join(dir, 'done', 'changes', day.slice(0, 4), `${day}.json`);
    if (!existsSync(markerFile)) { res.skippedNoMarker++; log(`${day}: events file without a done marker (a build still running?); skipped`); continue; }
    const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as { kinds?: ChangeKind[]; formationError?: string; prevObjects?: number; curObjects?: number };
    const kinds = (marker.kinds ?? [...CHANGE_KINDS]).filter((k) => CHANGE_KINDS.includes(k));
    const text = gunzipSync(readFileSync(join(dir, 'events', day.slice(0, 4), `${day}.jsonl.gz`))).toString('utf8');
    const rows = text.split('\n').filter(Boolean).map((l) => eventRow(JSON.parse(l) as EventLine));
    res.days++; res.rows += rows.length;
    if (o.dryRun) continue;
    const complete = !marker.formationError && kinds.length === CHANGE_KINDS.length;
    await writeDayEvents(pool, day, kinds, rows, complete ? { stats: { source: 'history-backfill', prevObjects: marker.prevObjects, curObjects: marker.curObjects, perKind: Object.fromEntries(kinds.map((k) => [k, rows.filter((r) => r.kind === k).length])) } } : undefined);
    if (complete) res.markedChanges++;
    if (o.coverageDir && hasDay(o.coverageDir, day)) { await markDone(pool, day, 'coverage', { source: 'history-backfill' }); res.markedCoverage++; }
    if (res.days % 200 === 0) log(`${day}: ${res.days} days, ${res.rows} rows`);
  }
  const range = { ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}) };
  const breakups = readBreakupLines(dir).filter((l) => (!o.from || l.day >= o.from) && (!o.to || l.day <= o.to));
  if (existsSync(join(dir, 'events', 'breakups.jsonl.gz'))) {
    if (!o.dryRun) await replaceBreakups(pool, breakups, range);
    res.breakups = breakups.length;
  }
  return res;
}

function arg(argv: string[], k: string): string | undefined { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = arg(argv, 'in');
  if (!dir) throw new Error('usage: import-events.ts --in <dir> [--from D] [--to D] [--coverage <dir>] [--dry-run]');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const t0 = Date.now();
    const r = await importEvents(pool, dir, {
      ...(arg(argv, 'from') ? { from: arg(argv, 'from')! } : {}), ...(arg(argv, 'to') ? { to: arg(argv, 'to')! } : {}),
      ...(arg(argv, 'coverage') ? { coverageDir: arg(argv, 'coverage')! } : {}), ...(argv.includes('--dry-run') ? { dryRun: true } : {}), log: (m) => console.log(m),
    });
    const s = (Date.now() - t0) / 1000;
    console.log(`imported ${r.days} days, ${r.rows} rows + ${r.breakups} object.breakup rows in ${s.toFixed(1)} s (${(r.rows / Math.max(s, 1e-9)).toFixed(0)} rows/s); ${r.markedChanges} days marked changes-done, ${r.markedCoverage} coverage-done, ${r.skippedNoMarker} skipped (no marker)${argv.includes('--dry-run') ? ' [dry run]' : ''}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('import-events.ts')) main().catch((e) => { console.error(e); process.exit(1); });
