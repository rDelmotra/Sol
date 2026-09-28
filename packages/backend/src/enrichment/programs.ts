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

import type { FacetProvenance, ObjectMetadata, Purpose, ProgramId, Sector } from '@orbitwatch/contracts';

export interface ProgramEntry {
  id: ProgramId;               // registry slug, e.g. 'starlink' — display label lives in @orbitwatch/contracts PROGRAM_LABELS
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
  { id: 'starlink', prefixes: ['STARLINK'],
    operatorOrg: 'SpaceX', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications',
    description: 'SpaceX broadband megaconstellation (incl. Direct-to-Cell).' },
  { id: 'oneweb', prefixes: ['ONEWEB'],
    operatorOrg: 'Eutelsat OneWeb', operatorCountry: 'UK', sectors: ['commercial'], purpose: 'communications' },
  { id: 'kuiper', prefixes: ['KUIPER'],
    operatorOrg: 'Amazon', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'qianfan', prefixes: ['QIANFAN'],
    operatorOrg: 'SSST', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'communications',
    description: 'Shanghai Spacecom "Thousand Sails" broadband constellation.' },
  { id: 'guowang', prefixes: ['HULIANWANG DIGUI', 'WHDW'],
    operatorOrg: 'China SatNet', operatorCountry: 'PRC', sectors: ['government'], purpose: 'communications',
    description: 'Chinese national broadband constellation (Hulianwang Digui / WHDW).' },
  { id: 'iridium', prefixes: ['IRIDIUM'],
    operatorOrg: 'Iridium Communications', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'globalstar', prefixes: ['GLOBALSTAR'],
    operatorOrg: 'Globalstar', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'orbcomm', prefixes: ['ORBCOMM'],
    operatorOrg: 'Orbcomm', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'spacebee', prefixes: ['SPACEBEE'],
    operatorOrg: 'Swarm Technologies', operatorCountry: 'US', sectors: ['commercial'], purpose: 'communications' },
  { id: 'kineis', prefixes: ['KINEIS'],
    operatorOrg: 'Kinéis', operatorCountry: 'FR', sectors: ['commercial'], purpose: 'communications' },
  { id: 'tianqi', prefixes: ['TIANQI'],
    operatorOrg: 'Guodian Gaoke', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'communications' },
  { id: 'sitro-ais', prefixes: ['SITRO-AIS'],
    operatorOrg: 'Sitronics', operatorCountry: 'CIS', sectors: ['commercial'], purpose: 'communications' },

  // ── Commercial Earth observation ─────────────────────────────────────────────
  { id: 'flock', prefixes: ['FLOCK'],
    operatorOrg: 'Planet Labs', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'skysat', prefixes: ['SKYSAT'],
    operatorOrg: 'Planet Labs', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'lemur', prefixes: ['LEMUR'],
    operatorOrg: 'Spire Global', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'jilin', prefixes: ['JILIN'],
    operatorOrg: 'Chang Guang', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'hawkeye', prefixes: ['HAWK'],
    operatorOrg: 'HawkEye 360', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'bro', prefixes: ['BRO'],
    operatorOrg: 'Unseenlabs', operatorCountry: 'FR', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'blacksky', prefixes: ['GLOBAL'],
    operatorOrg: 'BlackSky', operatorCountry: 'US', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'yunyao', prefixes: ['YUNYAO'],
    operatorOrg: 'Yunyao Yuhang', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'meteorological' },
  { id: 'geesat', prefixes: ['GEESAT', 'GEELY XINGZUO', 'GEELY'],
    operatorOrg: 'Geespace', operatorCountry: 'PRC', sectors: ['commercial'] },
  { id: 'iceye', prefixes: ['ICEYE'],
    operatorOrg: 'ICEYE', operatorCountry: 'FIN', sectors: ['commercial'], purpose: 'earth_observation' },
  { id: 'tianmu', prefixes: ['TIANMU'],
    operatorOrg: 'Xiyong Micro-Electronics', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'meteorological',
    description: 'GNSS radio-occultation weather constellation.' },
  { id: 'iride', prefixes: ['IRIDE'],
    operatorOrg: 'ASI / ESA', operatorCountry: 'IT', sectors: ['government', 'civil'], purpose: 'earth_observation' },

