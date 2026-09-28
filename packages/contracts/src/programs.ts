// ============================================================
// @orbitwatch/contracts — programs.ts
//
// Program registry slug → display name. Step C2a of
// PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md. Before this step there were
// THREE independently-maintained copies of this table: frontend
// `data/metadata-types.ts`'s `PROGRAM_LABELS`, backend `enrichment/programs.ts`'s
// per-entry `displayName` field, and backend `analytic/providers/enrichment.ts`'s
// `PROGRAM_LABELS` map (itself built FROM programs.ts's `displayName`, so not
// an independent copy, but a 3rd read site). A byte-for-byte diff of the first
// two (72/72 keys, same order, identical strings — see the C2a report) found
// ZERO differences, so this table is a lossless merge, not a policy choice.
// `id`/`displayName` is dropped from backend `ProgramEntry` in favor of
// `id: ProgramId` here + a `PROGRAM_LABELS` lookup at read sites.
// ============================================================

export const PROGRAM_LABELS = {
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
} as const;

export type ProgramId = keyof typeof PROGRAM_LABELS;

export const PROGRAM_IDS = Object.keys(PROGRAM_LABELS) as ProgramId[];
