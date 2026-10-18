# 01 - Code inventory for the world-model redesign

Worktree: `.claude/worktrees/marvin-fabric`, branch `marvin/fabric`, commit `fa7f4c3`.
Every claim has `path:line` that I read. "unverified" marks what I could not confirm.
Path key for bare file names: `tle.ts metadata.ts dso.ts api.ts enums.ts countries.ts` = `packages/contracts/src/`; `store.ts` = `packages/backend/src/enrichment/store.ts` except where the DSO snapshot store is named in full; `catalog.ts enrichment.ts sgp4.ts space-weather.ts` = `packages/backend/src/analytic/providers/`; `registry.ts server-source.ts` = `packages/backend/src/analytic/`; `schema.ts types.ts validate.ts execute.ts capability.ts wire.ts` = `packages/analytic/src/` (in section C); `inherit.ts` = `packages/backend/src/enrichment/gcat/inherit.ts`; `tle-updater.ts` = `packages/backend/src/cron/tle-updater.ts`; `file-cache.ts` = `packages/backend/src/cache/file-cache.ts`.
Status: complete; all sections filled and citation-checked (see the verification note at the end of the file).

## 0. Orientation (state/ docs)

- `state/DECISIONS.md:14-20` (D3): browser is an abstract end entity; client/server routing is implicit (not a hand-kept list, no routing manifest); answers exact, instant and pushed; "Many entity types are coming."
- `state/OPEN.md:19-20`: the redesign is marked in code by 2 known violations in `tests/architecture.test.ts` and by the hand-kept list in `packages/analytic/src/capability.ts`.
- Quick facts (each repeated with detail in A-E below):
  - `packages/contracts/src/tle.ts:20-49` EnrichedTLEObject; `packages/contracts/src/metadata.ts:50-115` ObjectMetadata; `packages/contracts/src/dso.ts:14-94` DSO shapes; `api.ts:77-117` LaunchRecord/OrgRecord.
  - Measured: `packages/backend/enrichment-data/metadata-enrichment.json.gz` = 69,242 NORAD-keyed records (meta.recordCount), launches.json 6,878, orgs.json 2,045, decayed-catalog.json 34,392 rows, query-vocab.json launches 6,878 / orgs 1,147 / owners 1,005.
  - 596 GCAT satcat rows have no NORAD id and are dropped (`gcat-mapping-report.json` skippedNoNorad; code `packages/backend/tools/enrichment/gcat/ingest.ts:98-102`).

## A. Entity types

Conventions. "measured" = I computed it from a committed file with a read-only python one-liner. A path with no number is a whole-file claim. "No entity" = the concept exists only as a string/number on another record.

### A.0 Index (one row per kind of thing)

| # | Kind of thing | Has own record type? | Identifier | Count | Space | Time |
|---|---|---|---|---|---|---|
| A1 | Catalog object (live row) | yes `EnrichedTLEObject` | `noradId: number` | ~32k live (unverified now; `packages/backend/src/services/analytic-prompt.ts:39`, `packages/frontend/src/engine/resident/ResidentSet.ts:79` say 32,393 on 2026-09-09) | moving, TEME, computed from A2 | `epoch` ISO string; replaced daily |
| A2 | Element set (OMM) | embedded `omm` / history row | none; implied `(noradId, epoch)` | 1 per live object | defines the orbit | versioned (history keeps 1 per object per UTC day) |
| A3 | Object metadata (GCAT+UCS) + decayed projection | yes `ObjectMetadata`, `DecayedCatalogRow` | `noradId` (+`jcat`, `cospar`) | 69,242 / 34,392 (measured) | none | static snapshot 2026-07-03 |
| A4 | Deep-space object (DSO) | yes (4 shapes) | `dsoId` slug + Horizons id | 5 in registry, 1 enabled | moving, TEME | validity window; replaced every 6 h |
| A5 | DSO ephemeris snapshot | yes `DsoSnapshot` | `(dsoId, snapshotVersion)` | newest 3 files kept | TEME ER samples | ISO per sample |
| A6 | Launch | yes `LaunchRecord` | `tag` ("1998-067") | 6,878 (measured) | none (site name only) | raw vague date string |
| A7 | Organization | yes `OrgRecord` | `code` ("SPXS") | 2,045 (measured) | lat/lon stored, not exposed | `tstart`/`tstop` strings |
| A8 | Program / constellation | partly (registry + label table) | slug ("starlink") | 72 registry, 71 seen in data (measured) | none | none |
| A9 | Launch vehicle | NO | `lvType` string | 398 distinct types, 73 families (measured) | none | none |
| A10 | Launch site / pad | NO | `site` code, `siteName`, `pad` | 54 codes, 43 names, 238 site+pad (measured) | none stored | none |
| A11 | Country | NO (code + 27-row display table) | canonical string ("US","PRC") | 123 distinct codes in data, 101 among in-orbit (measured) | none | none |
| A12 | Separation-tree node | NO (pointer on A3) | `jcat` ("S25544") | 69,130 nodes in map; 7,481 distinct parents outside map (measured) | none | none |
| A13 | Observer / ground location | NO (5 tuple shapes) | none | n/a | WGS84 geodetic, static | `savedAt` for the cached fix |
| A14 | Gazetteer place | yes (backend only) | `sourceId` "ne:<id>" | 7,342 per source comment (unverified now) | WGS84 lat/lon | none |
| A15 | Space-weather daily index | yes `SwpcDailyIndex` | UTC date string | trailing ~30 days | none (global) | per UTC day |
| A16 | Curated naked-eye list | yes (set of ids) | member `noradId` | ~150-200 (unverified; CLAUDE.md) | none | version = fetch ISO |
| A17 | History day snapshot | yes (2 tables + gz archive) | `(norad_id, utc_day)` | DB optional | via A2 | daily |
| A18 | Sun / Moon / stars / Earth | NO (functions + constants) | none | Sun: direction fn only | n/a | n/a |
| A19 | Simulation / view time | singleton | none | 1 | n/a | epoch ms |
| A20 | Analytic program / answer | yes (`AnalyticProgram`, `AnalyticResult`) | program hash (frontend) / sha256 (backend cache key) | LRU 500 | n/a | `timeBinding` |
| A21 | Selection / focus | store fields | `selectedIndex` (array index!) | 1 | n/a | n/a |

### A.1 Cards

#### A1. Catalog object (live)
- **Shape**: `packages/contracts/src/tle.ts:20-49` (`EnrichedTLEObject`: noradId, name, omm, objectType, category, regime, countryCode, launchDate, period, apogee, perigee, inclination, rcsSize, epoch, sectors, purpose, status; optional program, launchTag, owner).
- **Identifier**: `noradId: number` (`tle.ts:21`), parsed from Space-Track's string `NORAD_CAT_ID` (`packages/backend/src/cron/tle-updater.ts:110`). Same integer keys every store: enrichment `Map<number,...>` (`packages/backend/src/enrichment/store.ts:41`), history `norad_id INTEGER PRIMARY KEY` (`packages/backend/src/history/db/migrations/0001_init.ts:24`), analytic IR (`packages/analytic/src/schema.ts:83`). COSPAR is only inside `omm.OBJECT_ID` (`packages/backend/src/utils/omm.ts:69`), not a top-level field. Ids >= 100000 exist only in CelesTrak JSON (`tle-updater.ts:157-158`); the enrichment map's max id is 69,793 (measured).
- **Runtime / at rest**: backend `<CACHE_DIR>/tle-cache.json` + `version.json` (`packages/backend/src/cache/file-cache.ts:43-49`, atomic write `:176-200`); in-memory pre-gzipped/brotli payload (`packages/backend/src/cache/tle-payload-cache.ts:30-40`); each analytic provider keeps its own parsed copy (`packages/backend/src/analytic/providers/catalog.ts:55-66`, `.../sgp4.ts:58-94`). Browser: IndexedDB cache, 7-day TTL (`packages/frontend/src/data/tle-client.ts:31`), Zustand `catalogData` (`packages/frontend/src/store/types.ts:126`), SGP4 worker buffers (`packages/frontend/src/workers/sgp4-protocol.ts:17-27`).
- **Fields**: see definition. Derived-and-stored scalars (period, apogee, perigee, inclination, regime) are computed at cron time (`tle-updater.ts:84-135`); `category` is `unknown` for every payload because no ops-status code is ever passed (`tle-updater.ts:93-97`, `packages/backend/src/services/classifier.ts:84-99`).
- **SPACE**: moving, TEME frame, earth-radii (`packages/orbital-core/src/live-plane.ts:28-32`). Computed (never stored) from A2 by SGP4: Rust/WASM batch in the worker (`packages/frontend/src/workers/sgp4.worker.ts:188`, crate `packages/wasm-sgp4/src/lib.rs:87`), satellite.js per object on the backend (`packages/backend/src/analytic/providers/sgp4.ts:96-137`). Valid only within +-60 days of the elset epoch (`packages/orbital-core/src/propagation-window.ts:32`); render horizon forward 14 days (`:29`).
- **TIME**: `epoch` is an ISO string with `Z` (`tle-updater.ts:60-64`, `tle.ts:34`). Whole-catalog version = ISO write time (`file-cache.ts:181`). The live file keeps only the latest elset (replace on write); history keeps one per UTC day (A17).
- **LINKS**: `launchTag` to A6 (`tle.ts:46`), `owner` org code to A7 (`tle.ts:48`), `program` slug to A8 (`tle.ts:43`), `countryCode` to A11 (`tle.ts:27`). No `jcat`/`parentJcat` inline (`tle.ts:44-48`), so the separation tree is not reachable from the wire row.
- **SOURCE / cadence**: Space-Track GP, query "no decay date, epoch within 30 days" (`packages/backend/src/services/spacetrack.ts:32-40`), daily 02:00 UTC cron (`tle-updater.ts:54`) plus boot and retry-timer cycles; CelesTrak `GROUP=active` overlay as fallback (`packages/backend/src/services/celestrak.ts`, `packages/backend/src/cache/catalog-overlay.ts`).
- **Perceptor**: catalog plane 24 fields + live plane 5 fields (`schema.ts:83-135`); this array is the `live` universe spine (`catalog.ts:118-121`).

