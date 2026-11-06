// Test / dev fixtures for the history replay API (shapes of data/replay-types.ts).
import type { HistoryCatalogObject } from './replay-types';

/** A plausible catalog object (ISS-like LEO elements) with overridable fields. */
export function histObj(noradId: number, over: Partial<HistoryCatalogObject> = {}): HistoryCatalogObject {
  return {
    noradId,
    name: `OBJ ${noradId}`,
    objectType: 'PAYLOAD',
    intlDesignator: '1998-067A',
    launchDate: '1998-11-20',
    decayDate: null,
    propagator: 'sgp4',
    omm: {
      OBJECT_NAME: `OBJ ${noradId}`,
      OBJECT_ID: '1998-067A',
      EPOCH: '1998-11-20T12:00:00.000',
      MEAN_MOTION: 15.6,
      ECCENTRICITY: 0.0005,
      INCLINATION: 51.6,
      RA_OF_ASC_NODE: 10,
      ARG_OF_PERICENTER: 20,
      MEAN_ANOMALY: 30,
      EPHEMERIS_TYPE: 0,
      CLASSIFICATION_TYPE: 'U',
      NORAD_CAT_ID: noradId,
      ELEMENT_SET_NO: 999,
      REV_AT_EPOCH: 1,
      BSTAR: 0.0001,
      MEAN_MOTION_DOT: 0.0001,
      MEAN_MOTION_DDOT: 0,
    },
    ...over,
  };
}

