// Pure encounter labelling (ported from scripts/starmap/events-ca.ts classifyCa).
// An encounter found by the screener is geometry; the label says whether the two objects keep company (same shell and plane,
// same launch, same constellation) or are unrelated objects whose orbits cross.
const MU = 398600.4418;

export interface ElsetLite { name: string; objectId: string; meanMotion: number; incDeg: number; raanDeg: number }

export const familyOf = (name: string): string => (name.trim().split(/[\s\-]/)[0] ?? '').toUpperCase();
export const launchOf = (objectId: string): string => String(objectId).slice(0, 8);
export const semiMajor = (meanMotionRevDay: number): number => Math.cbrt(MU / (((meanMotionRevDay * 2 * Math.PI) / 86400) ** 2));

/** Near-identical element sets: same shell and plane. */
export function nearIdentical(a: ElsetLite, b: ElsetLite): boolean {
  const dRaan = Math.abs(((a.raanDeg - b.raanDeg + 540) % 360) - 180);
  return Math.abs(semiMajor(a.meanMotion) - semiMajor(b.meanMotion)) < 1 && Math.abs(a.incDeg - b.incDeg) < 0.01 && dRaan < 0.01;
}

export type EncounterLabel = 'twin' | 'co_moving' | 'same_launch' | 'same_family' | 'crossing';

/**
 * First match wins:
 *  twin        near-identical elements (same shell, plane)
 *  co_moving   relative speed < 0.5 km/s: drifting together
 *  same_launch same COSPAR launch id
 *  same_family same name prefix (same constellation or series) but different launch
 *  crossing    two unrelated objects whose orbits cross
 */
export function labelEncounter(a: ElsetLite, b: ElsetLite, vKmS: number): EncounterLabel {
  const sameFamily = familyOf(a.name) === familyOf(b.name) && familyOf(a.name) !== '';
  const sameLaunch = launchOf(a.objectId) === launchOf(b.objectId);
  return nearIdentical(a, b) ? 'twin' : vKmS < 0.5 ? 'co_moving' : sameLaunch ? 'same_launch' : sameFamily ? 'same_family' : 'crossing';
}