#### A2. Element set (OMM)
- **Shape**: satellite.js `OMMJsonObject`, re-exported at `packages/contracts/src/tle.ts:13-17`; built by `buildOmm` (`packages/backend/src/utils/omm.ts:44-86`). CelesTrak sends exactly these 17 keys (`packages/backend/src/types/index.ts:62-79`).
- **Identifier**: none of its own. `ELEMENT_SET_NO` and `REV_AT_EPOCH` are carried (`omm.ts:80-81`) but nothing keys on them. In history the key is `UNIQUE (norad_id, utc_day)` (`0001_init.ts:58`).
- **Runtime / at rest**: field `omm` of A1; history `omm_daily` typed columns (`0001_init.ts:34-59`); raw provider JSON in `<historyArchiveDir>/YYYY-MM-DD.json.gz` (`packages/backend/src/history/archive/raw-writer.ts:40-52`), write-only: no code reads it back (grep: only `raw-writer.ts` references the dir).
- **SPACE / TIME**: orbit definition in TEME via SGP4; time-varying but only one version is live. History daily upsert keeps the later epoch: `WHERE EXCLUDED.epoch > omm_daily.epoch` (`packages/backend/src/history/db/queries.ts:86-109`). The day bucket is the UTC day of the elset EPOCH, not the fetch day (`packages/backend/src/history/ingest/map.ts:55`).
- **Perceptor**: 13 mean-element fields (`schema.ts:103-115`). Only the current elset is queryable; the compiler prompt says so (`packages/backend/src/services/analytic-prompt.ts:531`).

#### A3. Object metadata record (GCAT + UCS enrichment) and decayed projection
- **Shape**: `packages/contracts/src/metadata.ts:50-115` (`ObjectMetadata`); compact inline projection `:121-139`; decayed row `:146-154`.
- **Identifier**: `noradId` (`:51`); also `jcat` (GCAT id, `:82`) and `cospar` (`:76`). 69,242 records (artifact meta `recordCount`, measured); `jcat` on 69,130, none on 112 UCS-only records (measured). GCAT rows with no NORAD id are dropped: 596 (`packages/backend/tools/enrichment/gcat/ingest.ts:98-102`; `gcat-mapping-report.json` `skippedNoNorad`, measured), plus 600 psatcat rows unjoined (`psatcatUnjoined`), plus 10 NORAD collisions resolved by picking one row (`ingest.ts:107-111`).
- **Runtime / at rest**: committed `packages/backend/enrichment-data/metadata-enrichment.json.gz` (2.88 MB), gunzipped into `Map<number, ObjectMetadata>` at boot (`packages/backend/src/enrichment/store.ts:48-75`). Only the compact facets are copied onto A1 at cron time (`store.ts:99-149`); the rest is served lazily by `GET /api/metadata/:noradId` (`packages/backend/src/routes/metadata.ts:42-78`), which the website never calls (`state/OPEN.md:66`). Decayed projection: `decayed-catalog.json` 4.8 MB, 34,392 rows = 33,032 decayed + 1,259 deorbited + 101 exploded (measured), loaded by `store.ts:217-233`, served at `routes/metadata.ts:123-142`.
- **Fields (measured over 69,242)**: `orbitalStatus` in_orbit 34,210 / decayed 33,032 / deorbited 1,259 / beyond_earth 506 / unknown 134 / exploded 101; `objectType` debris 27,849 / payload 27,052 / component 7,919 / rocket_body 6,285 / unknown 137; `operationalStatus` unknown 42,103 / operational 15,720 / nonoperational 11,419; `program` present on 53,493; `gcatProgram` 47,488; masses ~37k; `contractor`/`launchSite`/`launchVehicle` (UCS free text) 7,551.
- **SPACE**: none (`orbitClass` is a text label like "LLEO/I", `metadata.ts:78`). **TIME**: static snapshot, GCAT "2026 Jul  3 2203:53", UCS 2023-05-01 (artifact meta, measured); GCAT dates kept as raw vague strings (`metadata.ts:85`, `:99-102`); no build timestamp on purpose (`packages/backend/src/enrichment/types.ts:68-72`).
- **LINKS**: `launchTag` to A6, `gcat.owner`/`gcat.manufacturer` org codes to A7 (all 1,397 owner codes resolve in orgs.json, measured), `parentJcat` to A12, `program` to A8, `operatorCountry` to A11. Provenance per facet: `facetProvenance` + `sources[]` (`metadata.ts:21-27, 114`; domain `packages/contracts/src/enums.ts:150-157`).
- **SOURCE**: GCAT (McDowell, CC-BY) + UCS + name-prefix program inference (`packages/backend/src/enrichment/programs.ts:265-284`) + graph inheritance passes (`packages/backend/src/enrichment/gcat/inherit.ts:63-190`). Built offline by `npm run enrichment:build -w packages/backend`; never refreshed at runtime.
- **Perceptor**: static plane (35 fields); universe `all` spine = catalog ids union enrichment ids (`catalog.ts:152-155`); for dead objects only `name`, `countryCode`, `launchYear` come from the decayed row (`catalog.ts:167-176`).

#### A4. Deep-space object (DSO)
- **Shapes**: backend config `DsoRegistryEntry` (`packages/backend/src/dso/registry/types.ts:20-37`); served `DsoCatalogEntry` (`packages/contracts/src/dso.ts:53-67`); status `DsoObjectStatus` (`:69-82`); frontend merge `DsoObject` (`packages/frontend/src/data/dso-types.ts:18-29`); ended flag `DsoEndedRecord` (`packages/backend/src/dso/worker/ended-state.ts:41-48`).
- **Identifier**: `dsoId: string` slug ("artemis-ii", `entries.ts:94`) and Horizons id `providerObjectId '-1024'` (`:98`). No NORAD id, no COSPAR. 5 registry entries (`packages/backend/src/dso/registry/entries.ts:50-122`), only `artemis-ii` has `enabled: true` (`:99`). Registry is checked-in code, not data.
- **Runtime / at rest**: `<CACHE_DIR>/dso/catalog.json`, `manifest.json`, `ended.json`, `snapshots/<dsoId>/<version>.json` (`packages/backend/src/dso/snapshot/store.ts:27-45`, `ended-state.ts:54-56`); browser store `dsoObjects`, `dsoEphemerisById` (`packages/frontend/src/store/types.ts:341-342`).
- **SPACE**: moving, TEME earth-radii (`packages/contracts/src/dso.ts:41-43`). `targetBody` moon/earth/mars/other and `regime` LUNAR/CISLUNAR/INTERPLANETARY/OTHER (`packages/contracts/src/dso.ts:18-20`), a different regime enum from `OrbitalRegime` (`enums.ts:62`).
- **TIME**: `validFrom`/`validTo` ISO; `freshnessState` fresh/stale/degraded/unavailable derived from last success (`packages/backend/src/dso/snapshot/store.ts:99-125`); there is no `ended` value (`packages/contracts/src/dso.ts:22`, `state/OPEN.md:46`), the ended flag lives in a separate file.
- **LINKS**: none. No org, launch, program or country link on the wire; `mission` is a string; `launchDate` exists only in the backend registry (`registry/types.ts:36`).
- **SOURCE**: JPL Horizons, worker loop, default refresh 21,600 s (`entries.ts:20`), own supervised process (`packages/backend/src/supervisor.ts`). Browser polls (A.B below).
- **Perceptor**: none. `packages/analytic/src/schema.ts:19-21`: "DSOs are out of scope for the analytic universe in v1".

#### A5. DSO ephemeris snapshot
- **Shape**: `DsoSnapshot` (`packages/contracts/src/dso.ts:35-51`); vector `[timestampIso, x, y, z, vx, vy, vz]` (`:25-33`).
- **Identifier**: `(dsoId, snapshotVersion)`; version string derived from an ISO timestamp (`packages/backend/src/dso/normalize/convert.ts:37-39`).
- **Lives**: file per version; newest 3 kept, only the manifest-named one is served (`packages/backend/src/dso/snapshot/store.ts:21`, prune `:173-`; `state/OPEN.md:49`). Browser: store + Hermite interpolation in `dso.worker` (`packages/frontend/src/data/dso-interpolator.ts`).
- **SPACE / TIME**: J2000 to TEME conversion on the backend (`convert.ts`), 600 s samples (`entries.ts:19`). Time scale conversion TDB to UTC uses a fixed 69.184 s (`convert.ts:9`, name says "APPROX"). Not append-only: a new snapshot replaces overlapping times (`state/OPEN.md:49`).
- **Perceptor**: none.

#### A6. Launch
- **Shape**: `LaunchRecord`, `packages/contracts/src/api.ts:77-95`.
- **Identifier**: `tag` = GCAT `Launch_Tag`, e.g. "1998-067"; pre-1963 tags look like "1957 ALP" (first keys of `launches.json`, measured). 6,878 records (measured). Every object's `launchTag` resolves (0 missing, measured).
- **Lives**: `packages/backend/enrichment-data/launches.json` (2.06 MB) loaded to `Map<string, LaunchRecord>` (`store.ts:165-169`); only launches referenced by a cataloged object are in the file (`packages/backend/tools/enrichment/gcat/launches.ts:57-59`); route `GET /api/launch/:tag` returns the record plus `noradIds` via a lazy inverse index (`routes/metadata.ts:81-89`, `store.ts:203-214`).
- **Fields (measured)**: lvType 398 distinct, lvFamily 73, site code 54, siteName 43, (site,pad) 238, success true 6,792 / false 85 / null 1, agencies 106 distinct codes (all resolve to orgs). Objects per launch: median 3, max 3,537 (tag "1999-025").
- **SPACE**: none (a site name string, no coordinates). **TIME**: `date` is the raw GCAT vague string ("1957 Oct  4 1928:34"); range 1957 to 2026-07 (measured). The provider converts it to a prefix-ISO string of variable precision (`packages/backend/src/analytic/providers/gcat-date.ts:14-37`). A launch as a dated event is not indexed by time anywhere.
- **LINKS**: objects (inverse of `launchTag`), orgs via `agencies[]`, site and vehicle only as strings.
- **Perceptor**: reachable only through a one-hop dotted join from an object: `launch.date|lvType|lvFamily|siteName|pad|success` (`schema.ts:142-147`; `packages/backend/src/analytic/providers/enrichment.ts:173-197`). There is no universe whose rows are launches.

