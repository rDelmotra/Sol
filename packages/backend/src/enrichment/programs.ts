// ============================================================
// programs.ts — curated satellite-program registry + name matcher
//
// The "Unspecified majority" fix: UCS covers only ≤7,561 pre-2023 payloads, so
// most live objects have empty sector/purpose. A matched program contributes:
//   • membership — rec.program stamped on every payload match
//   • default facets (sectors/purpose/country/org) as FALLBACK ONLY — a facet
//     is filled only when currently empty; UCS/satcat always win
//   • per-facet provenance ('inferred') so inferred values stay distinguishable
//
// Matching is gated to PAYLOADS by the callers (build-enrichment.ts pass +
// store.ts deriveInlineFacets) — debris/rocket bodies carry program names too
// ("FENGYUN 1C DEB" ×~1,900) and must not inherit payload facets.
//
// Curation loop — regenerate candidate prefixes from the census any time:
//   awk -F',' '$6=="Payload" && $9=="In Orbit"' my_plans/satcat.csv \
//     | cut -d',' -f3 | sed 's/[- ][0-9].*//' | tr '[:lower:]' '[:upper:]' \
//     | sort | uniq -c | sort -rn | head -80
// Then check the build script's "top unmatched prefixes" report.
// ============================================================

import type { ObjectMetadata, Sector, Purpose, FacetProvenance } from './types.js';

export interface ProgramEntry {
  id: string;                 // registry slug, e.g. 'starlink'
  displayName: string;
  /** Case-insensitive name prefixes; include BOTH McDowell ("Feng Yun") and
   *  Space-Track ("FENGYUN") variants. Matched against the normalized name. */
  prefixes: string[];
  /** Escape hatch for names a prefix can't express (kept rare — the matcher
   *  runs 30k×/cron and every regex here is tested against every unmatched name). */
  regexes?: RegExp[];
  operatorOrg?: string;
  operatorCountry?: string;   // canonical Space-Track code (US, PRC, CIS, UK, …)
  /** Omitted for ambiguous catch-alls (cosmos) — membership only, no overclaiming. */
  sectors?: Sector[];
  purpose?: Purpose;
  description?: string;
}

