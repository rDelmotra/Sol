// Seed a LOCAL Postgres from replay data: every element set of the given days of data/history/catalog-DAY.json goes to omm_updates, and
// the objects' latest daily row to object_dim / omm_daily (name, size class, category, regime, perigee for the screener's catalog loader).
//   DATABASE_URL=postgres://... npx tsx scripts/ssa/seed-omm-updates.ts 2026-10-11 2026-10-12
// Migrations must be applied first (npm run history:migrate). Never point this at a shared or production database.
import { readFileSync } from 'node:fs';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { closeHistory, getPool } from '../../src/history/db/pool.js';
import { upsertDailyBatch } from '../../src/history/db/queries.js';
import { mapEnriched } from '../../src/history/ingest/map.js';
import { insertOmmUpdates } from '../../src/history/ingest/omm-updates.js';
import type { HistoryDimRow, HistoryFactRow } from '../../src/history/types.js';

const HIST = new URL('../../data/history/', import.meta.url).pathname;
const days = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!days.length) throw new Error('usage: seed-omm-updates.ts DAY [DAY...]');
const pool = getPool();
if (!pool) throw new Error('DATABASE_URL is not set');

let total = 0;
for (const day of days) {
  const objs = JSON.parse(readFileSync(`${HIST}catalog-${day}.json`, 'utf8')) as EnrichedTLEObject[];
  const n = await insertOmmUpdates(pool, objs);
  total += n;
  const dims = new Map<number, HistoryDimRow>(), facts = new Map<string, HistoryFactRow>();
  for (const o of objs) {
    const m = mapEnriched(o);
    if (!m) continue;
    m.fact.source = 'replay';
    dims.set(m.dim.norad_id, m.dim);
    const k = `${m.fact.norad_id}:${m.fact.utc_day}`;
    const ex = facts.get(k);
    if (!ex || m.fact.epoch > ex.epoch) facts.set(k, m.fact);
  }
  await upsertDailyBatch(pool, [...dims.values()], [...facts.values()]);
  console.log(`${day}: ${objs.length} element sets read, ${n} new in omm_updates, ${facts.size} daily rows`);
}
console.log(`omm_updates: +${total}`);
await closeHistory();
