// Synthetic element sets for the coverage / pass tests: a small constellation spread over inclinations, planes and phases, plus a GEO
// object, with EPOCH at the start of the day so the +-60 day cap never matters.
export function synthOmm(id: number, epochIso: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    OBJECT_NAME: `SYN-${id}`, OBJECT_ID: `2020-0${id}A`, EPOCH: epochIso, MEAN_MOTION: 15.1, ECCENTRICITY: 0.0001, INCLINATION: 53, RA_OF_ASC_NODE: 10,
    ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: id, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1000, ...over,
  };
}

/** n LEO objects (ids 100..) spread in plane and phase, a polar and a retrograde group, and one GEO (id 5000). */
export function synthCatalog(n: number, epochIso: string): Array<{ noradId: number; omm: Record<string, unknown> }> {
  const out: Array<{ noradId: number; omm: Record<string, unknown> }> = [];
  for (let i = 0; i < n; i++) {
    const inc = [53, 98, 28.5, 70, 97.5, 51.6][i % 6]!;
    out.push({ noradId: 100 + i, omm: synthOmm(100 + i, epochIso, { INCLINATION: inc, RA_OF_ASC_NODE: (i * 37) % 360, MEAN_ANOMALY: (i * 91) % 360, MEAN_MOTION: 14.2 + (i % 5) * 0.4, ECCENTRICITY: 0.0001 + (i % 4) * 0.001 }) });
  }
  out.push({ noradId: 5000, omm: synthOmm(5000, epochIso, { MEAN_MOTION: 1.0027, INCLINATION: 0.05, RA_OF_ASC_NODE: 80, MEAN_ANOMALY: 40, ECCENTRICITY: 0.0002 }) });
  return out;
}
