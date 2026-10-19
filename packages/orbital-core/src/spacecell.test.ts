import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WGS84_A_KM } from './earth.js';
import {
  ang2pixNest,
  pix2angNest,
  radialIndex,
  cellKey,
  parentKey,
  childKeys,
  decodeKey,
  cellCentre,
  cellWidthKm,
  keyRangeAtMaxOrder,
  alignedKey,
  SHELL_DELTA0,
  coverBall,
} from './spacecell.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randDir(rnd: () => number): { z: number; phi: number } {
  return { z: 2 * rnd() - 1, phi: 2 * Math.PI * rnd() };
}

/** Random position with r log-uniform in the valid radial range. */
function randPos(rnd: () => number): { x: number; y: number; z: number } {
  const { z, phi } = randDir(rnd);
  const L = -SHELL_DELTA0 + rnd() * 8 * SHELL_DELTA0 * 0.999999;
  const r = WGS84_A_KM * Math.exp(L);
  const s = Math.sqrt(1 - z * z);
  return { x: r * s * Math.cos(phi), y: r * s * Math.sin(phi), z: r * z };
}

describe('spacecell: HEALPix nested', () => {
  it('order-0 pixel centres match the known layout', () => {
    for (let p = 0; p < 12; p++) {
      const exp =
        p < 4
          ? { z: 2 / 3, phi: Math.PI / 4 + (p * Math.PI) / 2 }
          : p < 8
            ? { z: 0, phi: ((p - 4) * Math.PI) / 2 }
            : { z: -2 / 3, phi: Math.PI / 4 + ((p - 8) * Math.PI) / 2 };
      const got = pix2angNest(0, p);
      assert.ok(Math.abs(got.z - exp.z) < 1e-12, `z p=${p}`);
      assert.ok(Math.abs(got.phi - exp.phi) < 1e-12, `phi p=${p}`);
      assert.equal(ang2pixNest(0, exp.z, exp.phi), p);
    }
  });

  it('round-trips pix2ang -> ang2pix for orders 0..18', () => {
    const rnd = mulberry32(1);
    for (let k = 0; k <= 18; k++) {
      const n = 12 * 4 ** k;
      if (n <= 20000) {
        for (let p = 0; p < n; p++) {
          const { z, phi } = pix2angNest(k, p);
          assert.equal(ang2pixNest(k, z, phi), p, `order ${k} pix ${p}`);
        }
      } else {
        for (let i = 0; i < 5000; i++) {
          const p = Math.floor(rnd() * n);
          const { z, phi } = pix2angNest(k, p);
          assert.equal(ang2pixNest(k, z, phi), p, `order ${k} pix ${p}`);
        }
      }
    }
  });

  it('nests: parent pixel = child pixel / 4', () => {
    const rnd = mulberry32(2);
    for (let i = 0; i < 2000; i++) {
      const { z, phi } = randDir(rnd);
      for (let k = 0; k < 18; k++) {
        assert.equal(Math.floor(ang2pixNest(k + 1, z, phi) / 4), ang2pixNest(k, z, phi));
      }
    }
  });

  it('is equal-area (order 2, 1e6 uniform samples within 6% of mean)', () => {
    const rnd = mulberry32(3);
    const counts = new Array<number>(192).fill(0);
    const N = 1_000_000;
    for (let i = 0; i < N; i++) {
      const { z, phi } = randDir(rnd);
      counts[ang2pixNest(2, z, phi)]!++;
    }
    const mean = N / 192;
    for (let p = 0; p < 192; p++) {
      assert.ok(Math.abs(counts[p]! - mean) / mean < 0.06, `pix ${p} count ${counts[p]}`);
    }
  });

  it('handles poles, seams and exact boundaries', () => {
    const zs = [1, -1, 2 / 3, -2 / 3, 0, 1 - 1e-16, -1 + 1e-16];
    const phis = [0, 2 * Math.PI, -0, -1e-18, -1, -7, Math.PI / 2, Math.PI, 3 * Math.PI, 1e6];
    for (let k = 0; k <= 18; k++) {
      const n = 12 * 4 ** k;
      for (const z of zs) {
        for (const phi of phis) {
          const p = ang2pixNest(k, z, phi);
          assert.ok(Number.isInteger(p) && p >= 0 && p < n, `k=${k} z=${z} phi=${phi} -> ${p}`);
        }
      }
    }
  });
});

describe('spacecell: radial shells', () => {
  it('nests: floor(n_{k+1}/2) === n_k', () => {
    const rnd = mulberry32(4);
    for (let i = 0; i < 2000; i++) {
      const r = WGS84_A_KM * Math.exp(-SHELL_DELTA0 + rnd() * 8 * SHELL_DELTA0 * 0.999);
      for (let k = 0; k < 18; k++) {
        assert.equal(Math.floor(radialIndex(k + 1, r)! / 2), radialIndex(k, r));
      }
    }
  });

  it('returns null outside the base-shell range', () => {
    assert.equal(radialIndex(0, WGS84_A_KM * Math.exp(-SHELL_DELTA0) * 0.999), null);
    assert.equal(radialIndex(0, WGS84_A_KM * Math.exp(7 * SHELL_DELTA0)), null);
    assert.equal(radialIndex(5, 0), null);
    assert.equal(radialIndex(5, NaN), null);
    assert.equal(cellKey(3, 0, 0, 0), null);
    assert.notEqual(radialIndex(0, WGS84_A_KM * Math.exp(-SHELL_DELTA0) * 1.001), null);
  });

  it('puts the surface at n_0 = 0 and GEO at n_0 = 1', () => {
    assert.equal(radialIndex(0, WGS84_A_KM + 1), 0);
    const ratio = Math.log(42164 / WGS84_A_KM) / SHELL_DELTA0;
    assert.ok(ratio > 1.84 && ratio < 1.85, `ratio ${ratio}`);
    assert.equal(radialIndex(0, 42164), 1);
  });
});