#### A7. Organization
- **Shape**: `OrgRecord`, `packages/contracts/src/api.ts:104-117`.
- **Identifier**: `code` ("SPXS", "OKB1"). 2,045 records (measured); astronomical-body rows are skipped at ingest (`packages/backend/tools/enrichment/gcat/orgs.ts:24-35`).
- **Lives**: `orgs.json` (428 KB) loaded to a Map (`store.ts:171-175`); route `GET /api/org/:code` (`routes/metadata.ts:92-100`); slim `OrgRef` (`api.ts:129-133`); 1,147-org subset in `query-vocab.json` (measured).
- **Fields (measured)**: lat/lon on all 2,045; `tstart` 1,897 / `tstop` 557; `parent` on 528 (527 resolve); parent depth histogram 0:1,517, 1:456, 2:70, 3:2; class B 1,073 / A 456 / C 320 / D 196; type flags O, PL, LA, LV, S, E, P, LS (56 orgs flagged `LS`; meaning unverified).
- **SPACE**: a stored lat/lon per org, not exposed to the IR. **TIME**: `tstart`/`tstop` raw vague strings (an existence interval).
- **LINKS**: `parent` to A7; `stateCode` to A11 (via `canonicalFromSatcatState`, `inherit.ts:102`); objects by `gcat.owner` first token (`inherit.ts:50-55`); launches by `agencies`.
- **Perceptor**: `owner`, `owner.name`, `owner.stateCode`, `owner.cls`, `ownerFamily` (root of parent chain, `enrichment.ts:64-76`) (`schema.ts:96, 139, 148-150`).

#### A8. Program / constellation
- **Shape**: `ProgramEntry` (`packages/backend/src/enrichment/programs.ts:24-38`), 72 entries; label table `PROGRAM_LABELS` and `ProgramId` (`packages/contracts/src/programs.ts:17-94`), 72 keys.
- **Identifier**: slug string. 71 slugs occur in the data; `hulianwang-shiyan` never does (measured).
- **Membership is inferred, not sourced**: name-prefix/regex match gated to payloads (`packages/backend/src/enrichment/programs.ts:265-284`, `store.ts:117-134`), or inherited from a parent object or by launch majority vote (`inherit.ts:119-168`); tagged `inferred`/`inherited` in `FacetProvenance` (`metadata.ts:21-27`).
- **Lives**: `program` string on A3 (53,493 records, measured) and on A1 inline (`tle.ts:43`).
- **SPACE / TIME**: none. **LINKS**: members are objects; the program's `operatorOrg` is a free-text name ("SpaceX"), not an org code (`packages/backend/src/enrichment/programs.ts:32, 43-45`).
- **Perceptor**: `program`, `program.label` (`schema.ts:95, 151`).

#### A9. Launch vehicle - NO entity
`lvType` (string, 398 distinct) and `lvFamily` (73) on `LaunchRecord` (`api.ts:80-82`); a second, unrelated spelling `launchVehicle` is UCS free text on 7,551 `ObjectMetadata` records (`metadata.ts:71`; measured). IR: `launch.lvType`, `launch.lvFamily`.

#### A10. Launch site / pad - NO entity
`site` code, `siteName`, `pad` strings on `LaunchRecord` (`api.ts:85-88`); a second spelling `launchSite` free text from UCS on 7,551 records (`metadata.ts:70`). No coordinates are stored for launch sites: `parseSiteNames` keeps only the name (`launches.ts:40-48`). 56 org rows carry type flag `LS` with lat/lon, but only 4 of the 54 launch site codes are also org codes (measured), so there is no join from a launch to coordinates.

#### A11. Country - NO entity
A canonical Space-Track-style code string ("US", "PRC", "CIS"). Display table `COUNTRY_DISPLAY` has 27 entries (`packages/contracts/src/countries.ts:23-51`); the data has 123 distinct codes, 101 among in-orbit objects; the table covers 33,648 of 34,210 in-orbit objects (98.4%) (measured). Three code systems are normalized into it (`packages/backend/src/enrichment/country-codes.ts:4-10`); 95 GCAT state codes pass through raw (`gcat-mapping-report.json` `passthroughStateCodes`, measured). Includes non-states (ESA, SES, ITSO, GLOB, TBD; `countries.ts:32-50`). No country geometry exists in the code (grep for geojson/polygon found only the gazetteer comment). IR: `countryCode` (Space-Track code, `schema.ts:94`) and `owner.stateCode` (GCAT state code, `enrichment.ts:132-136`) are different code systems under similar names.

#### A12. Separation-tree node (GCAT `jcat`)
- Nodes are A3 records keyed by `jcat` string; every `jcat` in the map starts with `S` (measured). `parentJcat` on 69,117 records (`metadata.ts:83`, measured). 45,003 parents resolve to a record in the NORAD-keyed map; the rest point at 7,481 distinct parent ids that have no record here (prefixes R 5,084 / A 2,321 / L 74 / S 2; measured). All 7,919 `component` objects have a parent (measured).
- Largest fan-out: S25730 (Feng Yun 1C) 3,533 children; S13552 (Kosmos-1408) 1,806; S22675 (Kosmos-2251) 1,716 (measured).
- Traversal: see D.

#### A13. Observer / ground location - NO entity, five shapes
- `GeodeticObserver {lat, lon, alt}` (`packages/frontend/src/data/types.ts:23`), store field `observerLocation` (`packages/frontend/src/store/types.ts:198`); `GeodeticInput {latDeg, lonDeg, altKm?}` (`packages/orbital-core/src/earth.ts:50-54`); `PassObserver` (`packages/frontend/src/sky/passes.ts:47-51`); `ResolvedObserver` (`packages/analytic/src/execute.ts:44-48`); `ObserverRef = 'user' | {latDeg, lonDeg, altKm?}` (`packages/analytic/src/types.ts:112`); derived `ObserverFrame {position, up}` (`packages/orbital-core/src/observer.ts:14-19`).
- No id. Lives only in the browser: Zustand + `localStorage` key `orbitwatch:observerLocation:v1`, 12 h max age (`packages/frontend/src/sky/observer-location.ts:47-48`). The server sees it only inside a `/ask` body (`packages/backend/src/routes/query.ts:136`, validated by `resolveObserver :50-57`).
- SPACE: WGS84 geodetic, static point, re-anchored into TEME every frame. TIME: `savedAt` only (`observer-location.ts:31-33`).
- `observerPlaceName` exists in the store but is only ever written with `null` (`packages/frontend/src/engine/controllers/LandingController.ts:37`); the backend gazetteer is never used for it.
- Perceptor: a parameter of 4 functions, not a row.

#### A14. Gazetteer place (backend only)
- **Shape**: `GazetteerSourceRecord` (`packages/backend/src/types/index.ts:127-145`); id `sourceId` = `ne:<ne_id>` or positional fallback `ne:<index>:<name>` (`:142-144`).
- **Lives**: `<CACHE_DIR>/gazetteer-cache.json`, 30-day TTL (`packages/backend/src/cache/gazetteer-cache.ts:21-34`) + in-memory index. Source Natural Earth 1:10m populated places via a ~90 s fetch (`packages/backend/src/services/gazetteer.ts:9-14`).
- **SPACE**: lat/lon (GeoJSON `[lon, lat]` order, `types/index.ts:139-141`). **TIME**: none.
- **Use**: only to ground place names in NL questions for the compiler (`packages/backend/src/services/analytic-compiler.ts:223-340`); a miss is logged as gap kind `unresolved-place` (`:340`). Not exposed in the IR as an entity.

#### A15. Space-weather daily index
- **Shape**: `SwpcDailyIndex {date, apIndex, kpIndex, f107}` (`packages/backend/src/types/index.ts:114-123`). Id = UTC date string.
- **Lives**: `<CACHE_DIR>/swpc-cache.json`, 12 h TTL (`packages/backend/src/cache/swpc-cache.ts:21, 32-34`) + provider Map. Source NOAA SWPC text products, trailing ~30 days only (`packages/backend/src/services/swpc.ts:20-25`): older values are not kept.
- **SPACE**: none (global). **TIME**: one value per UTC day.
- **Perceptor**: 3 fields `solarFlux10cm`, `geomagneticAp`, `geomagneticKp` filed under plane `static` as "least wrong"; the schema comment says a real `global` plane is the honest fix (`schema.ts:36-48, 161-163`). The provider ignores the object id (`packages/backend/src/analytic/providers/space-weather.ts:94`). Server-only (`packages/analytic/src/capability.ts:26-28`).

#### A16. Curated naked-eye list
- Set of NORAD ids from CelesTrak `GROUP=visual` (`packages/backend/src/services/celestrak-visual.ts:8-10`). Backend file `visual-cache.json` `{version, ids[]}`, 8 h TTL (`file-cache.ts:32-37, 59-61`); API `GET /api/tle/visual` (`packages/backend/src/routes/tle.ts:136`). Browser: `Set<number>` in `VisualListPoller` polled every 5 min (`packages/frontend/src/data/tle-client.ts:165-195`), `localStorage` `orbitwatch:visualNoradIds:v3`, 8 h (`packages/frontend/src/data/visualList.ts:3, 6`), store `visualList` (`store/types.ts:57-65, 210`).
- It is a membership flag on A1, used only inside `visuallyVisible` (`packages/backend/src/analytic/providers/sgp4.ts:161-166`, `packages/orbital-core/src/live-plane.ts:233-247`). Not a field in `FIELD_REGISTRY`. Backend re-reads the file at most once per 60 s (`sgp4.ts:71`).

