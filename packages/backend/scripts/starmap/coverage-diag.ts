// SPIKE diagnostic: which truth-positive object-days did the union refine miss, and why (not production).
import { readFileSync } from 'node:fs';
import { loadCatalog } from './catalog.js';
import { dailyDays, COVERAGE_DIR } from './coverage-lib.js';
const Q = COVERAGE_DIR + 'q/';
const rep = new Map<string, { dropped: string[]; skipped: Record<string, number> }>();
for (const l of readFileSync(COVERAGE_DIR + 'report.jsonl', 'utf8').trim().split('\n')) { const r = JSON.parse(l); rep.set(r.day, r); }
const u16 = (p: string) => { const b = readFileSync(p); return new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
for (const q of ['india', 'box']) for (const d of dailyDays()) {
  const cat = loadCatalog(d.path);
  const t = u16(`${Q}truth-${d.day}-9138.${q}`);
  const pos = new Set((JSON.parse(readFileSync(`${Q}refine-${q}-${d.day}.json`, 'utf8')) as Array<[number]>).map((r) => r[0]));
  const drop = new Set((rep.get(d.day)!.dropped).map((s) => s.split('(')[0]));
  for (let i = 0; i < t.length; i++) if (t[i] && !pos.has(i)) console.log(q, d.day, cat[i]!.noradId, cat[i]!.name, cat[i]!.regime, 'truthPasses', t[i], drop.has(String(cat[i]!.noradId)) ? 'OVER-ROW-CAP' : 'other');
}
