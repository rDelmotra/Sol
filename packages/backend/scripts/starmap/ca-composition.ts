// SPIKE — not production. What dominates close.approach rows? (names, launch, relative speed, repeats, regimes)
import pg from 'pg';
import { DB_URL, loadDayCatalog } from './events.js';

const day = process.argv[2] ?? '2026-09-30';
const client = new pg.Client({ connectionString: DB_URL });
await client.connect();
const rows = (await client.query(`SELECT subjects, extract(epoch from t_start)*1000 AS t, payload FROM starmap.event WHERE kind='close.approach' AND day=$1`, [day])).rows as Array<{ subjects: number[]; t: number; payload: { d: number; v: number } }>;
const cat = new Map(loadDayCatalog(day).map((o) => [o.noradId, o]));
const fam = (n: string) => (/STARLINK/.test(n) ? 'STARLINK' : /ONEWEB/.test(n) ? 'ONEWEB' : /FENGYUN 1C DEB|COSMOS 2251 DEB|IRIDIUM 33 DEB|COSMOS 1408 DEB/.test(n) ? 'FRAG-DEB(old)' : /DEB/.test(n) ? 'OTHER DEB' : /R\/B/.test(n) ? 'R/B' : /^(FLOCK|LEMUR|SPIRE|PLEIADES|SKYSAT|GLOBALSTAR|IRIDIUM|ORBCOMM|KUIPER|QIANFAN|GUOWANG|CZ-|YAOGAN|COSMOS)/.test(n) ? 'OTHER-CONSTELLATION/NAMED' : 'OTHER');
const cnt = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const cats = new Map<string, number>(), launch = new Map<string, number>(), speed = new Map<string, number>(), dbin = new Map<string, number>(), reg = new Map<string, number>();
const pairCount = new Map<string, number>(), objCount = new Map<number, number>();
let sameLaunch = 0;
for (const r of rows) {
  const [a, b] = r.subjects.map((id) => cat.get(id)!);
  const ka = [fam(a!.name), fam(b!.name)].sort().join(' x ');
  cnt(cats, ka);
  const la = String(a!.omm.OBJECT_ID).slice(0, 8), lb = String(b!.omm.OBJECT_ID).slice(0, 8);
  const same = la === lb;
  if (same) sameLaunch++;
  cnt(launch, same ? 'same launch (COSPAR launch id)' : 'different launch');
  cnt(speed, r.payload.v < 0.5 ? 'v<0.5 km/s (co-moving)' : r.payload.v < 2 ? '0.5-2' : r.payload.v < 8 ? '2-8' : r.payload.v < 12 ? '8-12' : '>=12 (near head-on)');
  cnt(dbin, r.payload.d < 1 ? '<1 km' : r.payload.d < 2 ? '1-2' : r.payload.d < 3 ? '2-3' : r.payload.d < 4 ? '3-4' : '4-5');
  cnt(reg, [a!.regime, b!.regime].sort().join('+'));
  const pk = r.subjects.join('-');
  pairCount.set(pk, (pairCount.get(pk) ?? 0) + 1);
  for (const id of r.subjects) objCount.set(id, (objCount.get(id) ?? 0) + 1);
}
const show = (t: string, m: Map<string, number>, n = 12) => console.log(`\n${t}\n` + [...m].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `  ${(100 * v / rows.length).toFixed(1).padStart(5)}%  ${String(v).padStart(6)}  ${k}`).join('\n'));
console.log(`day ${day}: ${rows.length} close.approach rows (<5 km), ${pairCount.size} distinct pairs, ${objCount.size} distinct objects`);
show('family pair', cats); show('launch', launch); show('relative speed', speed); show('miss distance', dbin); show('regime pair', reg);
const rep = [...pairCount.values()];
console.log(`\npairs with >1 approach this day: ${rep.filter((x) => x > 1).length}; events in those pairs ${rep.filter((x) => x > 1).reduce((s, x) => s + x, 0)}; max per pair ${Math.max(...rep)}`);
const top = [...objCount].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `${id} ${cat.get(id)!.name} x${n}`);
console.log('objects in most approaches:', top.join(' | '));
// uniform-density sanity: expected random number of <5 km conjunctions per day for the LEO shell
console.log('speed>=2 and different launch (what is left that looks like genuine crossings):', rows.filter((r) => r.payload.v >= 2 && String(cat.get(r.subjects[0]!)!.omm.OBJECT_ID).slice(0, 8) !== String(cat.get(r.subjects[1]!)!.omm.OBJECT_ID).slice(0, 8)).length);
await client.end();
