// SPIKE — not production. Break down one day's FULL (< 5 km) close-approach set by category, miss distance and speed.
//   npx tsx packages/backend/scripts/starmap/ca-categorize.ts <day> <dump.json>   (dump from derive-day.ts --dump)
import { readFileSync } from 'node:fs';
import { loadDayCatalog, type CatFull } from './events.js';
import { classifyCa, CA_CATS, type ElsetLite } from './events-ca.js';

const day = process.argv[2]!, dump = process.argv[3]!;
const rows = (JSON.parse(readFileSync(dump, 'utf8')) as Array<{ kind: string; subjects: number[]; tStart: number; payload: { d: number; v: number } }>).filter((r) => r.kind === 'close.approach');
const cat = new Map(loadDayCatalog(day).map((o) => [o.noradId, o]));
const lite = (o: CatFull): ElsetLite => ({ name: o.name, objectId: String(o.omm.OBJECT_ID), meanMotion: Number(o.omm.MEAN_MOTION), incDeg: Number(o.omm.INCLINATION), raanDeg: Number(o.omm.RA_OF_ASC_NODE), objectType: (o as unknown as { objectType: string }).objectType });
const thr = [5, 2, 1, 0.5, 0.25];
const tab = new Map<string, number[]>();
const bump = (k: string, d: number) => { const a = tab.get(k) ?? tab.set(k, new Array(thr.length).fill(0)).get(k)!; thr.forEach((t, i) => { if (d < t) a[i]!++; }); };
let payloadPair = 0, payloadPair1 = 0;
for (const r of rows) {
  const a = cat.get(r.subjects[0]!)!, b = cat.get(r.subjects[1]!)!;
  const f = classifyCa(lite(a), lite(b), r.payload.d, r.payload.v);
  bump(f.cat, r.payload.d); bump('ALL', r.payload.d);
  const pa = (a as unknown as { objectType: string }).objectType === 'payload', pb = (b as unknown as { objectType: string }).objectType === 'payload';
  if (pa && pb) { bump('both payloads', r.payload.d); if (f.cat === 'crossing' || f.cat === 'same_family') bump('both payloads, not same launch/twin/co-moving', r.payload.d); }
  else if (pa || pb) bump('one payload', r.payload.d); else bump('no payload (debris/rocket body only)', r.payload.d);
  void payloadPair; void payloadPair1;
}
console.log(`day ${day}: ${rows.length} rows. counts of events with miss < threshold km`);
console.log(['category', ...thr.map((t) => `<${t}`)].join('\t'));
for (const k of [...CA_CATS, 'ALL', 'both payloads', 'both payloads, not same launch/twin/co-moving', 'one payload', 'no payload (debris/rocket body only)']) console.log([k, ...(tab.get(k) ?? []).map(String)].join('\t'));
const types = new Map<string, number>();
for (const r of rows) { const a = (cat.get(r.subjects[0]!) as unknown as { objectType: string }).objectType; types.set(a, (types.get(a) ?? 0) + 1); }
console.log('objectType of first subject:', JSON.stringify([...types]));