describe('spacecell: octree keys', () => {
  it('parent(child key) === coarser key; key is among parent children', () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 3000; i++) {
      const p = randPos(rnd);
      for (let k = 0; k <= 14; k++) {
        const a = cellKey(k, p.x, p.y, p.z)!;
        const b = cellKey(k + 1, p.x, p.y, p.z)!;
        assert.equal(parentKey(b), a);
        assert.ok(childKeys(a).includes(b));
      }
    }
  });

  it('aligned max-order key lies in the range of every ancestor cell', () => {
    const rnd = mulberry32(6);
    for (let i = 0; i < 2000; i++) {
      const p = randPos(rnd);
      const a = alignedKey(15, cellKey(15, p.x, p.y, p.z)!);
      for (let k = 0; k <= 15; k++) {
        const [lo, hi] = keyRangeAtMaxOrder(k, cellKey(k, p.x, p.y, p.z)!);
        assert.ok(lo <= a && a < hi, `order ${k}`);
      }
    }
    assert.equal(alignedKey(18 - 3, 5), 5n * 8n ** 3n);
  });

  it('cell centres re-encode to the same key', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 3000; i++) {
      const p = randPos(rnd);
      const k = Math.floor(rnd() * 16);
      const key = cellKey(k, p.x, p.y, p.z)!;
      const c = cellCentre(k, key);
      assert.equal(cellKey(k, c.x, c.y, c.z), key, `order ${k}`);
      const d = decodeKey(k, key);
      assert.ok(d.base >= 0 && d.base < 12);
    }
  });

  it('cells are roughly cubic (order 6 at 6878 km)', () => {
    const k = 6;
    const r = 6878;
    const ang = Math.sqrt((4 * Math.PI) / (12 * 4 ** k)) * r;
    const n = radialIndex(k, r)!;
    const d = SHELL_DELTA0 / 2 ** k;
    const thick = WGS84_A_KM * (Math.exp((n + 1) * d) - Math.exp(n * d));
    const ratio = ang / thick;
    // angular width ~110 km vs shell thickness ~110 km
    assert.ok(ratio > 1 / 1.3 && ratio < 1.3, `ang ${ang.toFixed(1)} km, shell ${thick.toFixed(1)} km`);
    assert.ok(Math.abs(cellWidthKm(k, r) - ang) / ang < 0.1);
  });
});

describe('spacecell: coverBall', () => {
  const cases: Array<{ order: number; r: number; R: number }> = [
    { order: 3, r: 6800, R: 500 }, { order: 4, r: 6800, R: 100 }, { order: 5, r: 6800, R: 50 },
    { order: 4, r: 7200, R: 500 }, { order: 3, r: 42164, R: 2000 }, { order: 4, r: 42164, R: 1000 },
    { order: 5, r: 42164, R: 3000 }, { order: 4, r: 26560, R: 800 },
  ];

  it('contains every random point inside the ball (100k points over several balls)', () => {
    const rnd = mulberry32(777);
    const perBall = Math.ceil(100_000 / cases.length);
    let total = 0;
    for (const c of cases) {
      for (let rep = 0; rep < 2; rep++) {
        const d = randDir(rnd);
        const s = Math.sqrt(1 - d.z * d.z);
        const cx = c.r * s * Math.cos(d.phi), cy = c.r * s * Math.sin(d.phi), cz = c.r * d.z;
        const cover = new Set(coverBall(c.order, cx, cy, cz, c.R));
        for (let i = 0; i < perBall / 2; i++) {
          // uniform in ball by rejection
          let px: number, py: number, pz: number;
          do { px = (rnd() * 2 - 1); py = (rnd() * 2 - 1); pz = (rnd() * 2 - 1); } while (px * px + py * py + pz * pz > 1);
          const k = cellKey(c.order, cx + px * c.R, cy + py * c.R, cz + pz * c.R);
          assert.ok(k !== null && cover.has(k), `missed point: order ${c.order} r ${c.r} R ${c.R}`);
          total++;
        }
      }
    }
    assert.ok(total >= 100_000 - cases.length * 2);
  });

  it('a tiny ball covers 1..8 cells', () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 50; i++) {
      const d = randDir(rnd);
      const s = Math.sqrt(1 - d.z * d.z);
      const r = 6800;
      const n = coverBall(4, r * s * Math.cos(d.phi), r * s * Math.sin(d.phi), r * d.z, 1).length;
      assert.ok(n >= 1 && n <= 8, `got ${n}`);
    }
  });

  it('cover size grows with radius (order 4, ~420 km altitude)', () => {
    const r = WGS84_A_KM + 420;
    const sizes = [50, 100, 500].map((R) => coverBall(4, r * 0.6, r * 0.64, r * 0.48, R).length);
    console.log(`coverBall order 4 near 420 km altitude: R=50 -> ${sizes[0]}, R=100 -> ${sizes[1]}, R=500 -> ${sizes[2]} cells`);
    assert.ok(sizes[0]! <= sizes[1]! && sizes[1]! <= sizes[2]!);
    assert.ok(sizes[2]! > sizes[0]!);
  });
});
