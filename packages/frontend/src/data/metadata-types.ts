// ============================================================
// Metadata enrichment — frontend type mirror
//
// Mirrors packages/backend/src/enrichment/types.ts. The InlineMetadataFacets
// (operatorCountry, sectors, purpose, status) are merged onto EnrichedTLEObject
// (data/types.ts); the full ObjectMetadata is fetched lazily from
// /api/metadata/:noradId for the InfoCard "Specifications" section (Phase C).
//
// See my_plans/metadata_enrichment.md.
// ============================================================

export type Sector = 'commercial' | 'government' | 'military' | 'civil';

/** Sector filter key space: the four real sectors plus an explicit "no UCS match". */
export type SectorFilterKey = Sector | 'unspecified';

export type Purpose =
  | 'communications'
  | 'earth_observation'
  | 'navigation'
  | 'technology_dev'
  | 'space_science'
  | 'space_observation'
  | 'surveillance'
  | 'meteorological'
  | 'other';

/** Operational status (vestigial — Space-Track no longer exposes it; always 'unknown'). */
export type OperationalStatus =
  | 'operational'
  | 'partial'
  | 'nonoperational'
  | 'backup'
  | 'spare'
  | 'extended'
  | 'unknown';

/** Orbital status from the McDowell satcat.csv — the live "status" facet. */
export type OrbitalStatus =
  | 'in_orbit'
  | 'decayed'
  | 'deorbited'
  | 'beyond_earth'
  | 'exploded'
  | 'unknown';

export type CatalogObjectType =
  | 'payload'
  | 'rocket_body'
  | 'debris'
  | 'component'
  | 'unknown';

// 'inferred' = filled from the backend program registry by name-pattern match.
export type MetadataSource = 'ucs-2023-05' | 'satcat-gc' | 'spacetrack' | 'inferred';

/** Per-facet provenance — keys exist ONLY for facets filled by program inference. */
export interface FacetProvenance {
  sectors?: MetadataSource;
  purpose?: MetadataSource;
  country?: MetadataSource;
  org?: MetadataSource;
}

/** Compact facets inlined onto EnrichedTLEObject (cheap to filter, hot-path safe). */
export interface InlineMetadataFacets {
  operatorCountry: string | null;
  sectors: Sector[];
  purpose: Purpose;
  status: OrbitalStatus;
  program?: string;
}

/** Full record, lazy-loaded from /api/metadata/:noradId for the InfoCard (Phase C). */
export interface ObjectMetadata {
  noradId: number;
  operatorCountry: string | null;
  operatorOrg: string | null;
  sectors: Sector[];
  purpose: Purpose;
  detailedPurpose: string | null;
  operationalStatus: OperationalStatus;
  orbitalStatus: OrbitalStatus;
  objectType: CatalogObjectType;
  contractor: string | null;
  contractorCountry: string | null;
  launchSite: string | null;
  launchVehicle: string | null;
  launchMassKg: number | null;
  dryMassKg: number | null;
  powerW: number | null;
  expectedLifetimeYrs: number | null;
  cospar: string | null;
  orbitClass: string | null;
  program?: string;                    // program registry slug (e.g. 'starlink')
  facetProvenance?: FacetProvenance;   // present only when facets were inferred
  sources: MetadataSource[];
}

/** Slim row for the decayed-catalog browser (GET /api/catalog/decayed) — Phase D. */
export interface DecayedCatalogRow {
  noradId: number;
  name: string;
  country: string | null;
  status: OrbitalStatus;
  objectType: CatalogObjectType;
  orbitClass: string | null;
  launchYear: number | null;
}

// ── Display labels for the FilterPanel groups + Legend (Phase B6/B7) ───────────

export const SECTOR_LABELS: Record<SectorFilterKey, string> = {
  commercial: 'Commercial',
  government: 'Government',
  military: 'Military',
  civil: 'Civil',
  unspecified: 'Unspecified',
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  communications: 'Communications',
  earth_observation: 'Earth Observation',
  navigation: 'Navigation',
  technology_dev: 'Technology Development',
  space_science: 'Space Science',
  space_observation: 'Space Observation',
  surveillance: 'Surveillance',
  meteorological: 'Meteorological',
  other: 'Other / Unspecified',
};