  // ── Navigation ───────────────────────────────────────────────────────────────
  { id: 'gps', prefixes: ['NAVSTAR', 'GPS'],
    operatorOrg: 'US Space Force', operatorCountry: 'US', sectors: ['military', 'government'], purpose: 'navigation' },
  { id: 'galileo', prefixes: ['GALILEOSAT'],
    regexes: [/^GSAT0\d{3}/, /\(GALILEO/],
    operatorOrg: 'EUSPA / ESA', operatorCountry: 'ESA', sectors: ['civil', 'government'], purpose: 'navigation',
    description: 'Regexes cover Space-Track "GSAT0219 (GALILEO 23)"; must not match India\'s GSAT-nn.' },
  { id: 'beidou', prefixes: ['BEIDOU'],
    operatorOrg: 'CNSA', operatorCountry: 'PRC', sectors: ['government', 'military'], purpose: 'navigation' },
  { id: 'navic', prefixes: ['IRNSS', 'NVS-'],
    operatorOrg: 'ISRO', operatorCountry: 'IND', sectors: ['government'], purpose: 'navigation' },
  { id: 'transit', prefixes: ['NNS'],
    operatorOrg: 'US Navy', operatorCountry: 'US', sectors: ['military'], purpose: 'navigation' },

  // ── Meteorological ───────────────────────────────────────────────────────────
  { id: 'fengyun', prefixes: ['FENGYUN', 'FENG YUN'],
    operatorOrg: 'CMA', operatorCountry: 'PRC', sectors: ['government'], purpose: 'meteorological' },
  { id: 'meteor', prefixes: ['METEOR'],
    operatorOrg: 'Roshydromet', operatorCountry: 'CIS', sectors: ['government'], purpose: 'meteorological' },
  { id: 'noaa', prefixes: ['NOAA'],
    operatorOrg: 'NOAA', operatorCountry: 'US', sectors: ['government'], purpose: 'meteorological' },
  { id: 'goes', prefixes: ['GOES'],
    operatorOrg: 'NOAA', operatorCountry: 'US', sectors: ['government'], purpose: 'meteorological' },
  { id: 'metop', prefixes: ['METOP'],
    operatorOrg: 'EUMETSAT', operatorCountry: 'ESA', sectors: ['government'], purpose: 'meteorological' },
  { id: 'meteosat', prefixes: ['METEOSAT'],
    operatorOrg: 'EUMETSAT', operatorCountry: 'ESA', sectors: ['government'], purpose: 'meteorological' },
  { id: 'dmsp', prefixes: ['DMSP'],
    operatorOrg: 'US Space Force', operatorCountry: 'US', sectors: ['military'], purpose: 'meteorological' },
  { id: 'yunhai', prefixes: ['YUNHAI'],
    operatorOrg: 'PLA', operatorCountry: 'PRC', sectors: ['military'], purpose: 'meteorological' },
  { id: 'himawari', prefixes: ['HIMAWARI'],
    operatorOrg: 'JMA', operatorCountry: 'JPN', sectors: ['government'], purpose: 'meteorological' },

  // ── Government / civil Earth observation ────────────────────────────────────
  { id: 'yaogan', prefixes: ['YAOGAN'],
    operatorOrg: 'PLA', operatorCountry: 'PRC', sectors: ['military'], purpose: 'earth_observation' },
  { id: 'gaofen', prefixes: ['GAOFEN', 'GAO FEN'],
    operatorOrg: 'CNSA', operatorCountry: 'PRC', sectors: ['government'], purpose: 'earth_observation' },
  { id: 'ziyuan', prefixes: ['ZIYUAN', 'ZI YUAN'],
    operatorOrg: 'CNSA', operatorCountry: 'PRC', sectors: ['government'], purpose: 'earth_observation' },
  { id: 'tianhui', prefixes: ['TIANHUI'],
    operatorOrg: 'PLA', operatorCountry: 'PRC', sectors: ['military'], purpose: 'earth_observation' },
  { id: 'sentinel', prefixes: ['SENTINEL'],
    operatorOrg: 'ESA / EU', operatorCountry: 'ESA', sectors: ['civil', 'government'], purpose: 'earth_observation' },
  { id: 'landsat', prefixes: ['LANDSAT'],
    operatorOrg: 'NASA / USGS', operatorCountry: 'US', sectors: ['government', 'civil'], purpose: 'earth_observation' },

  // ── GEO comms operators ──────────────────────────────────────────────────────
  { id: 'intelsat', prefixes: ['INTELSAT', 'GALAXY'],
    operatorOrg: 'Intelsat', operatorCountry: 'ITSO', sectors: ['commercial'], purpose: 'communications' },
  { id: 'eutelsat', prefixes: ['EUTELSAT', 'EUTE'],
    operatorOrg: 'Eutelsat', operatorCountry: 'EUTE', sectors: ['commercial'], purpose: 'communications' },
  { id: 'ses', prefixes: ['SES', 'ASTRA'],
    operatorOrg: 'SES', operatorCountry: 'SES', sectors: ['commercial'], purpose: 'communications' },
  { id: 'o3b', prefixes: ['O3B'],
    operatorOrg: 'SES', operatorCountry: 'SES', sectors: ['commercial'], purpose: 'communications' },
  { id: 'telstar', prefixes: ['TELSTAR', 'ANIK'],
    operatorOrg: 'Telesat', operatorCountry: 'CA', sectors: ['commercial'], purpose: 'communications' },
  { id: 'ekspress', prefixes: ['EKSPRESS', 'EXPRESS'],
    operatorOrg: 'RSCC', operatorCountry: 'CIS', sectors: ['commercial', 'government'], purpose: 'communications' },
  { id: 'jcsat', prefixes: ['JCSAT'],
    operatorOrg: 'SKY Perfect JSAT', operatorCountry: 'JPN', sectors: ['commercial'], purpose: 'communications' },
  { id: 'turksat', prefixes: ['TURKSAT'],
    operatorOrg: 'Türksat', operatorCountry: 'TURK', sectors: ['commercial', 'government'], purpose: 'communications' },
  { id: 'chinasat', prefixes: ['CHINASAT', 'ZHONGXING', 'ZX '],
    operatorOrg: 'China Satcom', operatorCountry: 'PRC', sectors: ['commercial'], purpose: 'communications' },
  { id: 'insat', prefixes: ['INSAT'],
    operatorOrg: 'ISRO', operatorCountry: 'IND', sectors: ['government'],
    description: 'Purpose left unset — the series mixes comms and meteorology.' },
  { id: 'tdrs', prefixes: ['TDRS'],
    operatorOrg: 'NASA', operatorCountry: 'US', sectors: ['government'], purpose: 'communications' },
  { id: 'skynet', prefixes: ['SKYNET'],
    operatorOrg: 'UK MoD', operatorCountry: 'UK', sectors: ['military'], purpose: 'communications' },

  // ── Russian comms heritage ───────────────────────────────────────────────────
  { id: 'gonets', prefixes: ['GONETS'],
    operatorOrg: 'Gonets SatCom', operatorCountry: 'CIS', sectors: ['government'], purpose: 'communications' },
  { id: 'strela', prefixes: ['STRELA'],
    operatorOrg: 'VKS', operatorCountry: 'CIS', sectors: ['military'], purpose: 'communications' },
  { id: 'molniya', prefixes: ['MOLNIYA'],
    operatorCountry: 'CIS', sectors: ['military', 'government'], purpose: 'communications' },
  { id: 'raduga', prefixes: ['RADUGA'],
    operatorCountry: 'CIS', sectors: ['military', 'government'], purpose: 'communications' },
  { id: 'gorizont', prefixes: ['GORIZONT'],
    operatorCountry: 'CIS', sectors: ['government'], purpose: 'communications' },
  { id: 'ekran', prefixes: ['EKRAN'],
    operatorCountry: 'CIS', sectors: ['government'], purpose: 'communications' },

  // ── Chinese experimental series ──────────────────────────────────────────────
  { id: 'shiyan', prefixes: ['SHIYAN', 'SY-'],
    operatorCountry: 'PRC', sectors: ['government'], purpose: 'technology_dev' },
  { id: 'shijian', prefixes: ['SHIJIAN', 'SHI JIAN', 'SJ-'],
    operatorCountry: 'PRC', sectors: ['government'], purpose: 'technology_dev' },
  { id: 'tjs', prefixes: ['TJS', 'TONGXIN JISHU SHIYAN'],
    operatorCountry: 'PRC', sectors: ['government'], purpose: 'technology_dev' },
  { id: 'hulianwang-shiyan', prefixes: ['HULIANWANG JISHU'],
    operatorCountry: 'PRC', sectors: ['government'], purpose: 'technology_dev',
    description: 'SatNet comm-technology test satellites (distinct from the Guowang Digui operational shells).' },

  // ── US military space ────────────────────────────────────────────────────────
  { id: 'sda', prefixes: ['SDA', 'PRAETORIAN SDA', 'TRANCHE'],
    operatorOrg: 'Space Development Agency', operatorCountry: 'US', sectors: ['military'],
    description: 'Proliferated Warfighter Space Architecture tranches.' },
  { id: 'dsp', prefixes: ['DSP'],
    operatorOrg: 'US Space Force', operatorCountry: 'US', sectors: ['military'], purpose: 'surveillance',
    description: 'Defense Support Program missile-warning satellites.' },
  { id: 'dscs', prefixes: ['DSCS'],
    operatorOrg: 'US Space Force', operatorCountry: 'US', sectors: ['military'], purpose: 'communications' },

  // ── Ambiguous catch-alls — MEMBERSHIP ONLY or sector-only, no purpose ────────
  { id: 'cosmos', prefixes: ['COSMOS', 'KOSMOS'],
    description: 'Soviet/Russian catch-all designation spanning military, civil, science and navigation — membership only, no facet defaults. NOTE: GLONASS hides in here on BOTH sources (McDowell names them Kosmos-NNNN too); pulling it out needs orbit-based disambiguation (Kosmos payload @ ~19,100 km MEO), a possible Phase-2 refinement.' },
  { id: 'usa', prefixes: ['USA'],
    operatorCountry: 'US', sectors: ['military'],
    description: 'US DoD numbered designation series — sector is near-certain, mission purpose is not.' },
  { id: 'ops', prefixes: ['OPS'],
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
