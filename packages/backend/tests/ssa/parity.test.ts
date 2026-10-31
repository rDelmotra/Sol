// Parity of the production screener (src/ssa) with the frozen S6 spike (scripts/starmap): same catalog, same window, same encounters.
// Needs the replay data (packages/backend/data/history + data/uncertainty), which is not in git; skipped when it is absent.
//   SSA_PARITY_DAY    day to replay (default 2026-10-12; batch time = 12:00 UTC)
//   SSA_PARITY_HOURS  window length (default 3). 36 = the full batch: compared with the saved data/forward/batch-DAY-s6.jsonl.gz
//                     when that file exists (no spike rerun), otherwise with a spike run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { screenEncounters } from '../../src/ssa/screen.js';
import type { Encounter } from '../../src/ssa/types.js';

const DAY = process.env.SSA_PARITY_DAY ?? '2026-10-12';
const HOURS = Number(process.env.SSA_PARITY_HOURS ?? 3);
const HIST = new URL('../../data/history/', import.meta.url).pathname;
const MODEL = new URL('../../data/uncertainty/model.json', import.meta.url).pathname;
const prevDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);

interface Ref { a: number; b: number; tca: number; miss: number; vrel: number; ric: number[]; hbr: number; pcBal: number; pcMax: number; cat: string; manA: boolean; manB: boolean }

const rel = (x: number, y: number) => (x === y ? 0 : Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y)));

test(`parity with the S6 spike: ${DAY}, ${HOURS} h`, { timeout: 3_600_000 }, async (t) => {
  if (!existsSync(`${HIST}catalog-${DAY}.json`) || !existsSync(`${HIST}catalog-${prevDay(DAY)}.json`) || !existsSync(MODEL)) {
    t.skip('replay data (data/history catalogs, data/uncertainty/model.json) not present');
    return;
  }
  const { causalCatalog, batchTimeMs } = await import('../../scripts/starmap/forward-lib.js');
  const { readLines } = await import('../../scripts/starmap/forward-common.js');
  const t0 = batchTimeMs(DAY), t1 = t0 + HOURS * 3_600_000;

  // reference: the spike's own events
  const saved = `${new URL('../../data/forward/', import.meta.url).pathname}batch-${DAY}-s6.jsonl.gz`;
  let ref: Ref[];
  const tag = 'ssaparity';
  let cleanup = (): void => undefined;
  if (HOURS === 36 && existsSync(saved)) {
    ref = readLines(saved).map((l) => JSON.parse(l) as Ref);
  } else {
    const { runS6, S6_DEFAULTS } = await import('../../scripts/starmap/screen-s6.js');
    const { batchFile } = await import('../../scripts/starmap/forward-common.js');
    await runS6({ ...S6_DEFAULTS, day: DAY, hours: HOURS, tag });
    ref = readLines(batchFile(DAY, tag)).map((l) => JSON.parse(l) as Ref);
    cleanup = () => { rmSync(batchFile(DAY, tag), { force: true }); rmSync(batchFile(DAY, tag, 'meta.json'), { force: true }); };
  }
  try {
    // the same objects the spike screens, fed to the port
    const cc = causalCatalog(DAY);
    const T = Date.now();
    const { encounters, stats } = await screenEncounters(cc.objs, t0, { hours: HOURS, modelPath: MODEL });
    const wall = (Date.now() - T) / 1000;
    console.log(`parity ${DAY} ${HOURS} h: port ${encounters.length} encounters / ${stats.objectsScreened} objects in ${wall.toFixed(1)} s (peak RSS ${stats.maxRssMB} MB); spike ${ref.length}`);

    const key = (a: number, b: number, tca: number) => `${a}:${b}:${Math.round(tca / 60_000)}`;
    // pair + TCA within 1 ms: index by pair, then nearest
    const byPair = new Map<string, Ref[]>();
    for (const r of ref) { const k = `${r.a}:${r.b}`; (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(r); }
    void key;
    assert.equal(encounters.length, ref.length, 'encounter counts differ');
    let maxDt = 0, maxMiss = 0, maxPc = 0, maxPcMax = 0, maxVrel = 0, maxRic = 0;
    const used = new Set<Ref>();
    const bad: string[] = [];
    for (const e of encounters) {
      const c = (byPair.get(`${e.noradA}:${e.noradB}`) ?? []).filter((r) => !used.has(r)).sort((x, y) => Math.abs(x.tca - e.tcaMs) - Math.abs(y.tca - e.tcaMs))[0];
      if (!c || Math.abs(c.tca - e.tcaMs) > 1) { bad.push(`${e.noradA}-${e.noradB} @${new Date(e.tcaMs).toISOString()}`); continue; }
      used.add(c);
      maxDt = Math.max(maxDt, Math.abs(c.tca - e.tcaMs));
      maxMiss = Math.max(maxMiss, Math.abs(c.miss - e.missKm));
      maxVrel = Math.max(maxVrel, Math.abs(c.vrel - e.vrelKms));
      maxRic = Math.max(maxRic, ...c.ric.map((x, i) => Math.abs(x - e.ricKm[i]!)));
      maxPc = Math.max(maxPc, rel(c.pcBal, e.pc));
      maxPcMax = Math.max(maxPcMax, rel(c.pcMax, e.pcMax));
      assert.equal(c.cat, e.label);
      assert.equal(c.manA || c.manB, e.manoeuvrable);
      assert.equal(c.hbr, e.hbrKm);
    }
    console.log(`parity max |dTCA| ${maxDt} ms, |dmiss| ${maxMiss.toExponential(2)} km, |dvrel| ${maxVrel.toExponential(2)}, |dRIC| ${maxRic.toExponential(2)}, Pc rel ${maxPc.toExponential(2)}, PcMax rel ${maxPcMax.toExponential(2)}`);
    assert.equal(bad.length, 0, `unmatched encounters: ${bad.slice(0, 5).join(', ')} (${bad.length})`);
    assert.ok(maxMiss < 1e-6, `miss differs by ${maxMiss}`);
    assert.ok(maxPc < 1e-9, `Pc differs by ${maxPc}`);
    assert.ok(maxPcMax < 1e-9, `PcMax differs by ${maxPcMax}`);
    assert.ok(t1 > t0);
  } finally {
    cleanup();
  }
});
