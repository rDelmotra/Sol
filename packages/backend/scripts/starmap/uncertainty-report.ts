// ============================================================
// SPIKE — not production. U5 step 3: print the markdown tables for STARMAP.md from the fit outputs.
// Usage: npx tsx packages/backend/scripts/starmap/uncertainty-report.ts
// ============================================================
import { readFileSync } from 'node:fs';
import { UDIR, GAP_BINS } from './uncertainty-lib.js';
import { sigmaRIC, loadModel, MODEL_PATH } from './uncertainty-model.js';

const rd = (f: string) => JSON.parse(readFileSync(UDIR + f, 'utf8'));
const meta = rd('pairs-meta.json');
const hold = rd('fit-report.json');
const all = rd('fit-report-all.json');
const model = loadModel(MODEL_PATH);
const holdModel = rd('model-holdout.json');
const f1 = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
const pc = (x: number) => (100 * x).toFixed(1);

console.log('### fences / counts');
console.log(JSON.stringify({ days: meta.days.length, rawRows: meta.rawSets, uniqueSets: meta.dedupSets, objects: meta.objects, pairsInGapRange: meta.pairsInGapRange, sgp4FailPairs: meta.sgp4FailPairs, sgp4FailSets: meta.sgp4FailSets, identicalObjects: meta.identicalObjects, fences: all.fenceCount, kept: all.nKept, train: hold.nTrain, test: hold.nTest, holdoutDays: hold.holdout.days }, null, 1));

console.log('\n### kept pairs by regime and gap bin (all days)');
const T = model.tables as Record<string, { n: number; bins: any[] }>;
console.log('| group | pairs | ' + GAP_BINS.map((b) => `${b[0]}-${Math.floor(b[1])} d`).join(' | ') + ' |');
console.log('|---|---|' + GAP_BINS.map(() => '---').join('|') + '|');
for (const k of ['ALL', 'LEO', 'MEO', 'GEO', 'HEO', 'OTHER']) { const t = T[k]; if (t) console.log(`| ${k} | ${t.n} | ` + t.bins.map((b) => b.n).join(' | ') + ' |'); }

console.log('\n### robust sigma (km, 1.4826 x median |offset|) by regime and gap bin: R / I / C   (all days, class-level, before object scale)');
console.log('| regime | ' + GAP_BINS.map((b) => `${b[0]}-${Math.floor(b[1])} d`).join(' | ') + ' |');
console.log('|---|' + GAP_BINS.map(() => '---').join('|') + '|');
for (const k of ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']) { const t = T[k]; if (t) console.log(`| ${k} | ` + t.bins.map((b) => (b.n < 30 ? 'n/a' : b.sigma.map(f1).join(' / '))).join(' | ') + ' |'); }

console.log('\n### 3D position offset p50 / p90 / p99 (km) by regime and gap bin');
console.log('| regime | ' + GAP_BINS.map((b) => `${b[0]}-${Math.floor(b[1])} d`).join(' | ') + ' |');
console.log('|---|' + GAP_BINS.map(() => '---').join('|') + '|');
for (const k of ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']) { const t = T[k]; if (t) console.log(`| ${k} | ` + t.bins.map((b) => (b.n < 30 ? 'n/a' : b.pos3d.map(f1).join(' / '))).join(' | ') + ' |'); }

console.log('\n### velocity sigma (m/s), robust, R / I / C');
console.log('| regime | ' + GAP_BINS.map((b) => `${b[0]}-${Math.floor(b[1])} d`).join(' | ') + ' |');
console.log('|---|' + GAP_BINS.map(() => '---').join('|') + '|');
for (const k of ['LEO', 'MEO', 'GEO', 'HEO']) { const t = T[k]; if (t) console.log(`| ${k} | ` + t.bins.map((b) => (b.n < 30 ? 'n/a' : b.vsigma.map((v: number) => f1(v * 1000)).join(' / '))).join(' | ') + ' |'); }

console.log('\n### growth laws sigma(t)=a+b t+c t^2 (km, t in days), class level (fitted on all days)');
console.log('| class | pairs | R: a, b, c | I: a, b, c | C: a, b, c |');
console.log('|---|---|---|---|---|');
const cls = model.classes as Record<string, any>;
const keys = Object.keys(cls).sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b));
const g3 = (l: any) => `${l.a.toPrecision(3)}, ${l.b.toPrecision(3)}, ${l.c.toPrecision(3)}`;
for (const k of keys) if (k.split('/').length <= 3 || ['ALL'].includes(k)) console.log(`| ${k} | ${cls[k].n} | ${g3(cls[k].growth.R)} | ${g3(cls[k].growth.I)} | ${g3(cls[k].growth.C)} |`);
console.log(`(${keys.length} class entries in model.json, ${keys.filter((k) => k.split('/').length === 4).length} of them LEO drag-band classes)`);

console.log('\n### drag-band classes (LEO, in-track sigma at 1 d and 3 d, km)');
console.log('| class | pairs | I at 1 d | I at 3 d | R at 3 d | C at 3 d |');
console.log('|---|---|---|---|---|---|');
for (const k of keys.filter((k) => k.split('/').length === 4 && k.startsWith('LEO/unknown'))) { const a = sigmaRIC(k, 1, { ...model, tail: {}, objectScale: {} } as any), b = sigmaRIC(k, 3, { ...model, tail: {}, objectScale: {} } as any); console.log(`| ${k} | ${cls[k].n} | ${f1(a[1])} | ${f1(b[1])} | ${f1(b[0])} | ${f1(b[2])} |`); }

