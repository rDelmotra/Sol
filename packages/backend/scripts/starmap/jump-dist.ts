// SPIKE — not production. Distribution of epoch-to-epoch jump metrics over all contiguous days (threshold calibration).
import { writeFileSync } from 'node:fs';
import { EVENTS_DIR, contiguousDays, prevDay, loadDayCatalog, jumpMetrics, type JumpMetric } from './events.js';

const days = contiguousDays();
const all: Array<JumpMetric & { day: string }> = [];
let prev = loadDayCatalog(days[0]!);
for (const day of days.slice(1)) {
  const cur = loadDayCatalog(day);
  const r = jumpMetrics(prev, cur);
  for (const m of r.metrics) all.push({ ...m, day });
  console.log(day, 'both', r.both, 'unchanged', r.unchanged, 'changed', r.metrics.length, 'failed', r.failed);
  prev = cur;
}
writeFileSync(EVENTS_DIR + 'jump-metrics.json', JSON.stringify(all));
const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))]!;
for (const reg of ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']) {
  const s = all.filter((m) => m.regime === reg);
  if (!s.length) continue;
  const d = s.map((m) => m.dposKm).sort((a, b) => a - b);
  const da = s.map((m) => Math.abs(m.daKm)).sort((a, b) => a - b);
  const g = s.map((m) => m.gapDays).sort((a, b) => a - b);
  console.log(reg, 'n', s.length, 'dpos p50/p90/p99/p99.9 km', [.5, .9, .99, .999].map((p) => q(d, p).toFixed(2)).join(' / '), '| |da| p50/p90/p99', [.5, .9, .99].map((p) => q(da, p).toFixed(3)).join(' / '), '| gap days p50/p90', q(g, .5).toFixed(2), q(g, .9).toFixed(2));
}