#### A17. History day snapshot
- **Tables**: `object_dim` (norad_id PK, object_name, object_id, country_code, launch_date, rcs_size, first_seen, last_seen) and `omm_daily` (`0001_init.ts:23-59`); optional Timescale hypertable on `omm_daily` by `utc_day` with 14-day compression policy (`packages/backend/src/history/db/migrate.ts:59-77`). Disabled when `DATABASE_URL` is unset: routes return 503 (`packages/backend/src/history/routes/index.ts:20-22`).
- **Serving**: `getAsOfCatalog` = latest elset per object on or before the day, within a 30-day staleness window (`packages/backend/src/history/db/queries.ts:160-175`); rebuilt into `EnrichedTLEObject` in the exact live envelope (`packages/backend/src/history/serving/reconstruct.ts:14-59`, `packages/contracts/src/api.ts:23-27`); pre-gzipped LRU of 32 days (`snapshot-cache.ts:20-29`).
- **Lossy**: enrichment is not versioned: reconstructed rows hard-code `status 'in_orbit'`, `sectors []`, `purpose 'other'` (`reconstruct.ts:53-58`); `objectType` is re-derived from `category` (`map.ts:35-40`), and since `category` is `unknown` for payloads, payload rows come back as `objectType 'unknown'` (see E).
- **TIME**: daily granularity, forward-only collection from the first ingest (`packages/backend/src/boot.ts:122-133`); coverage `{from, to, objectCount, lastIngestAt}` (`api.ts:32-37`).
- **Perceptor**: none (history is reachable only through the time scrubber, `packages/frontend/src/engine/controllers/timeline-target.ts:21-39`).

#### A18. Sun, Moon, stars, Earth
- **Sun**: a direction function only, unit vector in equatorial TEME-treated frame (`packages/orbital-core/src/sun.ts:16-44`); no distance, no position, no id. Consumed by eclipse/darkness math (`packages/orbital-core/src/illumination.ts`), Earth shading (`packages/frontend/src/engine/world/layers/EarthLayer.ts:44`), dome sky (`DomeSkyLayer.ts:245`).
- **Moon / planets**: no ephemeris or position anywhere in `orbital-core` or the frontend (grep). The word "moon" appears only as DSO `targetBody` (`packages/contracts/src/dso.ts:18`).
- **Stars**: 5,000 random points on a sphere (`packages/frontend/src/engine/StarfieldRenderer.ts:3, 52-56`, uses `Math.random`); not real stars, no catalog.
- **Earth**: WGS84 constants and conversions (`packages/orbital-core/src/earth.ts:24-41`), GMST rotation (`time.ts:27-36`); rendered as a unit sphere (`state/STATE.md`).

#### A19. Simulation / view time
- Singleton `simClock` (`packages/frontend/src/time/SimClock.ts:16-72`): epoch ms, rate, jump. Mirrored into store `simTimeMs`, `viewMode live|review`, `wallClockMs` (`store/types.ts:252-284`). The backend has no sim clock: it takes `tMs` per request, clamped to the propagation window (`routes/query.ts:41-46`).

#### A20. Analytic program / answer
- `AnalyticProgram {v:1, universe, timeBinding, interpretation, pipeline, compare?, output}` (`packages/analytic/src/types.ts:33-43`); `AnalyticResult` (`:156-166`). Browser: one current `AnalyticAnswer` (`store/types.ts:17-23, 245`); standing programs in `ResidentSet` keyed by an FNV-1a hash of the stable-stringified program (`packages/frontend/src/engine/resident/ResidentSet.ts:138-170`). Backend: compile cache keyed by sha256 of promptVersion + grounding marker + normalized question, LRU 500, persisted to `backend/data/compile-cache.json` (`analytic-compiler.ts:95, 106-113, 210, 438`).

#### A21. Selection / focus
- `selectedIndex: number | null` (an index into the CURRENT catalog array), `selectedSatellite`, `selectedDso` (`store/types.ts:167-169, 178`). DSO pick ids are encoded above the TLE count (`packages/frontend/src/engine/dso/dso-resync.ts:4-8`), so a DSO's pick id changes whenever the catalog swaps (live/history/planetarium). A catalog swap re-resolves the selection by `noradId` (`packages/frontend/src/engine/controllers/TimelineController.ts:216-254`).

## B. Event / happening types

Headline: there is exactly ONE append-only event log in the repo (the compiler gap log, B9) and it is never read. Everything else is either a log line, a single overwritten state record ("last attempt"), or an in-memory ring. No row anywhere says "object X did Y at time T".

### B.1 Backend (server) happenings

| # | Happening | Produced where | What it records | Persisted? | Consumed by |
|---|---|---|---|---|---|
| B1 | Catalog refresh cycle (trigger `boot` / `cron` / `retry`) | `packages/backend/src/cron/tle-updater.ts:604` `runUpdateCycle`; types `:266`; schedule `:54, 895-903` | Log lines only ("TLE update cycle starting" `:619`). Side effect: `tle-cache.json` + `version.json` replaced (`:761`), payload cache primed (`:821`). No cycle record (no id, outcome, counts). | Only the replaced catalog; version = ISO write time (`packages/backend/src/cache/file-cache.ts:181`) | `/api/tle/version` (`routes/tle.ts:168`), `/health` `lastUpdate` (`app.ts:109`), provider version guards (`packages/backend/src/analytic/providers/version-guard.ts`), browser revalidate (`tle-client.ts:112`) |
| B2 | Space-Track attempt (start, success, failure) | `packages/backend/src/cache/attempt-log.ts:296-318` | ONE record, overwritten: `{lastAttemptAt, lastOutcome, consecutiveFailures, attemptDay, attemptsToday, successToday, alertSentDay, alertStreakDays}` (`:56-72`) | `<CACHE_DIR>/spacetrack-attempts.json` (`:267-269`), state not history | the gate `evaluateGate` (`:141`), alert logic, retry timer |
| B3 | CelesTrak attempt per group | `packages/backend/src/cache/celestrak-attempts.ts:28-35` | `{lastAttemptAt, lastOutcome, lastHttpStatus?}` per group | `celestrak-attempts.json` (`:81`), overwritten | 2-hour gate (`:45-56`) |
| B4 | Retry timer armed | `tle-updater.ts:364` `armUpdateRetry`; resumed at boot `:877` | In-memory `pendingRetry {at, cancel}` | No; re-derived from B2 at boot | itself |
| B5 | Alert (6 kinds: Space-Track daily failure `:411`/`:515`; write failure `:442`/`:781`; CelesTrak used as fallback `:472`/`:808`; CelesTrak called / called-and-failed `packages/backend/src/services/celestrak.ts:69,76`; volume warn >=75% and error >=90% `packages/backend/src/utils/volume-alert.ts:36-98`) | `packages/backend/src/utils/alert.ts:94-123` `sendAlert` | title + body text; always an `ERROR ALERT ...` log line, optionally POST to webhook (ntfy/slack/discord/json) and/or Resend email | Only the "last day sent" per kind: `alert-state.json` `{volumeWarnDay, volumeErrorDay, writeFailureDay, celestrakFallbackDay}` (`packages/backend/src/cache/alert-state.ts:26-31`) + `alertSentDay` in B2. The alerts themselves are not stored. | a human (the only outbound push in the repo) |
| B6 | History ingest (daily upsert) | `packages/backend/src/history/ingest/sink.ts:75-97` | Log `History ingest: N daily rows upserted`. Row-level metadata: `source`, `ingested_at` columns (`0001_init.ts:56-57`) | upsert into `omm_daily`/`object_dim` (idempotent; later epoch wins); skipped when the catalog came from CelesTrak (`tle-updater.ts:829`) | `/api/history/*`, scrubber |
| B7 | Raw archive write | `packages/backend/src/history/archive/raw-writer.ts:40-62` | `{day, source, fetchedAt, records}` gz envelope; "latest write in a day wins" (`:35-38`) | `<dir>/YYYY-MM-DD.json.gz`, ~4.6 MB/day (`state/OPEN.md:10`), overwritten per day, never pruned; no reader exists in the code | nothing (insurance); triggers volume check (`:61`) |
| B8 | First/last seen of an object | `packages/backend/src/history/db/queries.ts:49-50` | `first_seen` / `last_seen` DATE per object in `object_dim` | yes (the closest thing to "object entered/left the catalog") | `getCoverage` counts rows only; nothing reads first/last seen |
| B9 | Compiler gap (refused / invalid / hollow / unresolved-place) | `packages/backend/src/services/analytic-compiler.ts:252-262` `appendGap` (entry type `:41`, e.g. `GAZETTEER_MISS` `:340`); hollow from `routes/query.ts:186-198` | `{ts, question, kind, code, reason?, fields?, matched?, scanned?}` | `backend/data/gap-log.jsonl` via `appendFileSync` - TRUE append-only. Path ignores `CACHE_DIR` (`packages/backend/src/utils/paths.ts:28-31`), so it is not on the Railway volume; no rotation (`state/OPEN.md:47`) | nothing in code (grep: only the writer references it) |
| B10 | Ask served | `packages/backend/src/routes/query.ts:170-177` | Log line `analytic ask [sha16] universe=... matched= scanned= execMs=` | log only | humans |
| B11 | Compile cache write | `analytic-compiler.ts:238, 438-447` | LRU 500 entries keyed by sha256 | `backend/data/compile-cache.json` | compiler (memo, not an event) |
| B12 | DSO worker pass: heartbeat / publish / failure | `packages/backend/src/dso/snapshot/store.ts:243-, 258-, 303-` | manifest status per object: `lastSuccessAt, lastFailureAt, failureCount, currentSnapshotVersion` (`packages/contracts/src/dso.ts:69-82`) | `manifest.json`, `catalog.json` rewritten atomically; a counter and last timestamps, no history | `routes/dso.ts`, `/health` (`routes/dso.ts:128`), browser poll |
| B13 | DSO mission ended | `packages/backend/src/dso/worker/ended-state.ts:134` `markDsoEnded` | `{endedAt, markedAt, lastCheckedAt}` (`:41-48`) | `<CACHE_DIR>/dso/ended.json`; re-checked weekly (`:39`) | worker loop (`worker/index.ts:267-314`), `/health` `dsoEndedCount` |
| B14 | DSO snapshot pruned | `packages/backend/src/dso/snapshot/store.ts:173-` | log | deletes older files, keeps 3 | none |
| B15 | Process supervision: child exit / restart | `packages/backend/src/supervisor.ts` | ERROR log with exit code and next delay (`state/DECISIONS.md:97`) | log only | operators |
| B16 | Disk-usage report | `packages/backend/src/boot.ts:29-76` | log line | no | volume alert B5 |
| B17 | Enrichment build mapping report | `packages/backend/tools/enrichment/gcat/ingest.ts:34-51` | counts of unmapped codes, NORAD collisions, rows skipped | committed `gcat-mapping-report.json` (13 KB), offline | humans |

### B.2 Frontend (browser) happenings