console.log('\n### tail factors (warm, by gap bin centre) and cold factor');
console.log('centres', model.tailCentresDays!.map((x) => x.toFixed(2)).join(' '));
for (const [k, v] of Object.entries(model.tail)) console.log(k, (v as number[]).map((x) => x.toFixed(2)).join(' '), ' cold', (model.tailCold as any)[k]?.toFixed(2), ' conservative x', (model.conservative as any)[k]?.toFixed(2));

console.log('\n### per-object scale distribution (all-days model; p5 / p25 / p50 / p75 / p95)');
console.log(`objects with scale ${all.objectsWithScale} of ${all.objectsEligible} eligible`);
console.log('| regime | objects | R | I | C |');
console.log('|---|---|---|---|---|');
for (const [k, v] of Object.entries(all.scaleStats as Record<string, any>)) console.log(`| ${k} | ${v.n} | ${v.R.map((x: number) => x.toFixed(2)).join(' / ')} | ${v.I.map((x: number) => x.toFixed(2)).join(' / ')} | ${v.C.map((x: number) => x.toFixed(2)).join(' / ')} |`);

console.log('\n### calibration on held-out days ' + hold.holdout.days.join(','));
console.log(`expected inside 1/2/3 sigma: ${hold.expected.map((x: number) => pc(x)).join(' / ')}`);
const st = hold.stages;
const rowOf = (c: any) => `${c.n} | ${pc(c.in1)} | ${pc(c.in2)} | ${pc(c.in3)} | ${c.d99.toFixed(1)}`;
for (const [title, key] of [['BEFORE: class-level model, no object scale, no tail factor (all held-out pairs)', 'before'], ['AFTER: shipped model (object scale + tail factors; cold start for objects without scale) all held-out pairs', 'after'], ['AFTER, objects with own scale only', 'afterWarm'], ['AFTER, cold-start objects (no scale)', 'afterCold'], ['cold-start objects BEFORE (class level, no tail)', 'coldBefore'], ['object scale only (no tail factor), objects with scale', 'objectScaleOnly'], ['CONSERVATIVE variant, objects with scale', 'afterConservativeWarm']] as const) {
  console.log(`\n**${title}**\n\n| regime | pairs | in 1 sigma % | in 2 sigma % | in 3 sigma % | p99 of Mahalanobis |\n|---|---|---|---|---|---|`);
  for (const [k, v] of Object.entries(st[key] as Record<string, any>)) console.log(`| ${k} | ${rowOf(v)} |`);
}
console.log('\n**by gap bin, before / after**\n\n| gap | pairs | before 1/2/3 sigma % | after 1/2/3 sigma % |\n|---|---|---|---|');
for (const k of Object.keys(st.afterByGap)) { const b = st.beforeByGap[k], a = st.afterByGap[k]; console.log(`| ${k} d | ${a.n} | ${pc(b.in1)} / ${pc(b.in2)} / ${pc(b.in3)} | ${pc(a.in1)} / ${pc(a.in2)} / ${pc(a.in3)} |`); }
console.log('\n**after, by LEO class (classes with >= 2000 held-out pairs; worst 6 by 3-sigma share)**\n\n| class | pairs | 1/2/3 sigma % |\n|---|---|---|');
const bc = Object.entries(st.afterByClass as Record<string, any>).sort((a, b) => a[1].in3 - b[1].in3);
for (const [k, v] of bc.slice(0, 6)) console.log(`| ${k} | ${v.n} | ${pc(v.in1)} / ${pc(v.in2)} / ${pc(v.in3)} |`);
console.log(`(best: ${bc.slice(-1).map(([k, v]) => `${k} ${pc(v.in1)} / ${pc(v.in2)} / ${pc(v.in3)}`)}; ${bc.length} classes)`);

console.log('\n### 1-sigma error region the shipped model gives (class-level typical object, km): R / I / C and 3D 1-sigma radius');
console.log('| regime (class used) | 1 h | 1 d | 3 d | 7 d |');
console.log('|---|---|---|---|---|');
const rep: Array<[string, string]> = [['LEO (regime level)', 'LEO'], ['LEO Starlink-like', 'LEO/unknown/p400-600/b2'], ['LEO low drag, high orbit', 'LEO/unknown/p>=800/b0'], ['MEO', 'MEO/unknown'], ['GEO (regime level)', 'GEO'], ['GEO', 'GEO/unknown'], ['HEO (regime level)', 'HEO'], ['HEO', 'HEO/unknown']];
for (const [name, key] of rep) {
  const cells = [1 / 24, 1, 3, 7].map((t) => { const s = sigmaRIC(key, t, { ...model, tail: {}, objectScale: {} } as any); return `${f1(s[0])} / ${f1(s[1])} / ${f1(s[2])} (${f1(Math.hypot(...s))})`; });
  console.log(`| ${name} (${key}) | ${cells.join(' | ')} |`);
}
console.log('\n### same, measured directly (3D offset p50 / p90 km from the pair data, nearest gap bin)');
for (const k of ['LEO', 'MEO', 'GEO', 'HEO']) { const t = T[k]; console.log(k, [1, 3].map((d) => { const b = t!.bins.find((x: any) => d >= x.lo && d < x.hi)!; return `${d} d (bin ${b.lo}-${Math.floor(b.hi)}): ${f1(b.pos3d[0])} / ${f1(b.pos3d[1])} / ${f1(b.pos3d[2])}`; }).join('; ')); }
