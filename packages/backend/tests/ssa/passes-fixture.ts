// A small synthetic world for the pass-query tests: element sets in a throwaway Postgres schema, the coverage files built from them in a
// temp directory, and a brute-force reference that does not use the star-map lists at all.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createTestDb } from './db-helper.js';
import { synthCatalog } from './coverage-helpers.js';
import { runCoverageDay } from '../../src/ssa/coverage/run.js';
import { loadOmmCatalog } from '../../src/ssa/coverage/catalog.js';
import { regionFlags, passesIn } from '../../src/ssa/coverage/scan.js';
import { makeProp, newStats } from '../../src/ssa/coverage/runs.js';
import type { Region } from '../../src/ssa/coverage/region.js';

export const DAY_MS = 86_400_000;
export const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');

export interface Fixture { pool: Pool; dir: string; days: string[]; cleanup: () => Promise<void> }

/** n synthetic objects per day, one element set per object per day (epoch 01:00 of the day), coverage built for `built` of the days. */
export async function makeFixture(days: string[], built: string[], n = 60): Promise<Fixture> {
  const db = await createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'passes-'));
  for (const d of days) {
    for (const o of synthCatalog(n, `${d}T01:00:00.000Z`)) {
      await db.pool.query('INSERT INTO omm_updates (norad_id, epoch, omm) VALUES ($1, $2, $3)', [o.noradId, `${d}T01:00:00Z`, JSON.stringify(o.omm)]);
    }
  }
  for (const d of built) {
    const r = await runCoverageDay(db.pool, d, { dir, workers: 2, minObjects: 10 });
    if (r.status !== 'done') throw new Error(`fixture: coverage ${d}: ${JSON.stringify(r)}`);
  }
  return { pool: db.pool, dir, days, cleanup: async () => { rmSync(dir, { recursive: true, force: true }); await db.drop(); } };
}

export interface Truth {
  /** objects with at least one 10 s sample inside, per the brute-force sweep */
  sampled: Set<number>;
  /** objects with at least one pass per the exact refine over the WHOLE day (no candidates) */
  refined: Set<number>;
  /** per object the exact pass pieces (flat, per day) */
  passes: Map<number, number[]>;
}

/** Reference answer for the days, ignoring the coverage files: every object, every 10 s sample; and the exact scan over whole days. */
export async function truthFor(pool: Pool, region: Region, days: string[], fromMs: number, toMs: number): Promise<Truth> {
  const sampled = new Set<number>(), refined = new Set<number>(), passes = new Map<number, number[]>();
  for (const d of days) {
    const a = Math.max(fromMs, dayMs(d)), b = Math.min(toMs, dayMs(d) + DAY_MS);
    for (const o of await loadOmmCatalog(pool, d)) {
      const p = makeProp(o.omm);
      if (!p) continue;
      const st = newStats();
      const flags = regionFlags(region, st);
      for (let t = a; t < b; t += 10_000) if (flags(p, t).inside) { sampled.add(o.noradId); break; }
      const iv = passesIn(p, region, [a, b], st);
      if (iv.length) { refined.add(o.noradId); const arr = passes.get(o.noradId) ?? []; arr.push(...iv); passes.set(o.noradId, arr); }
    }
  }
  return { sampled, refined, passes };
}
