// SPIKE — not production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDayLine, decodeDayLine, evalDayLine, evalVelocity, BatchEphem, type SampleFn } from './ephem.js';

const DAY0 = Date.UTC(2026, 9, 20);

/** circular orbit, period P minutes, radius R km, inclined. */
const orbit = (periodMin: number, R = 7000, inc = 0.9): SampleFn => (t) => {
  const th = (2 * Math.PI * (t - DAY0)) / (periodMin * 60000);
  return [R * Math.cos(th), R * Math.sin(th) * Math.cos(inc), R * Math.sin(th) * Math.sin(inc)];
};
const isLine = (r: unknown): r is { buf: Uint8Array; nseg: number; deg: number; maxErrKm: number } => !!r && typeof r === 'object' && 'buf' in r;

test('exact on a cubic polynomial (1 segment)', () => {
  const f: SampleFn = (t) => {
    const u = (t - DAY0) / 86_400_000;
    return [1000 + 500 * u - 300 * u * u + 100 * u ** 3, -200 * u + 50 * u * u, 7000];
  };
  const r = fitDayLine(f, DAY0, { tolKm: 1e-6, degrees: [6] });
  assert.ok(isLine(r));
  assert.equal(r.nseg, 1);
  for (const u of [0, 0.123, 0.5, 0.999, 1]) {
    const p = evalDayLine(r.buf, DAY0 + u * 86_400_000)!;
    const q = f(DAY0 + u * 86_400_000)!;
    assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6);
  }
});

for (const prec of ['f64', 'f32'] as const) {
  test(`smooth orbit error <= tol (${prec})`, () => {
    const f = orbit(92.5);
    const r = fitDayLine(f, DAY0, { tolKm: 0.1, precision: prec });
    assert.ok(isLine(r));
    assert.ok(r.maxErrKm <= 0.1);
    let worst = 0;
    for (let t = DAY0; t <= DAY0 + 86_400_000; t += 7300) {
      const p = evalDayLine(r.buf, t)!, q = f(t)!;
      worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    assert.ok(worst < 0.11, `worst ${worst}`);
  });
}

test('f32 is smaller than f64 and a GEO-like orbit needs few bytes', () => {
  const f = orbit(1436, 42164, 0.01);
  const a = fitDayLine(f, DAY0, { precision: 'f64' }), b = fitDayLine(f, DAY0, { precision: 'f32' });
  assert.ok(isLine(a) && isLine(b));
  assert.ok(b.buf.length < a.buf.length);
  assert.ok(a.buf.length < 1000);
});

test('velocity matches finite difference', () => {
  const f = orbit(92.5);
  const r = fitDayLine(f, DAY0, { tolKm: 0.01 });
  assert.ok(isLine(r));
  for (const t of [DAY0 + 3_600_000, DAY0 + 40_000_000, DAY0 + 80_000_000]) {
    const v = evalVelocity(r.buf, t)!;
    const a = f(t - 500)!, b = f(t + 500)!;
    const fd = [0, 1, 2].map((i) => (b[i]! - a[i]!) / 1);
    assert.ok(Math.hypot(v[0] - fd[0]!, v[1] - fd[1]!, v[2] - fd[2]!) < 1e-3, `${v} vs ${fd}`);
  }
});

test('encode/decode round trip, batch matches single, out of coverage is rejected', () => {
  const lines = [orbit(92.5), orbit(1436, 42164)].map((f) => fitDayLine(f, DAY0, { marginSec: 600 }));
  assert.ok(lines.every(isLine));
  const bufs = lines.map((l) => (l as { buf: Uint8Array }).buf);
  const d = decodeDayLine(bufs[0]!);
  assert.equal(d.t0, DAY0 - 600_000);
  const batch = new BatchEphem(bufs);
  const out = new Float64Array(6);
  const t = DAY0 + 12_345_678;
  batch.evalAll(t, out);
  for (let i = 0; i < 2; i++) {
    const p = evalDayLine(bufs[i]!, t)!;
    assert.deepEqual([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]], p);
  }
  assert.equal(evalDayLine(bufs[0]!, DAY0 + 90_000_000), null);
  assert.ok(evalDayLine(bufs[0]!, DAY0 - 300_000));
});

test('sampler failure is reported, not thrown', () => {
  const r = fitDayLine(() => null, DAY0);
  assert.ok(!isLine(r));
});