export const ORBITAL_STATUS_LABELS: Record<OrbitalStatus, string> = {
  in_orbit: 'In Orbit',
  decayed: 'Decayed',
  deorbited: 'Deorbited',
  beyond_earth: 'Beyond Earth Orbit',
  exploded: 'Exploded',
  unknown: 'Unknown',
};

// Program registry slug → display name. Hand-mirrored from the backend registry
// (packages/backend/src/enrichment/programs.ts / enrichment-data/programs-summary.json);
// unknown slugs fall back to the raw slug at the call site. A future
// GET /api/programs (backed by programs-summary.json) replaces this mirror.
export const PROGRAM_LABELS: Record<string, string> = {
  'starlink': 'Starlink',
  'oneweb': 'OneWeb',
  'kuiper': 'Project Kuiper',
  'qianfan': 'Qianfan (G60)',
  'guowang': 'Guowang',
  'iridium': 'Iridium',
  'globalstar': 'Globalstar',
  'orbcomm': 'Orbcomm',
  'spacebee': 'SpaceBEE',
  'kineis': 'Kinéis',
  'tianqi': 'Tianqi',
  'sitro-ais': 'Sitro-AIS',
  'flock': 'Flock (Planet)',
  'skysat': 'SkySat',
  'lemur': 'Lemur (Spire)',
  'jilin': 'Jilin-1',
  'hawkeye': 'HawkEye 360',
  'bro': 'BRO (Unseenlabs)',
  'blacksky': 'BlackSky Global',
  'yunyao': 'Yunyao',
  'geesat': 'GeeSAT (Geely)',
  'iceye': 'ICEYE',
  'tianmu': 'Tianmu-1',
  'iride': 'IRIDE',
  'gps': 'GPS (Navstar)',
  'galileo': 'Galileo',
  'beidou': 'BeiDou',
  'navic': 'NavIC (IRNSS)',
  'transit': 'Transit (NNS)',
  'fengyun': 'Fengyun',
  'meteor': 'Meteor',
  'noaa': 'NOAA',
  'goes': 'GOES',
  'metop': 'MetOp',
  'meteosat': 'Meteosat',
  'dmsp': 'DMSP',
  'yunhai': 'Yunhai',
  'himawari': 'Himawari',
  'yaogan': 'Yaogan',
  'gaofen': 'Gaofen',
  'ziyuan': 'Ziyuan',
  'tianhui': 'Tianhui',
  'sentinel': 'Sentinel (Copernicus)',
  'landsat': 'Landsat',
  'intelsat': 'Intelsat',
  'eutelsat': 'Eutelsat',
  'ses': 'SES / Astra',
  'o3b': 'O3b',
  'telstar': 'Telstar / Anik',
  'ekspress': 'Ekspress',
  'jcsat': 'JCSAT',
  'turksat': 'Türksat',
  'chinasat': 'ChinaSat (Zhongxing)',
  'insat': 'INSAT / GSAT (India)',
  'tdrs': 'TDRS',
  'skynet': 'Skynet',
  'gonets': 'Gonets',
  'strela': 'Strela',
  'molniya': 'Molniya',
  'raduga': 'Raduga',
  'gorizont': 'Gorizont',
  'ekran': 'Ekran',
  'shiyan': 'Shiyan',
  'shijian': 'Shijian',
  'tjs': 'TJS (Tongxin Jishu Shiyan)',
  'hulianwang-shiyan': 'Hulianwang Shiyan',
  'sda': 'SDA (PWSA)',
  'dsp': 'DSP',
  'dscs': 'DSCS',
  'cosmos': 'Kosmos',
  'usa': 'USA (DoD series)',
  'ops': 'OPS (DoD series)',
};
