// ============================================================
// OMM → orbital-core OrbitElements, for the orbit diagram.
//
// orbital-core's orbit-shape functions take plain numbers. Parsing the OMM
// record is a frontend concern and lives here, including one trap: OMM EPOCH
// strings are UTC but usually carry no zone marker ("2026-07-10T00:00:00").
// Date.parse reads a zoneless date-time as LOCAL time, which would slide the
// object along its orbit by the viewer's UTC offset. We append "Z" when no
// zone is present.
// ============================================================

import type { OrbitElements } from '@orbitwatch/orbital-core';

/** The OMM fields the diagram reads. Values may be numbers or numeric strings. */
export interface OmmOrbitFields {
  MEAN_MOTION?: unknown;
  ECCENTRICITY?: unknown;
  MEAN_ANOMALY?: unknown;
  INCLINATION?: unknown;
  RA_OF_ASC_NODE?: unknown;
  ARG_OF_PERICENTER?: unknown;
  EPOCH?: unknown;
}

/** OMM EPOCH → UTC epoch ms. A string without a zone marker is read as UTC. NaN if unparseable. */
export function ommEpochMs(epoch: unknown): number {
  const s = String(epoch ?? '').trim();
  if (!s) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

/** Plain numeric elements from an OMM record, or null if any field is missing or not finite. */
export function orbitElementsFromOmm(omm: OmmOrbitFields): OrbitElements | null {
  // Number(undefined) is NaN, but Number(null) and Number('') are 0; treat those as missing too.
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const el: OrbitElements = {
    meanMotionRevPerDay: num(omm.MEAN_MOTION),
    eccentricity: num(omm.ECCENTRICITY),
    meanAnomalyDeg: num(omm.MEAN_ANOMALY),
    inclinationDeg: num(omm.INCLINATION),
    raanDeg: num(omm.RA_OF_ASC_NODE),
    argPerigeeDeg: num(omm.ARG_OF_PERICENTER),
    epochMs: ommEpochMs(omm.EPOCH),
  };
  return Object.values(el).every(Number.isFinite) ? el : null;
}
