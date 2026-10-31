// ============================================================
// Types of the encounter screener (src/ssa/). Neutral naming: an "encounter" is a predicted close approach of two objects.
// ============================================================

/** One element set of one object, with the catalog fields the screener needs. */
export interface SsaObject {
  noradId: number;
  name: string;
  /** 'rocket_body' | 'debris' | anything else (payload / unknown) */
  objectType?: string;
  /** radar size class: SMALL | MEDIUM | LARGE | null */
  rcsSize?: string | null;
  /** LEO | MEO | GEO | HEO | OTHER (uncertainty class). Derived from the elements when absent. */
  regime?: string;
  /** perigee altitude, km (uncertainty class). Derived from the elements when absent. */
  perigee?: number;
  /** OMM mean elements as satellite.js json2satrec reads them (EPOCH, MEAN_MOTION, ECCENTRICITY, ...) */
  omm: Record<string, unknown>;
}

export type Vec3 = [number, number, number];

/** A predicted close approach of two objects (a < b by NORAD id) inside the screening window. */
export interface Encounter {
  noradA: number;
  noradB: number;
  nameA: string;
  nameB: string;
  /** time of closest approach, UTC ms */
  tcaMs: number;
  missKm: number;
  vrelKms: number;
  /** position of b relative to a in a's radial / in-track / cross-track frame at TCA, km */
  ricKm: Vec3;
  /** the screening volume the encounter lies in (name), or 'sphere 5 km' */
  volume: string;
  /** collision probability, balanced covariance with floor (Foster 2D) */
  pc: number;
  /** worst-case collision probability over the covariance scale */
  pcMax: number;
  /** combined hard-body radius, km */
  hbrKm: number;
  /** either object belongs to a constellation that manoeuvres routinely */
  manoeuvrable: boolean;
  /** twin | co_moving | same_launch | same_family | crossing */
  label: string;
  epochA: number;
  epochB: number;
  ageDaysA: number;
  ageDaysB: number;
  /** combined error ellipse in the encounter plane: 1-sigma major / minor, km (with floor) */
  sigmaMajKm: number;
  sigmaMinKm: number;
}

export interface ScreenStats {
  /** catalog objects in */
  objectsIn: number;
  /** after the causal rule (latest set with epoch <= batch time) and the exclusions below */
  objectsScreened: number;
  noEarlierSet: number;
  fenced: number;
  unusable: number;
  garbage: number;
  identicalGroups: number;
  objectsWithoutPartner: number;
  candidateWindows: number;
  formationPairs: number;
  runs: number;
  minima: number;
  acceptedMinima: number;
  evalFailed: number;
  duplicatesDropped: number;
  sgp4Calls: number;
  /** latest epoch among the screened element sets, UTC ms */
  elementCutoffMs: number;
  hours: number;
  batchTimeMs: number;
  durationS: number;
  maxRssMB: number;
}

export interface ScreenOpts {
  /** length of the screening window from the batch time (default 36) */
  hours?: number;
  /** coarse step, s (default 60) */
  dtS?: number;
  workers?: number;
  /** path of a full uncertainty model.json (per-object scales); default: SSA_UNCERTAINTY_MODEL, else the embedded class-level model */
  modelPath?: string;
}
