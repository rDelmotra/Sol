// Pc (2D Foster) against NASA CARA reference cases. See collision-cara.fixture.ts for the source and the licence note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSym3, encounterGeometry, pcFoster, type Sym3 } from './collision.js';
import type { V3 } from './ric.js';
import { ALFANO_CASES, OMITRON_CIRCLE } from './collision-cara.fixture.js';

const sym = (c: number[][], k: number): Sym3 => [c[0]![0]! * k, c[0]![1]! * k, c[0]![2]! * k, c[1]![1]! * k, c[1]![2]! * k, c[2]![2]! * k];
const v3 = (a: number[], k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];

/** Same convention as Pc2D_Foster: r = r1 - r2, combined position covariance, circle of radius hbr centred on the miss in the encounter plane. */
function pcCara(c: { r1: number[]; v1: number[]; c1: number[][]; r2: number[]; v2: number[]; c2: number[][]; hbr: number }, unit: number): { pc: number; miss: number } {
  const k = 1 / unit; // metres -> km when unit = 1000
  const rel = v3([c.r2[0]! - c.r1[0]!, c.r2[1]! - c.r1[1]!, c.r2[2]! - c.r1[2]!], k);
  const vel = v3([c.v2[0]! - c.v1[0]!, c.v2[1]! - c.v1[1]!, c.v2[2]! - c.v1[2]!], k);
  const cov = addSym3(sym(c.c1, k * k), sym(c.c2, k * k));
  const g = encounterGeometry(rel, vel, cov)!;
  return { pc: pcFoster(g.mx, g.my, g.cov, c.hbr * k), miss: g.miss };
}

test('Pc matches the NASA CARA Omitron test case 01 (circular hard body)', () => {
  const { pc } = pcCara(OMITRON_CIRCLE, 1); // inputs already in km
  assert.ok(Math.abs(pc / OMITRON_CIRCLE.expectedPc - 1) < 1e-3, `Pc ${pc} vs ${OMITRON_CIRCLE.expectedPc}`);
});

test('Pc matches the 11 Alfano (2009) cases used by the NASA CARA unit test (relative 1e-3)', () => {
  for (const c of ALFANO_CASES) {
    const { pc } = pcCara(c, 1000);
    const rel = Math.abs(pc / c.expectedPc - 1);
    assert.ok(rel < 1e-3, `${c.name}: Pc ${pc.toExponential(8)} vs expected ${c.expectedPc.toExponential(8)} (relative ${rel.toExponential(2)})`);
  }
});