// Registry order = match priority (first match wins on overlaps).
export const PROGRAMS: ProgramEntry[] = [
  // ── Megaconstellations / commercial comms (the bulk of the gap) ─────────────
  { id: 'starlink', displayName: 'Starlink', prefixes: ['STARLINK'],
    operatorOrg: 'SpaceX', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications',
    description: 'SpaceX broadband megaconstellation (incl. Direct-to-Cell).' },
  { id: 'oneweb', displayName: 'OneWeb', prefixes: ['ONEWEB'],
    operatorOrg: 'Eutelsat OneWeb', operatorCountry: 'UK', sectors: ['commercial'], purpose: 'communications' },
  { id: 'kuiper', displayName: 'Project Kuiper', prefixes: ['KUIPER'],
    operatorOrg: 'Amazon', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'qianfan', displayName: 'Qianfan (G60)', prefixes: ['QIANFAN'],
    operatorOrg: 'SSST', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'communications',
    description: 'Shanghai Spacecom "Thousand Sails" broadband constellation.' },
  { id: 'guowang', displayName: 'Guowang', prefixes: ['HULIANWANG DIGUI', 'WHDW'],
    operatorOrg: 'China SatNet', operatorCountry: 'PRC', sectors: ['government'], purpose: 'communications',
    description: 'Chinese national broadband constellation (Hulianwang Digui / WHDW).' },
  { id: 'iridium', displayName: 'Iridium', prefixes: ['IRIDIUM'],
    operatorOrg: 'Iridium Communications', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'globalstar', displayName: 'Globalstar', prefixes: ['GLOBALSTAR'],
    operatorOrg: 'Globalstar', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'orbcomm', displayName: 'Orbcomm', prefixes: ['ORBCOMM'],
    operatorOrg: 'Orbcomm', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'spacebee', displayName: 'SpaceBEE', prefixes: ['SPACEBEE'],
    operatorOrg: 'Swarm Technologies', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'kineis', displayName: 'Kinéis', prefixes: ['KINEIS'],
    operatorOrg: 'Kinéis', operatorCountry: 'FR', sectors: ['commercial'], purpose: 'communications' },
  { id: 'tianqi', displayName: 'Tianqi', prefixes: ['TIANQI'],
    operatorOrg: 'Guodian Gaoke', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'communications' },
  { id: 'sitro-ais', displayName: 'Sitro-AIS', prefixes: ['SITRO-AIS'],
    operatorOrg: 'Sitronics', operatorCountry: 'CIS', sectors: ['commercial'], purpose: 'communications' },

  // ── Commercial Earth observation ─────────────────────────────────────────────
  { id: 'flock', displayName: 'Flock (Planet)', prefixes: ['FLOCK'],
    operatorOrg: 'Planet Labs', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'skysat', displayName: 'SkySat', prefixes: ['SKYSAT'],
    operatorOrg: 'Planet Labs', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'lemur', displayName: 'Lemur (Spire)', prefixes: ['LEMUR'],
    operatorOrg: 'Spire Global', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'jilin', displayName: 'Jilin-1', prefixes: ['JILIN'],
    operatorOrg: 'Chang Guang', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'hawkeye', displayName: 'HawkEye 360', prefixes: ['HAWK'],
    operatorOrg: 'HawkEye 360', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'bro', displayName: 'BRO (Unseenlabs)', prefixes: ['BRO'],
    operatorOrg: 'Unseenlabs', operatorCountry: 'FR', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'blacksky', displayName: 'BlackSky Global', prefixes: ['GLOBAL'],
    operatorOrg: 'BlackSky', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'yunyao', displayName: 'Yunyao', prefixes: ['YUNYAO'],
    operatorOrg: 'Yunyao Yuhang', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'meteorological' },
  { id: 'geesat', displayName: 'GeeSAT (Geely)', prefixes: ['GEESAT', 'GEELY XINGZUO', 'GEELY'],
    operatorOrg: 'Geespace', operatorCountry: 'PRC', sectors: ['commercial'] },
  { id: 'iceye', displayName: 'ICEYE', prefixes: ['ICEYE'],
    operatorOrg: 'ICEYE', operatorCountry: 'FIN', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'tianmu', displayName: 'Tianmu-1', prefixes: ['TIANMU'],
    operatorOrg: 'Xiyong Micro-Electronics', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'meteorological',
    description: 'GNSS radio-occultation weather constellation.' },
  { id: 'iride', displayName: 'IRIDE', prefixes: ['IRIDE'],
    operatorOrg: 'ASI / ESA', operatorCountry: 'IT', sectors: ['government', 'civil'], purpose: 'earth_observation' },

  // ── Navigation ───────────────────────────────────────────────────────────────
  { id: 'gps', displayName: 'GPS (Navstar)', prefixes: ['NAVSTAR', 'GPS'],
    operatorOrg: 'US Space Force', operatorCountry: 'US', sectors: ['military', 'government'], purpose: 'navigation' },
  { id: 'galileo', displayName: 'Galileo', prefixes: ['GALILEOSAT'],
    regexes: [/^GSAT0\d{3}/, /\(GALILEO/],
    operatorOrg: 'EUSPA / ESA', operatorCountry: 'ESA', sectors: ['civil', 'government'], purpose: 'navigation',
    description: 'Regexes cover Space-Track "GSAT0219 (GALILEO 23)"; must not match India\'s GSAT-nn.' },
  { id: 'beidou', displayName: 'BeiDou', prefixes: ['BEIDOU'],
    operatorOrg: 'CNSA', operatorCountry: 'PRC', sectors: ['government', 'military'], purpose: 'navigation' },
  { id: 'navic', displayName: 'NavIC (IRNSS)', prefixes: ['IRNSS', 'NVS-'],
    operatorOrg: 'ISRO', operatorCountry: 'IND', sectors: ['government'], purpose: 'navigation' },
  { id: 'transit', displayName: 'Transit (NNS)', prefixes: ['NNS'],
    operatorOrg: 'US Navy', operatorCountry: 'US', sectors: ['military'], purpose: 'navigation' },

  // ── Meteorological ───────────────────────────────────────────────────────────
  { id: 'fengyun', displayName: 'Fengyun', prefixes: ['FENGYUN', 'FENG YUN'],
    operatorOrg: 'CMA', operatorCountry: 'PRC', sectors: ['government'], purpose: 'meteorological' },
  { id: 'meteor', displayName: 'Meteor', prefixes: ['METEOR'],
    operatorOrg: 'Roshydromet', operatorCountry: 'CIS', sectors: ['government'], purpose: 'meteorological' },
  { id: 'noaa', displayName: 'NOAA', prefixes: ['NOAA'],
    operatorOrg: 'NOAA', operatorCountry: 'US', sectors: ['government'], purpose: 'meteorological' },
  { id: 'goes', displayName: 'GOES', prefixes: ['GOES'],
    operatorOrg: 'NOAA', operatorCountry: 'US', sectors: ['government'], purpose: 'meteorological' },
  { id: 'metop', displayName: 'MetOp', prefixes: ['METOP'],
    operatorOrg: 'EUMETSAT', operatorCountry: 'ESA', sectors: ['government'], purpose: 'meteorological' },
  { id: 'meteosat', displayName: 'Meteosat', prefixes: ['METEOSAT'],
    operatorOrg: 'EUMETSAT', operatorCountry: 'ESA', sectors: ['government'], purpose: 'meteorological' },
  { id: 'dmsp', displayName: 'DMSP', prefixes: ['DMSP'],
    operatorOrg: 'US Space Force', operatorCountry: 'US', sectors: ['military'], purpose: 'meteorological' },
  { id: 'yunhai', displayName: 'Yunhai', prefixes: ['YUNHAI'],
    operatorOrg: 'PLA', operatorCountry: 'PRC', sectors: ['military'], purpose: 'meteorological' },
  { id: 'himawari', displayName: 'Himawari', prefixes: ['HIMAWARI'],
    operatorOrg: 'JMA', operatorCountry: 'JPN', sectors: ['government'], purpose: 'meteorological' },

  // ── Government / civil Earth observation ────────────────────────────────────
  { id: 'yaogan', displayName: 'Yaogan', prefixes: ['YAOGAN'],
    operatorOrg: 'PLA', operatorCountry: 'PRC', sectors: ['military'], purpose: 'earth_observation' },
  { id: 'gaofen', displayName: 'Gaofen', prefixes: ['GAOFEN', 'GAO FEN'],
    operatorOrg: 'CNSA', operatorCountry: 'PRC', sectors: ['government'], purpose: 'earth_observation' },
  { id: 'ziyuan', displayName: 'Ziyuan', prefixes: ['ZIYUAN', 'ZI YUAN'],
    operatorOrg: 'CNSA', operatorCountry: 'PRC', sectors: ['government'], purpose: 'earth_observation' },
  { id: 'tianhui', displayName: 'Tianhui', prefixes: ['TIANHUI'],
    operatorOrg: 'PLA', operatorCountry: 'PRC', sectors: ['military'], purpose: 'earth_observation' },
  { id: 'sentinel', displayName: 'Sentinel (Copernicus)', prefixes: ['SENTINEL'],
    operatorOrg: 'ESA / EU', operatorCountry: 'ESA', sectors: ['civil', 'government'], purpose: 'earth_observation' },
  { id: 'landsat', displayName: 'Landsat', prefixes: ['LANDSAT'],
    operatorOrg: 'NASA / USGS', operatorCountry: 'US', sectors: ['government', 'civil'], purpose: 'earth_observation' },

  // ── GEO comms operators ──────────────────────────────────────────────────────
  { id: 'intelsat', displayName: 'Intelsat', prefixes: ['INTELSAT', 'GALAXY'],
    operatorOrg: 'Intelsat', operatorCountry: 'ITSO', sectors: ['commercial'], purpose: 'communications' },
  { id: 'eutelsat', displayName: 'Eutelsat', prefixes: ['EUTELSAT', 'EUTE'],
    operatorOrg: 'Eutelsat', operatorCountry: 'EUTE', sectors: ['commercial'], purpose: 'communications' },
  { id: 'ses', displayName: 'SES / Astra', prefixes: ['SES', 'ASTRA'],
    operatorOrg: 'SES', operatorCountry: 'SES', sectors: ['commercial'], purpose: 'communications' },
  { id: 'o3b', displayName: 'O3b', prefixes: ['O3B'],
    operatorOrg: 'SES', operatorCountry: 'SES', sectors: ['commercial'], purpose: 'communications' },
  { id: 'telstar', displayName: 'Telstar / Anik', prefixes: ['TELSTAR', 'ANIK'],
    operatorOrg: 'Telesat', operatorCountry: 'CA', sectors: ['commercial'], purpose: 'communications' },
  { id: 'ekspress', displayName: 'Ekspress', prefixes: ['EKSPRESS', 'EXPRESS'],
    operatorOrg: 'RSCC', operatorCountry: 'CIS', sectors: ['commercial', 'government'], purpose: 'communications' },
  { id: 'jcsat', displayName: 'JCSAT', prefixes: ['JCSAT'],
    operatorOrg: 'SKY Perfect JSAT', operatorCountry: 'JPN', sectors: ['commercial'], purpose: 'communications' },
  { id: 'turksat', displayName: 'Türksat', prefixes: ['TURKSAT'],
    operatorOrg: 'Türksat', operatorCountry: 'TURK', sectors: ['commercial', 'government'], purpose: 'communications' },
  { id: 'chinasat', displayName: 'ChinaSat (Zhongxing)', prefixes: ['CHINASAT', 'ZHONGXING', 'ZX '],
    operatorOrg: 'China Satcom', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'communications' },
  { id: 'insat', displayName: 'INSAT / GSAT (India)', prefixes: ['INSAT'],
    operatorOrg: 'ISRO', operatorCountry: 'IND', sectors: ['government'],
    description: 'Purpose left unset — the series mixes comms and meteorology.' },
  { id: 'tdrs', displayName: 'TDRS', prefixes: ['TDRS'],
    operatorOrg: 'NASA', operatorCountry: 'US', sectors: ['government'], purpose: 'communications' },
  { id: 'skynet', displayName: 'Skynet', prefixes: ['SKYNET'],
    operatorOrg: 'UK MoD', operatorCountry: 'UK', sectors: ['military'], purpose: 'communications' },

  // ── Russian comms heritage ───────────────────────────────────────────────────
  { id: 'gonets', displayName: 'Gonets', prefixes: ['GONETS'],
    operatorOrg: 'Gonets SatCom', operatorCountry: 'CIS', sectors: ['government'], purpose: 'communications' },
  { id: 'strela', displayName: 'Strela', prefixes: ['STRELA'],
    operatorOrg: 'VKS', operatorCountry: 'CIS', sectors: ['military'], purpose: 'communications' },
  { id: 'molniya', displayName: 'Molniya', prefixes: ['MOLNIYA'],
    operatorCountry: 'CIS', sectors: ['military', 'government'], purpose: 'communications' },
  { id: 'raduga', displayName: 'Raduga', prefixes: ['RADUGA'],
    operatorCountry: 'CIS', sectors: ['military', 'government'], purpose: 'communications' },
  { id: 'gorizont', displayName: 'Gorizont', prefixes: ['GORIZONT'],
    operatorCountry: 'CIS', sectors: ['government'], purpose: 'communications' },
  { id: 'ekran', displayName: 'Ekran', prefixes: ['EKRAN'],
    operatorCountry: 'CIS', sectors: ['government'], purpose: 'communications' },

  // ── Chinese experimental series ──────────────────────────────────────────────
  { id: 'shiyan', displayName: 'Shiyan', prefixes: ['SHIYAN', 'SY-'],
    operatorCountry: 'PRC', sectors: ['government'], purpose: 'technology_dev' },
  { id: 'shijian', displayName: 'Shijian', prefixes: ['SHIJIAN', 'SHI JIAN', 'SJ-'],
    operatorCountry: 'PRC', sectors: ['government'], purpose: 'technology_dev' },
  { id: 'tjs', displayName: 'TJS (Tongxin Jishu Shiyan)', prefixes: ['TJS', 'TONGXIN JISHU SHIYAN'],
    operatorCountry: 'PRC', sectors: ['government'], purpose: 'technology_dev' },
  { id: 'hulianwang-shiyan', displayName: 'Hulianwang Shiyan', prefixes: ['HULIANWANG JISHU'],
    operatorCountry: 'PRC', sectors: ['government'], purpose: 'technology_dev',
    description: 'SatNet comm-technology test satellites (distinct from the Guowang Digui operational shells).' },

  // ── US military space ────────────────────────────────────────────────────────
  { id: 'sda', displayName: 'SDA (PWSA)', prefixes: ['SDA', 'PRAETORIAN SDA', 'TRANCHE'],
    operatorOrg: 'Space Development Agency', operatorCountry: 'US', sectors: ['military'],
    description: 'Proliferated Warfighter Space Architecture tranches.' },
  { id: 'dsp', displayName: 'DSP', prefixes: ['DSP'],
    operatorOrg: 'US Space Force', operatorCountry: 'US', sectors: ['military'], purpose: 'surveillance',
    description: 'Defense Support Program missile-warning satellites.' },
  { id: 'dscs', displayName: 'DSCS', prefixes: ['DSCS'],
    operatorOrg: 'US Space Force', operatorCountry: 'US', sectors: ['military'], purpose: 'communications' },

  // ── Ambiguous catch-alls — MEMBERSHIP ONLY or sector-only, no purpose ────────
  { id: 'cosmos', displayName: 'Kosmos', prefixes: ['COSMOS', 'KOSMOS'],
    description: 'Soviet/Russian catch-all designation spanning military, civil, science and navigation — membership only, no facet defaults. NOTE: GLONASS hides in here on BOTH sources (McDowell names them Kosmos-NNNN too); pulling it out needs orbit-based disambiguation (Kosmos payload @ ~19,100 km MEO), a possible Phase-2 refinement.' },
  { id: 'usa', displayName: 'USA (DoD series)', prefixes: ['USA'],
    operatorCountry: 'US', sectors: ['military'],
    description: 'US DoD numbered designation series — sector is near-certain, mission purpose is not.' },
  { id: 'ops', displayName: 'OPS (DoD series)', prefixes: ['OPS'],
    operatorCountry: 'US', sectors: ['military'],
    description: 'Pre-1984 US DoD designation series.' },
];

// ── Compiled matcher ──────────────────────────────────────────────────────────
// Runs 30k×/cron: normalize → exact first-token bucket → startsWith verify →
// tiny residual regex pass. Registry order is preserved inside each bucket and
// in the regex list, so "first entry wins" holds for overlapping prefixes.

interface CompiledMatcher {
  byToken: Map<string, { entry: ProgramEntry; prefix: string; order: number }[]>;
  regexes: { entry: ProgramEntry; re: RegExp; order: number }[];
}

let compiled: CompiledMatcher | null = null;

/** Uppercase + collapse runs of whitespace (McDowell/Space-Track casing differ). */
function normalizeName(name: string): string {
  return name.toUpperCase().replace(/\s+/g, ' ').trim();
}

/** First token of a normalized name — the segment before the first space or hyphen. */
function firstToken(normalized: string): string {
  const m = normalized.match(/^[^ -]+/);
  return m ? m[0] : normalized;
}

function compile(): CompiledMatcher {
  const byToken: CompiledMatcher['byToken'] = new Map();
  const regexes: CompiledMatcher['regexes'] = [];
  PROGRAMS.forEach((entry, order) => {
    for (const raw of entry.prefixes) {
      const prefix = normalizeName(raw);
      const token = firstToken(prefix);
      const bucket = byToken.get(token) ?? [];
      bucket.push({ entry, prefix, order });
      byToken.set(token, bucket);
    }
    for (const re of entry.regexes ?? []) regexes.push({ entry, re, order });
  });
  // Keep registry order deterministic within buckets (forEach preserves it) and
  // sort regexes by registry order for the same first-wins guarantee.
  regexes.sort((a, b) => a.order - b.order);
  return { byToken, regexes };
}

/**
 * Match an object name to a program. Callers gate to payloads — the matcher
 * itself happily matches "FENGYUN 1C DEB".
 */
export function matchProgram(name: string): ProgramEntry | null {
  if (!name) return null;
  compiled ??= compile();
  const normalized = normalizeName(name);

  const bucket = compiled.byToken.get(firstToken(normalized));
  let best: { entry: ProgramEntry; order: number } | null = null;
  if (bucket) {
    for (const cand of bucket) {
      if (normalized.startsWith(cand.prefix) && (!best || cand.order < best.order)) {
        best = cand;
      }
    }
  }
  for (const { entry, re, order } of compiled.regexes) {
    if (best && best.order <= order) break; // regexes are order-sorted
    if (re.test(normalized)) { best = { entry, order }; break; }
  }
  return best?.entry ?? null;
}

/**
 * Stamp program membership + fill ONLY-empty facets from the entry's defaults.
 * The single source of truth for precedence: UCS/satcat values always survive.
 * Sets facetProvenance keys for every facet it fills and appends 'inferred' to
 * sources (once). Mutates rec — build-time use; the runtime store composes
 * fresh objects instead of calling this on cached records.
 */
export function applyProgramDefaults(rec: ObjectMetadata, entry: ProgramEntry): void {
  rec.program = entry.id;

  const prov: FacetProvenance = {};
  if (rec.sectors.length === 0 && entry.sectors && entry.sectors.length > 0) {
    rec.sectors = [...entry.sectors];
    prov.sectors = 'inferred';
  }
  if (rec.purpose === 'other' && entry.purpose) {
    rec.purpose = entry.purpose;
    prov.purpose = 'inferred';
  }
  if (!rec.operatorCountry && entry.operatorCountry) {
    rec.operatorCountry = entry.operatorCountry;
    prov.country = 'inferred';
  }
  if (!rec.operatorOrg && entry.operatorOrg) {
    rec.operatorOrg = entry.operatorOrg;
    prov.org = 'inferred';
  }

  // Never assign an empty {} — slim() drops nulls/empty arrays, not objects.
  if (Object.keys(prov).length > 0) {
    rec.facetProvenance = { ...rec.facetProvenance, ...prov };
  }
  if (!rec.sources.includes('inferred')) rec.sources.push('inferred');
}