| # | Happening | Produced where | Records | Persisted? | Consumed by |
|---|---|---|---|---|---|
| B20 | SGP4 tick (~1 Hz) | `packages/frontend/src/workers/sgp4-protocol.ts:17-27` `POSITIONS` message | positions/velocities/validFlags buffers + `timestamp`, `seq` | no (transferred buffers) | renderer, `AnalyticRuntime`, `LiveKinematics` |
| B21 | Resident delta (object entered/exited a standing program) | `packages/frontend/src/engine/resident/ResidentSet.ts:291-328` `tick`; called from `packages/frontend/src/engine/Engine.ts:448-458` | `{t, programHash, entered[], exited[]}` (`ResidentSet.ts:47-53`) | in-memory ring of 1000 (`:103, 323-324`), lost on reload. In production nothing adds residents: `installDevHooks` runs only `if (import.meta.env.DEV)` (`Engine.ts:262`), and deltas are `console.info` only in DEV (`:450-457`) | dev console `window.__resident.deltas` |
| B22 | Sim-time jump / rate change / go-live | `packages/frontend/src/store/timeSlice.ts:15, 31, 37, 52, 64, 71` (calls `triggerSimTimeJump`) -> `Engine.ts:514` `onSimTimeJump` | no event object; mutates `simClock` | no | engine reseed logic |
| B23 | Catalog target change (live / day / hidden planetarium) | `packages/frontend/src/engine/controllers/timeline-target.ts:21-39`, `TimelineController.ts:139-141` | `CatalogTarget` kind + `targetKey` | no | `reseedToLive` / `reseedToDay` / planetarium |
| B24 | User ask | `packages/frontend/src/ui/hooks/useAnalyticAsk.ts:43-60` | `AnalyticAnswer {status, question, interpretation, result}` | store, one at a time (`store/types.ts:17-23`) | `AskBar`, renderer allow-set (`engine/SatelliteRenderer.ts:342-343, 402-404`) |
| B25 | Selection change | `store/types.ts:186` `setSelectedSatellite` | index + object | no | camera, pass planner, panes |
| B26 | Pass (AOS / peak / LOS interval) | `packages/frontend/src/sky/passes.ts:223` `findPasses`; `engine/controllers/PassPlanner.ts:33-49` | `Pass {aosMs, losMs, horizonAosMs, horizonLosMs, peakMs, peakElevationDeg, 3 azimuths, startClipped, endClipped}` (`passes.ts:73-116`) | store `nextPasses` for the selected object only; not stored anywhere else | pass readout, sky arc |
| B27 | Critical engine error | `Engine.ts:548` `handleCriticalError` | error | no | loading screen |
| B28 | Visual list refresh result | `tle-client.ts:208-240`, `Engine.ts` `applyVisualListResult` | `VisualListState` (`store/types.ts:57-65`) | localStorage 8 h | engine |
| B29 | DSO manifest poll result | `packages/frontend/src/data/dso-client.ts:152-165` | new snapshot version noticed -> refetch ephemeris | in-memory ETag maps | DSO layer |

### B.3 Things the owner would expect to be events that are NOT events in code

- **Decay / re-entry**: not detected anywhere. The Space-Track query excludes decayed objects up front (`packages/backend/src/services/spacetrack.ts:37`, `DECAY_DATE/null-val`); CelesTrak `DECAY_DATE` rows are dropped (`packages/backend/src/services/celestrak.ts:82`, `tle-updater.ts:175`); the overlay never removes anything (`state/DECISIONS.md:88`: "Decayed objects are dropped when the data says so (it does not today)"). An object simply disappears from `tle-cache.json` at a later refresh with no record. The compiler prompt states "decay DATES are not ingested" (`analytic-prompt.ts:217`). `status` comes from the static 2026-07 snapshot, so it never changes at runtime (`contracts/metadata.ts:125-129`).
- **New object appears in catalog**: not detected (CelesTrak overlay adds unknown ids silently, `state/DECISIONS.md:88`).
- **Maneuver / elset change**: no comparison of successive elsets (`analytic-prompt.ts:531`).
- **Launch**: `LaunchRecord.date` is static reference data; no launch event stream, no upcoming launches, no link to time.
- **Eclipse / visibility transitions**: boolean functions at an instant (`live-plane.ts`) and interval scans only on demand (`sweep` IR stage, `findPasses`); nothing is emitted when state flips.
- **Conjunctions, space-weather storms, news**: only the field `distToKm` and 3 daily indices exist.

### B.4 Push mechanisms - searched

I grepped `packages/` (src, tests, package.json files) for WebSocket, EventSource, `text/event-stream`, socket.io, `ws`, web-push, PushManager, `res.write(`/`flushHeaders`. Result: **none**. Backend dependencies are express, axios, node-cron, pg, satellite.js, helmet, cors, compression, express-rate-limit, dotenv, @anthropic-ai/sdk (`packages/backend/package.json`); no websocket or SSE library. The service worker has only `install`, `activate`, `fetch` handlers and caches static assets (`packages/frontend/public/sw.js:16, 21, 61`). The only `postMessage` uses are browser main-thread to Web Worker (`workers/sgp4.worker.ts:129, 216`, `engine/dso/DsoWorkerClient.ts`).

All client data movement is PULL:
- Live catalog: fetched once at load, never refreshed in-session; a version check refreshes the IndexedDB copy for the NEXT load (`tle-client.ts:112-130`); `/api/tle/all` is `private, max-age=3600` (`routes/tle.ts:98`).
- Curated list: setInterval 5 min (`tle-client.ts:165, 195`).
- DSO: manifest poll every 60 s (`dso-client.ts:11`), catalog bootstrap poll 5 s doubling to 5 min (`:12-18`); HTTP cache `max-age` 300 / 60 / 3600 for catalog / manifest / ephemeris (`routes/dso.ts:58, 76, 110`).
- History coverage: fetched once at engine start (`TimelineController.ts:90`); day snapshots on scrub (`history-client.ts:49`).
- Ask: request/response (`data/analytic-client.ts:134`).
- Outbound push exists only to humans via alerts (B5).

Closest in-process analogue to a subscription: `ResidentSet` (B21), which is browser-only, dev-only, and diffs `ids` sets of one shape.

## C. The Perceptor's current vocabulary as a world model

### C.1 Vocabulary inventory (from `packages/analytic/src`)

| Item | Values | Where |
|---|---|---|
| `Universe` | `'live' \| 'all'` (both are sets of catalog objects: ~32k tracked vs ~70k ever cataloged) | `types.ts:20` |
| `TimeBinding` | `{mode:'now'} \| {mode:'at', t: ISO}`; one instant per program | `types.ts:22-23` |
| `ResultShape` | `ids, object, table, scalar, grouped` | `types.ts:25` |
| Stages (9 ops) | `pick, filter, derive, sort, limit, aggregate, groupBy, timeScan, sweep` | `types.ts:85-94` |
| Aggregates | `count`, `sum/avg/median/min/max/stddev` of a field, `share` of a predicate | `types.ts:98-104` |
| Expr ops | `+ - * /`, 6 comparisons, `and or not abs bucket in has`, field, literal | `types.ts:108-133` |
| FN_SPECS (6) | live: `elevationDeg, rangeKm, observerDark, visuallyVisible, distToKm`; static: `descendsFrom` | `schema.ts:175-182` |
| `FieldPlane` | `'live' \| 'catalog' \| 'static'` | `schema.ts:35` |
| `FieldKind` | `number, string, bool, date, enum, enumSet, id` | `schema.ts:34` |
| Validation codes (15) | V-SHAPE, V-PIPE, V-DERIVE, V-EXPR, V-FIELD, V-TYPE, V-ENUM, V-PLANE, V-TIMECAP, V-SCAN, V-SWEEP, V-GROUP, V-LIMIT, V-OUTPUT, V-INTERP | `validate.ts:64-78` |
| Runtime error codes | `E-OBSERVER, E-UNIVERSE, E-GROUP, E-INTERNAL` | `execute.ts:79` |
| Caps | 8 stages, 10 derived, depth 6, limit 1000, 1000 pick ids, timeScan 240 steps and 5 objects, 2000 groups, sweep 2000 objects, past cap 60 d, future cap 14 d | `validate.ts:19-50` |
| Observer | `'user'` or literal `{latDeg, lonDeg, altKm?}`; a parameter, never a row | `types.ts:112` |

### C.2 FIELD_REGISTRY: 64 fields (`schema.ts:81-164`, lines 83-163; measured with a regex over that range)

By plane: static 35, catalog 24, live 5. By kind: number 31, string 20, enum 6, date 3, bool 2, id 1 (`noradId`), enumSet 1 (`sectors`). Derived (computed on demand): 20 (live 5, catalog 4, static 11).

| Plane x kind | count |
|---|---|
| catalog: number 16, string 3, enum 2, date 2, id 1 | 24 |
| live: number 4, bool 1 | 5 |
| static: string 17, number 11, enum 4, date 1, bool 1, enumSet 1 | 35 |

By what the field is a property of (my grouping of the registry lines):

| Group | Count | Lines | Subject of the field |
|---|---|---|---|
| Identity and classification (noradId, name, cospar, jcat, objectType, category, regime, status, operationalStatus, sectors, purpose, countryCode, program, owner, launchTag, parentJcat, launchDate, rcsSize) | 18 | `schema.ts:83-100` | the catalog object |
| Mean elements (epoch ... perigeeKm) | 13 | `:103-115` | the object's current element set |
| Physical (masses, dimensions, power, lifetime, bus, shape) | 10 | `:118-127` | the object |
| Derived (speedKmS, altitudeKm, latDeg, lonDeg, eclipsed, meanAltitudeKm, semiMajorAxisKm, ageYears, launchYear, ownerFamily) | 10 | `:130-139` | the object (first 5 need a propagated state) |
| One-hop dotted joins (`launch.*` x6, `owner.*` x3, `program.label`) | 10 | `:142-151` | a launch / org / program, reached by foreign key FROM an object |
| Space weather (`solarFlux10cm`, `geomagneticAp`, `geomagneticKp`) | 3 | `:161-163` | the world at a UTC day, same value for every object |

