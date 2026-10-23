// ============================================================
// SPIKE — not production. Pure close-approach classification (unit-tested).
// A "close approach" found by the grid is geometry: two objects whose mean-element orbits cross within a few km.
// This module sorts them into categories so the stored kind can be redefined to something believable.
// ============================================================
const MU = 398600.4418;

export interface ElsetLite { name: string; objectId: string; meanMotion: number; incDeg: number; raanDeg: number; objectType?: string }

export const familyOf = (name: string): string => (name.trim().split(/[\s\-]/)[0] ?? '').toUpperCase();
export const launchOf = (objectId: string): string => String(objectId).slice(0, 8);
export const semiMajor = (meanMotionRevDay: number): number => Math.cbrt(MU / ((meanMotionRevDay * 2 * Math.PI / 86400) ** 2));

/** Near-identical element sets: same shell and plane, so the two objects keep company (not an independent crossing). */
export function nearIdentical(a: ElsetLite, b: ElsetLite): boolean {
  const dRaan = Math.abs(((a.raanDeg - b.raanDeg + 540) % 360) - 180);
  return Math.abs(semiMajor(a.meanMotion) - semiMajor(b.meanMotion)) < 1 && Math.abs(a.incDeg - b.incDeg) < 0.01 && dRaan < 0.01;
}

export type CaCat = 'twin' | 'co_moving' | 'same_launch' | 'same_family' | 'crossing';
export const CA_CATS: CaCat[] = ['twin', 'co_moving', 'same_launch', 'same_family', 'crossing'];

export interface CaFeat { cat: CaCat; sameFamily: boolean; sameLaunch: boolean; twin: boolean; durS: number }

/** Time (s) the pair spends inside `km`, if it flies a straight line past each other at miss distance d with relative speed v. */
export const secondsWithin = (km: number, d: number, v: number): number => (d >= km || v <= 0 ? 0 : (2 * Math.sqrt(km * km - d * d)) / v);

/**
 * Category, first match wins:
 *  twin        near-identical elements (same shell, plane): keeping company, not crossing
 *  co_moving   relative speed < 0.5 km/s: drifting together (a real crossing in LEO is 2-15 km/s)
 *  same_launch same COSPAR launch id (deployment batch, debris of one event)
 *  same_family same name prefix (same constellation or series) but different launch
 *  crossing    two unrelated objects whose orbits cross: the textbook conjunction
 */
export function classifyCa(a: ElsetLite, b: ElsetLite, dKm: number, vKmS: number): CaFeat {
  const sameFamily = familyOf(a.name) === familyOf(b.name) && familyOf(a.name) !== '';
  const sameLaunch = launchOf(a.objectId) === launchOf(b.objectId);
  const twin = nearIdentical(a, b);
  const durS = secondsWithin(5, dKm, vKmS);
  const cat: CaCat = twin ? 'twin' : vKmS < 0.5 ? 'co_moving' : sameLaunch ? 'same_launch' : sameFamily ? 'same_family' : 'crossing';
  return { cat, sameFamily, sameLaunch, twin, durS };
}
