// Parity of the production coverage build (src/ssa/coverage) with the frozen spike (scripts/starmap/coverage.ts): same day catalog in,
// identical (cell, period) -> object sets out, for the three stored layers (day o3, day o4, hour o4), compared as NORAD ids (the object
// index differs between the two builds). Also the unindexed (row-capped) objects. Needs the replay data (data/history catalog + the
// spike's data/coverage files + report.jsonl), not in git; skipped when absent.
//   SSA_COVERAGE_PARITY_DAY    day to compare (default 2026-10-12)
//   SSA_COVERAGE_PARITY_LIMIT  first N objects of the catalog (default 3000; 0 = the whole day, ~3 min on 4 cores)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildDay } from '../../src/ssa/coverage/build.js';
import { readLayer, listIds, type Layer } from '../../src/ssa/coverage/codec.js';
import { LAYERS, layerName } from '../../src/ssa/coverage/consts.js';

const DAY = process.env.SSA_COVERAGE_PARITY_DAY ?? '2026-10-12';
const LIMIT = Number(process.env.SSA_COVERAGE_PARITY_LIMIT ?? 3000);
const HIST = new URL('../../data/history/', import.meta.url).pathname;
const COV = new URL('../../data/coverage/', import.meta.url).pathname;
const need = [`${HIST}catalog-${DAY}.json`, `${COV}${DAY}.day.bin`, `${COV}${DAY}.hour.bin`, `${COV}report.jsonl`];
const missing = need.filter((f) => !existsSync(f));

interface Cell { key: number; ids: number[] }
/** Cell lists as (key, sorted NORAD ids), ascending by key, restricted to the NORAD ids in `keep`. */
function* mine(l: Layer, norad: number[], keep: Set<number>): Generator<Cell> {
  for (let i = 0; i < l.cells.length; i++) {
    const ids: number[] = [];
    listIds(l, i, (o) => { const n = norad[o]!; if (keep.has(n)) ids.push(n); });
    if (ids.length) yield { key: l.cells[i]!, ids: ids.sort((a, b) => a - b) };
  }
}

test(`coverage build parity with the spike: ${DAY}${LIMIT ? `, first ${LIMIT} objects` : ', whole day'}`, { skip: missing.length ? `replay data not present (${missing[0]})` : false, timeout: 3_600_000 }, async () => {
  const { readCoverage, forEachId } = await import('../../scripts/starmap/coverage-codec.js');
  const { loadCatalog } = await import('../../scripts/starmap/catalog.js');
  const full = loadCatalog(`${HIST}catalog-${DAY}.json`);
  const cat = LIMIT ? full.slice(0, LIMIT) : full;
  const keep = new Set(cat.map((o) => o.noradId));
  const t0 = Date.now();
  const built = await buildDay(DAY, Date.parse(DAY + 'T00:00:00Z'), full.map((o) => ({ noradId: o.noradId, omm: o.omm })), { workers: 4, ...(LIMIT ? { limit: LIMIT } : {}) });
  const wall = (Date.now() - t0) / 1000;

  const spike = { day: readCoverage(new Uint8Array(readFileSync(`${COV}${DAY}.day.bin`))), hour: readCoverage(new Uint8Array(readFileSync(`${COV}${DAY}.hour.bin`))) };
  const rows: string[] = [];
  for (const L of LAYERS) {
    const sp = spike[L.gran];
    const cfg = sp.configs.find((c) => c.order === L.order)!;
    const spNorad = Array.from(sp.norad);
    const m = mine(readLayer(built.files.get(`${layerName(L)}.bin`)!), built.manifest.norad, keep);
    let lists = 0, pairs = 0, bad = 0;
    let first: string | null = null;
    let nextMine = m.next();
    for (let i = 0; i < cfg.cells.length; i++) {
      const ids: number[] = [];
      forEachId(sp.buf, cfg.offs[i]!, cfg.lens[i]!, cfg.tags[i]!, (o) => { const n = spNorad[o]!; if (keep.has(n)) ids.push(n); });
      if (!ids.length) continue;
      ids.sort((a, b) => a - b);
      lists++; pairs += ids.length;
      const mc = nextMine.value as Cell | undefined;
      if (nextMine.done || mc!.key !== cfg.cells[i] || mc!.ids.length !== ids.length || mc!.ids.some((v, k) => v !== ids[k])) { bad++; first ??= `spike key ${cfg.cells[i]} [${ids.slice(0, 5)}] vs port ${nextMine.done ? 'end' : `${mc!.key} [${mc!.ids.slice(0, 5)}]`}`; if (!nextMine.done && mc!.key <= cfg.cells[i]!) nextMine = m.next(); continue; }
      nextMine = m.next();
    }
    const extra = nextMine.done ? 0 : 1 + [...m].length;
    rows.push(`${layerName(L)}: ${lists} lists / ${pairs} pairs compared, ${bad} differing, ${extra} extra lists in the port`);
    assert.equal(bad, 0, `${layerName(L)}: ${bad} lists differ; first: ${first}`);
    assert.equal(extra, 0, `${layerName(L)}: the port has ${extra} lists the spike does not`);
  }
  // unindexed (row-capped) objects
  const rep = readFileSync(`${COV}report.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { day: string; dropped: string[]; skipped: Record<string, number> }).filter((r) => r.day === DAY).pop()!;
  const spikeDropped = rep.dropped.map((s) => Number(s.split('(')[0])).filter((n) => keep.has(n)).sort((a, b) => a - b);
  assert.deepEqual(built.manifest.unindexed, spikeDropped);
  if (!LIMIT) {
    for (const k of Object.keys(rep.skipped)) assert.equal(built.manifest.skipped[k] ?? 0, rep.skipped[k], `skipped ${k}`);
  }
  console.log(`coverage parity ${DAY} (${cat.length} objects, build ${wall.toFixed(1)} s, peak RSS ${built.manifest.build.peakRssMB} MB):\n  ${rows.join('\n  ')}\n  unindexed ${JSON.stringify(spikeDropped)}; skipped port ${JSON.stringify(built.manifest.skipped)} spike ${JSON.stringify(rep.skipped)}`);
});