So 61 of 64 fields are properties of one catalog object (10 of them are one-hop reads of another entity through that object's foreign key). Only 3 are not about an object, and they are filed under `static` by admission of mismatch (`schema.ts:36-48`).

Coverage numbers are stored twice: static docs values in `schema.ts` (`coverage`, e.g. `operationalStatus 0.392`) and a boot-measured value in the registry snapshot used by the prompt (`schema.ts:55-59`, `packages/backend/src/analytic/registry.ts:112-169`).

### C.3 Provider chains (server)

`packages/backend/src/analytic/index.ts:40-68`: universe `live` = spine `catalog`, chain `[catalog, enrichment, sgp4, space-weather]`; universe `all` = spine `all-spine` (catalog ids union enrichment ids), chain `[catalog, all-spine, enrichment, space-weather]`. Field resolution is "first non-null provider wins" (`registry.ts:44-50`, `server-source.ts:20-28`). The comment in `packages/backend/src/analytic/types.ts:1-8` is the stated expansion path: "a future domain (weather, incidents, news) lands as one new FieldProvider + new FIELD_REGISTRY nouns + prompt regen".

### C.4 Routing today (hand-kept list the owner rejected in D3)

`packages/analytic/src/capability.ts`: `CLIENT_UNSERVED_FIELDS` is a hard-coded set of 22 names (`:17-29`), `CLIENT_SERVED_FNS` 5 names (`:32-34`), `CLIENT_SERVED_FIELDS` = registry minus unserved = 42 (`:37-39`); `programNeedsServer` sends a program to the server if `universe === 'all'` or it touches any unserved field/fn (`:170-176`). `routes/query.ts:147-153` returns the program to the browser otherwise. `state/OPEN.md:19-20` marks this file as the redesign marker.

### C.5 Every place that assumes "the subject of a row is a catalog object / a noradId"

Language and types (`packages/analytic/src`):
1. `AnalyticDataSource` port: `noradId(i)`, `noradToIndex(noradId)`, `distToKm(i, targetNoradId, tMs)`, `descendsFrom(i, ancestorNoradId)` (`execute.ts:50-63`). The row space is "index in a catalog array".
2. `PickStage { ids: number[] }` (`types.ts:51`); validator requires 1..1000 integers (`validate.ts:395-402`).
3. `distToKm.target: number` and `descendsFrom.ancestor: number`, validated as "noradId int" (`types.ts:119-120`, `validate.ts:179, 181`).
4. Result `ids?: Uint32Array` (`types.ts:159`); materialised with `source.noradId` (`execute.ts:884`); `missingIds` (`types.ts:153`); wire form `ids: number[]` (`wire.ts:15`).
5. Every `table`/`object` row is stamped `noradId` first (`execute.ts:903`); `timeScan` rows (`:430`) and `sweep` rows (`:565`) carry `noradId` and `name`.
6. `FIELD_REGISTRY.noradId` is the only `kind:'id'` field (`schema.ts:83`); `name` is read from the source by name in timeScan/sweep (`execute.ts:431, 521-522`).
7. The sweep prefilter reads `inclination` and `apogeeKm` by name (`execute.ts:487-491`): physics assumptions about an Earth-orbiting object.
8. Equality/ordering of dates assumes ISO strings (`execute.ts:930`: "Dates are ISO strings - lexicographic order is chronological").

Backend:
9. `FieldProvider.getField(noradId, field, tMs)` and every physics method take `noradId` (`packages/backend/src/analytic/types.ts:16-33`); `SpineProvider.spine(): readonly number[]` (`:36-39`).
10. Registry comment: "Providers are noradId-keyed; only server-source.ts knows index<->noradId" (`registry.ts:7`); `chainGetByNorad` (`:44`); `createServerSource` builds `noradToIndex` (`server-source.ts:17-18, 32-34`).
11. The space-weather provider takes a `_noradId` it ignores (`space-weather.ts:94`): the contract was bent to hold a non-object value rather than extended (its own header says so, `:7-14`).
12. Query route: universe split into exactly `live`/`all` (`routes/query.ts:155-157`); observer and `tMs` are request parameters (`:135-136`).
13. Compiler prompt teaches `pick ids [noradIds]`, `distToKm target <noradId>`, `descendsFrom ancestor <noradId>`, and asks the model to recall noradIds from memory (`analytic-prompt.ts:145-146, 170, 240-244, 255`). There is no name-to-entity resolver for objects (only a place gazetteer, A14).
14. `eval/hollow.ts` only inspects `meta.coverage` entries (`:14-18`).

Frontend:
15. `AnalyticFilter = {mode:'only', ids: Set<number>}` (`store/types.ts:92`), applied as `analyticIds.has(obj.noradId)` per catalog object (`engine/SatelliteRenderer.ts:402-404`). Decayed ids in an `all` answer are "naturally inert" (`useAnalyticAsk.ts:50-56`).
16. `ResidentSet` diffs `Set<number>` of ids and ignores any result whose shape is not `ids` (`ResidentSet.ts:305-315`); `ResidentDelta.entered/exited: number[]` (`:47-53`).
17. Live source indexes by array position and builds `noradId -> index` (`query/analytic/live-source.ts:76, 238-239`); `descendsFrom: () => false` (`:256`); vocab-dependent fields are null because the vocab is never installed (`query/vocab.ts:11-13`, `state/OPEN.md:40`).
18. `AnalyticAnswer` holds a single `AnalyticResult` (`store/types.ts:17-23`).

Entity kinds with NO door into the IR: DSOs (excluded, `schema.ts:19-21`), launches and orgs and programs as row sets (only one-hop joins from an object), observers (parameter), places, countries as entities, space weather as its own series, history days (programs bind one instant, `types.ts:22-23`; `FUTURE_CAP_DAYS`/`PAST_CAP_DAYS` clamp to a +-60/14 day window, `validate.ts:49-50`).

### C.6 Answers are pulled, not pushed
`POST /api/query/ask` is request/response (`routes/query.ts:128`); a program may be re-run only by the browser's resident tick (dev only, B21). There is no subscription representation in the IR: no `subscribe`, no `watch`, no event predicate type (stage list above).

## D. Existing graphs and relations

All relation data is a foreign-key string or array on a flat record, loaded into `Map`s at boot. There is no edge table, no edge type, no edge time, no edge provenance, and no graph query operator other than `descendsFrom`.

| # | Relation | Stored as | Size (measured) | Traversal (file:line) |
|---|---|---|---|---|
| D1 | Separation tree: object -> parent object (rocket stage, bus, parent satellite) | `parentJcat` string on A3 (`packages/contracts/src/metadata.ts:83`); nodes keyed by `jcat` (`:82`) | 69,117 child->parent edges; 45,003 parents resolve to a record in the NORAD-keyed map, 24,114 point at 7,481 distinct ids with no record here (R 5,084, A 2,321, L 74, S 2); edges-to-root histogram 1:24,178 2:22,788 3:15,616 4:6,395 5:136 6:2 7:1 8:1; all 7,919 `component` objects have a parent | Server: `descendsFrom` builds `jcatToNorad`/`noradToParentJcat` lazily and walks up at most 32 hops, returns false when a parent has no record (`packages/backend/src/analytic/providers/enrichment.ts:50-62, 203-219`); self is not its own descendant (`:206`). Build time: `walkToPayload`, at most 10 hops, cycle guard (`packages/backend/src/enrichment/gcat/inherit.ts:192-211`). Browser: none, `descendsFrom: () => false` (`packages/frontend/src/query/analytic/live-source.ts:256`). Not on the wire row (`tle.ts:44-48`). |
| D2 | Organization hierarchy | `parent` org code on A7 (`api.ts:112`) | 528 edges, 527 resolve; depth histogram 0:1,517 1:456 2:70 3:2 | Server `ownerFamilyRoot`, at most 10 hops (`enrichment.ts:65-76`); build-time `collectAncestors` at most 10 hops (`packages/backend/tools/enrichment/query-vocab.ts:27-34`); browser re-implements it over a vocab that is never installed (`live-source.ts:154-158`, `packages/frontend/src/query/vocab.ts:11-13`). Exposed as derived field `ownerFamily` (`schema.ts:139`). |
| D3 | Object -> launch | `launchTag` on A3 and inline on A1 (`tle.ts:46`) | 69,130 objects carry a tag; 6,878 launches; objects per launch median 3, max 3,537 ("1999-025"); 0 tags missing from launches.json | Forward: `getLaunch(tag)` (`store.ts:177-179`). Inverse `launchTag -> noradId[]`: lazy index (`store.ts:203-214`), served by `GET /api/launch/:tag` (`routes/metadata.ts:81-89`). IR: dotted `launch.*` (`enrichment.ts:173-197`). |
| D4 | Launch -> organizations (agencies) | `agencies: string[]` on A6 (`api.ts:89`) | 106 distinct agency codes, all resolve to orgs | Name composition in the metadata route (`routes/metadata.ts:64-69`); vocab `launches[tag][2]` (`api.ts:66`). Not reachable from the IR. |
| D5 | Launch -> site / vehicle / pad | strings on A6 | 54 site codes, 43 names, 398 vehicle types, 73 families, 238 site+pad | none (strings); IR dotted `launch.siteName`, `lvType`, `lvFamily`, `pad` |
| D6 | Object -> owner org | `gcat.owner` raw cell, first token via `primaryOwnerCode` (`inherit.ts:50-55`); inline `owner` (`tle.ts:48`) | 69,130 objects have an owner cell; 1,808 of them are multi-valued ("A/B") and lose all but the first; 96 are flagged uncertain `?`; 1,397 distinct primary codes, all resolve (measured) | `getOrg` (`store.ts:198-200`), IR `owner`, `owner.name`, `owner.stateCode`, `owner.cls` (`enrichment.ts:123-141`) |
| D7 | Object -> manufacturer org | `gcat.manufacturer` raw code (`metadata.ts:42`) | 45,514 objects (measured) | metadata route only (`routes/metadata.ts:56-58, 73`); not in the IR |
| D8 | Object -> program | `program` slug (single value) (`metadata.ts:110`) | 53,493 of 69,242 have one; of these 32,240 are `inherited` provenance (parent walk or launch majority), the rest from name matching or source (measured) | IR `program`, `program.label` (`enrichment.ts:108-116`) |
| D9 | Object -> country | `operatorCountry` canonical code (`metadata.ts:54`), inline `countryCode` (`tle.ts:27`) | 123 distinct codes | IR `countryCode` (catalog provider first, enrichment fallback) |
| D10 | Org -> country | `stateCode` (GCAT state code, a different code system) (`api.ts:108`) | all 2,045 orgs | IR `owner.stateCode` |
| D11 | Object -> constellation plane/shell | `plane` string (`metadata.ts:97`) | 16,017 objects (measured) | none (no IR field) |
| D12 | Launch-majority inheritance (derived edge used to fill facets) | computed at build, not stored | n/a | `inherit.ts:127-168` |
| D13 | Pairwise object distance | not stored; computed | n/a | `distToKm(i, targetNoradId, tMs)` (`execute.ts:61`, `live-plane.ts:151-157`) |
| D14 | Observer -> object (elevation, range, visibility) | not stored; computed | n/a | `lookAngles`/`azimuthElevation` (`live-plane.ts:76-149`) |
| D15 | Denormalized client projection of D2+D3+D4 | `QueryVocab {launches, orgs, owners}` (`api.ts:64-71`), file `query-vocab.json` | launches 6,878, orgs 1,147, owners 1,005 (measured) | built by `tools/enrichment/query-vocab.ts:36-74`; `GET /api/query/vocab` (`routes/metadata.ts:103-111`); never fetched by the app (`query/vocab.ts:11-13`) |

Not present as relations anywhere in code: object <-> object (other than D1 and D13), org <-> org other than parent, launch <-> launch, program <-> program, country <-> country, DSO <-> anything, object <-> event, object <-> place, any relation with a validity interval or a source tag.

Provenance exists only on A3 facets: `sources[]` and `facetProvenance` per facet with values from `METADATA_SOURCES` (`packages/contracts/src/enums.ts:150-157`). Counts of provenance stamps (measured): country `gcat` 69,130; org `gcat-org` 50,027; sectors `gcat-org` 41,984; purpose `inherited` 38,840; program `inherited` 32,240; purpose `gcat` 27,137; sectors `gcat` 27,133; org `inferred` 11,664. The wire row A1 and every relation above carry no provenance.

## E. Gaps and contradictions

### E.1 Things that have no stable identifier
- **Observer**: no id; 5 tuple shapes (A13). **Launch site, launch vehicle, pad, country**: bare strings (A9-A11).
- **GCAT objects without a NORAD id**: 596 satcat rows are dropped at ingest (`packages/backend/tools/enrichment/gcat/ingest.ts:98-102`; `gcat-mapping-report.json` `skippedNoNorad`, measured), 600 psatcat rows have no matching satcat row (`psatcatUnjoined`), and 7,481 distinct separation-tree parents have no record at all (D1). The model is keyed by NORAD id, so anything NORAD does not number does not exist.
- **DSOs** have `dsoId` strings, but at the picking/selection layer they live above the TLE index space (`packages/frontend/src/engine/dso/dso-resync.ts:4-8`), and `selectedIndex` is an array index into the CURRENT catalog (`packages/frontend/src/store/types.ts:167`). Selection survives a catalog swap only because `TimelineController` re-resolves by `noradId` (`TimelineController.ts:216-254`); a DSO has no equivalent re-resolve path in that code range (unverified beyond the lines read).
- **Element sets** have no id (implied `(noradId, epoch)`); **events** have no ids at all (B1-B29): no cycle id, no alert id, no ask id (only a 16-char sha256 in a log line, `routes/query.ts:170`), resident deltas are identified by `(programHash, t)` (`ResidentSet.ts:47-53`).
- **Programs** are slugs whose membership is inferred; the program itself has no source record (A8). **Space weather** is identified by its date string (A15).
- **Names are not resolvable to entities**: the fuzzy-search path was removed with the old overlay (`state/OPEN.md:32`), DSO `searchAliases` are carried but read by no code (grep: only copied through `dso-client.ts:51` and `packages/backend/src/dso/snapshot/store.ts:147`), and the compiler is told to recall noradIds from its own memory ("use its noradId ONLY if you are confident of it", `analytic-prompt.ts:240-244`). Only places have a resolver (the gazetteer, A14).

### E.2 Two or more identifiers / spellings for one thing
- **Object**: `noradId`, `jcat`, `cospar` (`packages/contracts/src/metadata.ts:51, 76, 82`); 10 NORAD collisions in GCAT resolved by dropping one row (`ingest.ts:107-111`); 112 enrichment records (UCS only) have no `jcat` (measured). Launch tag ("1998-067") and COSPAR ("1998-067A") share a prefix, but nothing in code derives one from the other (unverified that they always agree).
- **Object type**: wire 4-way `ObjectType` with `satellite` (`packages/contracts/src/enums.ts:139`) vs analytic 5-way `AnalyticObjectType` with `payload` and `component` (`:39`). The translation is repeated in the server catalog provider (`catalog.ts:84`) and the browser live source (`live-source.ts:174`). Because the catalog provider is first in the chain and always returns non-null, the enrichment provider's 5-way `objectType` is never consulted in the `live` universe (`catalog.ts:37, 84`, `enrichment.ts:30, 91`, chain `packages/backend/src/analytic/index.ts:53-56`): `objectType == 'component'` can never match live, although the enrichment data has 1,379 in-orbit components (measured). Source precedence silently changes what a field means.
- **Status**: three axes with unrelated vocabularies. `category` (active_satellite / inactive_satellite / rocket_body / debris / unknown / deep_space, `enums.ts:47-54`) is never `active_satellite`/`inactive_satellite` because no ops-status code is ever supplied (`tle-updater.ts:93-97`, `classifier.ts:84-99`, `analytic-prompt.ts:233`); `deep_space` is never produced for a record (it exists as a UI key, `frontend/src/data/types.ts:25-26`, and as a count, `frontend/src/store/dsoSlice.ts:9-14`). `status` (orbital) is frozen from the 2026-07 snapshot and is `unknown` for any object the snapshot lacks (`store.ts:108`, `enrichment/types.ts:55-60`). `operationalStatus` is `unknown` for 42,103 of 69,242 records (measured; the IR serves unknown as null, `enrichment.ts:93-96`).
- **Owner**: free-text `operatorOrg` (1,738 distinct values, measured), raw `gcat.owner` cell (multi-valued), inline `owner` code (first token), `owner.name`, `ownerFamily`, plus the program registry's own free-text `operatorOrg` (`packages/backend/src/enrichment/programs.ts:32`).
- **Country**: three source code systems (`country-codes.ts:4-10`); `countryCode` (Space-Track code) and `owner.stateCode` (GCAT state code) are both exposed to the IR under similar names.
- **Launch site / vehicle**: UCS free text (`launchSite`, `launchVehicle` on 7,551 records, `metadata.ts:70-71`) vs GCAT codes and names on the launch record (A9, A10).
- **Program**: registry slug `program` vs raw GCAT string `gcatProgram` (`metadata.ts:93-94`).
- **Observer**: `GeodeticObserver {lat,lon,alt}` vs `{latDeg,lonDeg,altKm}` (x3 names); manual mapping at `packages/frontend/src/engine/analytic/AnalyticRuntime.ts:71` and `packages/frontend/src/engine/controllers/PassPlanner.ts:44`.
- **Version strings**: TLE version = ISO build time (`file-cache.ts:181`), history version = day string (`snapshot-cache.ts:47`), DSO `snapshotVersion` = ISO with ms and colons stripped (`convert.ts:37-39`).

### E.3 Things modelled twice
- **Pass / interval prediction**: `findPasses` in the browser (`passes.ts:223`, main thread, `state/OPEN.md:28`) and the IR `sweep` stage, whose own doc says a pass predictor is a sweep (`types.ts:66-76`, `execute.ts:446` `runSweep`, `:512` `sweepObject`). `passes.ts:12-27` states why `timeScan` is not reused; `sweep` is not mentioned there.
- **Enrichment join**: baked onto the wire row at cron time (`store.ts:99-149`, `tle-updater.ts:112`) AND re-derived inside the enrichment provider (`enrichment.ts:100-117`); the catalog provider wins by chain order, so the second copy only matters for the `all` universe fallback.
- **Org family walk**: server (`enrichment.ts:64-76`, comment says it "mirrors live-source ownerFamilyRoot") and browser (`live-source.ts:154-158`).
- **The catalog file is parsed 4 times in the server process**: payload cache (`tle-payload-cache.ts` via `readRawTleCache`), catalog provider (`catalog.ts:59-66`), sgp4 provider (`sgp4.ts:84-94`), all-spine provider (`catalog.ts:147-150`), each with its own version guard (`version-guard.ts`).
- **Curated visual list**: backend file read every 60 s by the sgp4 provider (`sgp4.ts:71`) and a separate browser poller/localStorage copy (A16): the browser and server can disagree for minutes.
- **Coverage figures**: static docs numbers in `schema.ts` and measured numbers in the registry snapshot (`schema.ts:55-59`).
- **Selection**: `selectedIndex`, `selectedSatellite`, `selectedDso` are parallel fields with coupled writes (`store/types.ts:167-169, 178, 181-190`).
- **Country display** (contracts) vs normalizers (backend) were already merged once (`countries.ts:1-15`), but the 27-row display table covers 27 of 123 codes.

### E.4 Computed but never stored
- Decay / re-entry, new-object arrival, maneuvers, elset history in the live path (B.3).
- Passes (B26), resident deltas (B21; ring of 1000, dev only), eclipse and visibility intervals (only on demand).
- Per-day enrichment: history reconstruct hard-codes `status 'in_orbit'`, `sectors []`, `purpose 'other'` (`reconstruct.ts:53-58`); `objectType` is re-derived from `category` (`map.ts:35-40`) so payloads, whose category is `unknown`, come back as `objectType 'unknown'` while the live row says `satellite` (`classifier.ts:53-60` vs `reconstruct.ts:42`).
- Space weather: each refresh REPLACES the cache with the source's trailing ~30 days (`swpc-cache.ts:66-77`, `space-weather.ts:64-76`), so daily values older than the source window are never accumulated.
- Sun/eclipse state: functions only; no stored shadow or illumination timeline.

### E.5 Stored but never read
- Raw GP archive `.json.gz` per day (B7): no reader exists.
- `backend/data/gap-log.jsonl` (B9): written, never read in `packages/backend` (grep).
- `object_dim.first_seen` / `last_seen` (B8): written (`queries.ts:49-50`), read nowhere (grep).
- Store `historyDay` (`store/types.ts:289`, `state/OPEN.md:35`), filter slice setters (`store/types.ts:235-240`; no caller outside the store, grep; `state/OPEN.md:36`), `launchFilter`/`ownerFilter`/`programFilter` allow-sets with nothing to set them.
- Server routes the website never calls: `/api/metadata/:noradId`, `/api/launch/:tag`, `/api/org/:code`, `/api/catalog/decayed`, `/api/query/vocab` (`state/OPEN.md:66-67`); the vocab client exists but `ensureQueryVocab()` has no caller, so `launch.*`/`owner.*` fields are null in every browser-run program (`query/vocab.ts:11-13`, `state/OPEN.md:40`).
- `observerPlaceName` is read by `PassReadout.tsx:34` but only ever written as `null` (`LandingController.ts:37`).
- `ELEMENT_SET_NO`, `REV_AT_EPOCH` are carried in the OMM and used by nothing (`omm.ts:80-81`).
- DSO `searchAliases` (E.1).

### E.6 Inconsistent time representations (all in use)
1. Epoch milliseconds (numbers): `SimClock`, `Pass.*Ms`, `ResidentDelta.t`, request `tMs`.
2. ISO strings with `Z`: element-set `epoch`, DSO state-vector timestamps, `AnalyticResult.meta.evaluatedAt`, sweep `startIso/endIso`.
3. Space-Track raw ISO without `Z` and with microseconds (`"2024-03-15T12:00:00.000000"`, `types/index.ts:24`), normalized by a regex (`tle-updater.ts:60-64`).
4. `YYYY-MM-DD` strings: wire `launchDate` (`tle.ts:28`), SWPC `date`, history `utc_day`, `DsoRegistryEntry.launchDate`.
5. GCAT vague dates ("1998 Nov 20 0649:47", "1967 Oct?", "1975"): `ObjectMetadata.launchDate`, `LaunchRecord.date`, `lastActiveDate`, org `tstart/tstop` (`metadata.ts:85, 99-102`, `api.ts:79, 115-116`), converted to prefix-ISO of VARIABLE precision (`gcat-date.ts:14-37`).
6. The same IR field `launchDate` (kind `date`) is served at two precisions by two providers in one chain: exact day from Space-Track (`catalog.ts:83`) else year/month/day prefix from GCAT (`enrichment.ts:152`); the executor compares dates as strings (`execute.ts:930`), which is chronological only at equal precision (mixed-precision effect: unverified, not tested by me). `ageYears` uses `Date.parse` of the Space-Track date only (`catalog.ts:107-108`, `live-source.ts:210-211`).
7. Julian days: `satrec.jdsatepoch`, `julianDate()` (`time.ts:18-20`), `ProviderSample.julianDayTdb` (`dso/providers/types.ts:19`).
8. Time scales: UTC for everything except Horizons TDB, converted with a fixed 69.184 s offset (`convert.ts:9`); GMST is the IAU-82 mean sidereal time with no equation-of-the-equinoxes correction (`time.ts:4-9`).
9. Postgres `DATE` / `TIMESTAMPTZ` (`0001_init.ts:28-37`).
10. Durations in four units: days (windows, `propagation-window.ts`), seconds (`DsoRegistryEntry.*WindowSec`, `entries.ts:19-27`), minutes (`timeScan`, sweep horizon), milliseconds (TTLs).
11. Three notions of "now": wall clock, `simClock`, and the request's `tMs`; the server has no sim clock and clamps `tMs` (`routes/query.ts:41-46`).

### E.7 Documentation versus code
- `CLAUDE.md` (project instructions) says FIELD_REGISTRY has ~55 fields, 14 validation codes and 10 store slices; the code has 64 fields (`schema.ts:83-163`), 15 codes (`validate.ts:64-78`) and 12 slices (`state/MAP.md:105`).
- `state/OPEN.md:9` says the DSO default past window is 10 days; `packages/backend/src/dso/registry/entries.ts:21-26` says the constant is 1,000 days and that the comment claiming 10 days was wrong.
- `state/STATE.md:3` says "As of commit 55ff01d ... on branch sre/hardening"; the checked-out HEAD is `fa7f4c3` (merge, per `git log -1`).
- `packages/backend/src/dso/NOTES.md` lists three DSOs as enabled; the registry enables one (`state/OPEN.md:61`, `entries.ts:99`).

### E.8 Context that matters for the redesign
- The Perceptor does not work in production today: the Gemini key was rejected, "every Ask returns an error until the owner rotates it" (`state/STATE.md:65`, `state/OPEN.md:7`), and the owner still has to decide whether to keep the ~14,000-line Ask stack (`state/OPEN.md:60`).
- The cockpit removed the old query UI, so the IR has exactly one consumer path: `AskBar` -> `useAnalyticAsk` -> `/api/query/ask` (`ui/cockpit/hud/AskBar.tsx:2, 15`).
- The browser is the only place observer, selection, time and answers live; the server is stateless per request apart from files.

## The 10 most important facts for designing a many-entity world model

1. **One entity, one key.** Every store, provider, result and UI allow-set is keyed by NORAD id: wire row `tle.ts:21`, enrichment Map `store.ts:41`, history PK `0001_init.ts:24`, IR port `execute.ts:50-63`, provider contract `packages/backend/src/analytic/types.ts:16-39`, result `ids: Uint32Array` `types.ts:159`. The unit of the model is "a NORAD-numbered, Earth-orbiting thing"; 61 of 64 IR fields are properties of that thing (C.2).
2. **Everything else is a string on that thing.** Launches (6,878), orgs (2,045), programs (72), vehicles (398 types), sites (54), countries (123), observers have no ids as entities or no records at all; they are foreign-key strings joined one hop (`launch.*`, `owner.*`) and reachable from the IR only through an object (A6-A11, C.5). Launch-site coordinates exist nowhere that joins to launches (A10).
3. **DSOs are a parallel island.** 5 registry entries, 1 enabled; own id space (`dsoId`), own regime enum, own freshness enum, own pipeline and process, no links to any other entity, explicitly out of IR scope (`schema.ts:19-21`), and they sit above the TLE index space at pick time (A4, A21).
4. **There is no event store.** The only append-only log is the compiler gap log and nothing reads it (B9). Attempts and alerts are single overwritten "last day" records (B2, B5); decay, arrival of new objects, maneuvers, launches-as-events are not detected anywhere (B.3). History is a daily last-write-wins table of element sets (A17), with no enrichment, no decay dates, and a lossy `objectType`.
5. **There is no push.** No WebSocket/SSE/web-push anywhere; clients poll (60 s DSO manifest, 5 min visual list) or never refresh in-session (live catalog refreshes only on the next page load) (B.4). The one subscription-like thing, `ResidentSet`, is dev-only, in-memory, and works on `ids` sets only (B21).
6. **Time is not a first-class axis of the data.** Static snapshots (GCAT 2026-07-03, UCS 2023-05) joined onto a live catalog; one instant per program (`types.ts:22-23`); +-60 d / +14 d clamps (`propagation-window.ts:29-32`); 8+ time representations incl. variable-precision vague dates (E.6). Nothing records "since when" or "until when" for any fact or relation.
7. **Relations are untyped, unversioned foreign keys.** The only graph operator is `descendsFrom` over the separation tree (69,117 edges, 24,114 pointing at ids with no record), server-only; org hierarchy has 528 edges; multi-owner cells lose all but the first (1,808); no relation has provenance, validity interval or confidence (D). Provenance exists only per facet on the static record (D, last paragraph).
8. **Space is implicit and single-frame.** Position exists only as a function of (element set, time) -> TEME earth-radii; there is no stored location, no region, no body other than Earth and the Sun's direction (no Moon, no planets, 5,000 random stars) (A18). Observers are an unnamed 3-number parameter in 5 shapes (A13).
9. **Source precedence silently defines meaning.** First-non-null provider chains (`registry.ts:44-50`) mean a field's meaning depends on which provider answers (e.g. `objectType` can never be `component` live; `launchDate` has two precisions; `status`/`category` are frozen or unpopulated) (E.2, E.6). Routing between client and server is a hand-kept 22-field list (`capability.ts:17-29`), the thing D3 rejects.
10. **The seams that already exist are the cheap leverage points.** Sink idempotency in history (`sink.ts:31-66`), the `FieldProvider`/`SpineProvider` ports (`analytic/types.ts`), one physics home (`orbital-core`, `createLivePlane`), contracts as a leaf wire package, and the Perceptor currently being non-functional in production (`state/STATE.md:65`) mean a redesign can change the subject type without breaking a live user path, but every consumer in C.5 (18 places) assumes `noradId`.

## Verification note and what I could NOT verify

Checked: an automated pass resolved every `file:line` / `file:a-b` reference in this file against the worktree (398 references with a resolvable path: 0 missing files, 0 line numbers past end of file); bare file names are disambiguated by the "Path key" at the top and by full paths where two files share a name. Content of each cited range was read while writing; counts marked "measured" were computed from the committed `packages/backend/enrichment-data/*` files with read-only python.

Not verified / not done:
- Live catalog size and contents: the worktree has no runtime `data/` directory, so ~32k comes from comments (`analytic-prompt.ts:39`, `ResidentSet.ts:79`), not from a measurement.
- Visual-list size (~150-200 is from `CLAUDE.md`) and the gazetteer's 7,342 features (from a source comment, `gazetteer.ts:12-13`).
- Meaning of org type flag `LS` (presumed launch site; GCAT docs not in the repo).
- Whether a launch tag and the COSPAR prefix of its objects always agree.
- Whether a DSO selection has any re-resolve path across catalog swaps (only `TimelineController.ts:216-254` was read, and it resolves by `noradId`).
- Effect of comparing mixed-precision `launchDate` strings in the executor (reasoned from `execute.ts:930` and `gcat-date.ts`, not tested).
- Not read: `packages/backend/.env` (forbidden), `.env.example`, `scripts/`, `tests/` (except `tests/architecture.test.ts` KNOWN_VIOLATIONS), shaders, `GPUPicker`, `InputManager`, most of `ui/cockpit`, the Rust crate beyond its public functions, `public/sw.js` beyond its event handlers, `design/marvin/research/_untrusted/` (never opened).

