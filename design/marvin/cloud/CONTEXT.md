# Context for the star map spike (read fully)

## 1. The project in brief

Orbitwatch is a TypeScript monorepo: React + Three.js frontend, Express backend, npm workspaces.
It renders every tracked object in Earth orbit in the browser and propagates them with SGP4.

- `packages/orbital-core`: the one home for orbital physics. Pure, zero imports.
- `packages/backend`: the API. Its optional Postgres history (`packages/backend/src/history/`)
  stores one element set per object per UTC day in table `omm_daily`. Production runs plain
  Postgres 18 on Railway, with no TimescaleDB, no PostGIS and a 5 GB disk.
- `packages/frontend`: the app. A Web Worker propagates all objects about once a second for
  drawing, so the browser already knows every position for "now".
- The "Perceptor" is the owner's name for the question-answering layer. Today it compiles
  natural-language questions into a small query language and runs them on live data. The redesign
  ("Marvin") wants it to answer space-and-time questions over history too, and to push answers
  when something starts happening. Blueprint: `design/marvin/FABRIC.md`.

Conventions: ESM throughout, `.js` extensions on relative imports in backend code, strict
TypeScript, tests with `node:test` run by `tsx`.

## 2. Physics and data you must understand

**Element sets (OMM / TLE).** Each object has a small set of "mean elements". They are averaged
orbit numbers from Space-Track, stamped with an `EPOCH` (the moment they describe). They are
renewed on each object's own schedule: several times a day for the ISS and Starlink, days or
weeks for old debris. They are not exact. Public accuracy is about 1 km at epoch, growing about
1 km/day, with no error estimate. Positions within a few km of each other are within noise.

**SGP4.** The standard model that turns an element set plus a time into a position and velocity.
It is the satellite.js library here: `json2satrec(omm)` builds a record, and
`sgp4(satrec, tsinceMinutes)` returns `{position, velocity}` in **km and km/s in the TEME
frame**, or false/NaN on failure. It is very fast: about 0.4 µs per call measured on an M-series
Mac. Elements stop being trustworthy far from their epoch. The spike caps |t − epoch| at 60 days
(`MAX_TSINCE_MIN` in `runs.ts`).

**Frames.** All positions are relative to Earth's centre.
- **TEME** is the "star map": its axes stay fixed against the stars. SGP4 outputs it. An orbit is
  a nearly still loop in it.
- **ECEF** is the "Earth map": it turns with the Earth. Ground places are fixed in it.
- **Converting** TEME↔ECEF is one rotation about the polar axis by the Earth rotation angle at
  that moment: `gmst(tMs)` in `orbital-core/src/time.ts`, then `temeToEcef(v, theta)` /
  `ecefToTeme` in `rotation.ts`.
- **Geodetic latitude/altitude** (WGS84) lives in `orbital-core/src/earth.ts`. Note that
  `geodeticLatAltFromEr` takes a vector in **Earth radii** (1 ER = 6371 km, `ER_KM` in
  `units.ts`), so divide km by 6371 first. Longitude is `atan2(y, x)` of the ECEF vector.

**Catalog record shape** (`tle-cache.json` and `history/catalog-*.json`, both JSON arrays):
`{ noradId, name, omm: {OBJECT_NAME, OBJECT_ID, EPOCH, MEAN_MOTION (rev/day), ECCENTRICITY,
INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, BSTAR, MEAN_MOTION_DOT,
MEAN_MOTION_DDOT, …}, objectType, category, regime ('LEO'|'MEO'|'GEO'|'HEO'|'OTHER'),
countryCode, launchDate, period, apogee, perigee (km above surface), inclination, epoch, … }`.
A history file is the catalog as of that UTC day: each object's latest element set within the
previous 30 days.

**Catalog shape.** About 32,600 objects; about 28,500 are LEO (300–1,200 km, mostly near-circular).
They cluster in shells (Starlink near 550 km; old debris at 700–900 km) and in favoured
inclinations (about 53°, and 97–98° for sun-synchronous orbits). This clustering is why
orbit-shape filters prune well for GEO and badly for LEO.

## 3. Code that already exists (reuse it)

`packages/orbital-core/src/spacecell.ts` is **SpaceCell**: numbered boxes of 3D space around
Earth. Box = HEALPix NESTED sky direction × a log-radius height shell. Each box has 8 children,
`parentKey = floor(key/8)`, and keys are plain JS numbers up to order 15.
- `cellKey(order, x, y, z)` → key or null.
- `ang2pixNest(order, z=cosColat, phi)`, `pix2angNest`.
- `radialIndex`, `decodeKey`, `cellCentre`, `cellWidthKm`.
- `keyRangeAtMaxOrder` / `alignedKey` → BigInt for int8 storage at order 18.
- `coverBall(order, x, y, z, rKm)` → all keys touching a sphere (conservative).
- Box width ≈ r·1.0233/2^order: at 500 km altitude, about 880 km at order 3, 440 km at
  order 4, 110 km at order 6.
- **Never use 32-bit bitwise operators on keys** (they exceed 2^31). The module uses arithmetic.

`packages/backend/scripts/starmap/` holds all the spike scripts. Every script starts with a
header comment explaining it.

| File | What it is |
|---|---|
| `catalog.ts` | `loadCatalog(path)`, `parseArgs`, seeded `rng` |
| `runs.ts` | `makeProp(omm)`, `posAt`, `cellAt`, `buildRuns`/`buildRunsBy(keyFn)`: stepped sampling + bisection to ~1 s, so you get "object stayed in cell C from tIn to tOut"; `splitAtBuckets` |
| `build-index.ts`, `measure.ts`, `schema.sql`, `load.sh`, `queries.ts` | round 1: box index, accuracy, TimescaleDB load, checked queries |
| `invariants.ts`, `calibrate.ts`, `moid.ts`, `screen-*.ts`, `invariants-db.*` | round 2: orbit-shape filters, MOID, ISS/all-vs-all/box screens, DB index bench |
| `ephem*.ts`, `build-ephem.ts`, `bench-ephem.ts` | round 3: stored Chebyshev day lines |
| `coverage*.ts` | round 4, layer 2 prototype (may be partial; see TASKS T1) |
| `events*.ts`, `derive-day.ts`, `jump-dist.ts` | round 4, layer 3 prototype (may be partial; see TASKS T2) |
| `fetch-data.sh`, `setup-env.sh`, `setup-db.sh`, `check.sh` | environment |

**Worker threads.** The scripts parallelise with `node:worker_threads`. tsx does not register
itself inside workers, so each worker is started through a tiny `*-worker-boot.mjs` that
registers tsx first. Copy that pattern.

DB access: scripts read `STARMAP_DB`. If it is unset they assume the local Docker container
`orbitwatch-timescaledb`.

## 4. The proposed architecture being tested

"Keep coarse answers forever, compute fine answers on demand." Four layers:

1. **Truth: element sets kept forever, indexed by time first.** About 7 MB/day. Every other layer
   can be rebuilt from it.
2. **Coverage summaries kept forever, in the STAR MAP ONLY.** Once per day, SGP4 every object
   and record only which coarse star-map cells it visited in each period (day/hour). Store them
   inverted, as (cell, period) → list of objects. **Owner rule: space objects are never indexed in
   the rotating Earth map.** The Earth map is a separate store for ground data (regions,
   weather, airfields), built later. Ground questions rotate the ground region into the star map
   at the needed times. A long-window question becomes "merge lists →
   candidate (object, day) → exact SGP4 only on those". Long-window idea: astronomy's IVOA
   Space-Time MOC.
3. **Derived events kept forever.** Each day, compute the facts people keep asking about once:
   passes over named regions, close approaches, element jumps (manoeuvres), objects
   appearing/disappearing (decays). Questions become lookups. These are what the Perceptor pushes.
4. **The live window, in memory, nothing stored.** For hours to a few days around "now":
   SGP4 on demand, a coarse time filter for one-vs-all, a per-step spatial grid for all-vs-all,
   box runs for region-in-time.

A planner routes each question to the cheapest path by its time window and kind.

## 5. What was measured (rounds 1–3; details in `design/marvin/STARMAP.md`)

Machine: Mac, 10 cores, 16 GB.

**Round 1: stored box index**
- Full catalog, order 4 (~440 km boxes), 20 s steps + bisection: 6 h builds in ~32 s, 24 h in ~151 s.
- About 56M rows/day. 7 GB/day raw; ~1.4 GB/day TimescaleDB-compressed (segmentby bucket,
  orderby cell, t_in).
- Questions and timings:
  - region + 10-min window: 1–3 ms, 100% recall.
  - crowding at an instant: 10 ms, exact.
  - ISS proximity via `coverBall`: 50–173 ms, 100% recall.
- Same-box-only proximity caught only 12.5% of objects within 500 km. **Always cover the search
  ball.**

**Round 2: orbit-shape (invariant) filters vs grids**
- DB indexes on invariants:
  - At catalog size (65k rows) a plain scan takes ~2 ms, so indexes are noise.
  - At history size (4.9M rows, SYNTHETIC) a time-leading composite btree(epoch, perigee, apogee)
    takes ~1 ms per day and BRIN(epoch) ~2 ms.
  - A GiST on the height range alone is slower than a scan.
- In memory, the height + MOID filters keep 40–77% of the catalog around the ISS. A coarse time
  filter (SGP4 every 30 s, 20 km/s pad, refine near hits) answers the ISS hour in 0.3 s.
- All-vs-all < 10 km over 1 h (21,661 pairs):
  - in-memory grid rebuilt every 5 s: 3.0 s;
  - filter pipeline: about 10 CPU-minutes.
- Pads: mean elements are NOT where SGP4 puts objects.
  - LEO p99 is about 19 km off the mean ellipse, HEO up to 265 km, some objects thousands of km.
  - Pads must be per object, measured.

**Round 3: stored Chebyshev "day lines" instead of re-running SGP4**
- Size: about 2 KB/object/day for LEO (float32), 67 MB/day raw, 85 MB/day in Postgres.
- Accuracy: within 100 m of SGP4.
- Speed: they win only for long all-object scans (about 2.5×). They lose for single instants
  (0.6×), because fetching them costs more than running SGP4. They would be 19× heavier than the
  elements for the browser. Not recommended as the default.

**Rejected or parked**
- Storing positions (too big).
- Storing the box index forever (too big).
- An ML surrogate for SGP4 (slower and less accurate than SGP4 or Chebyshev).
- One trajectory row per day as a spatial index: its bounding box covers the whole shell.

## 6. Round 4 status (layers 2 and 3, prototyped on the Mac, cut short to free it)

**Layer 2 (coverage)**: the Mac prototype also built Earth-frame cells, against the owner's
design. That path is dropped; it only confirmed that Earth-fixed daily cells prune nothing
(99.8% of 208k India candidates were real).
- 7 days built (2026-10-12..18), with star orders 2/3/4 and Earth orders 4/5/6 in one SGP4 pass.
- About 7 min/day on the Mac: about 1.2 billion SGP4 calls/day, because bisection runs for six cell
  systems.
- Size per day: star o2 1 MB, o3 2.6 MB, o4 6.3 MB; Earth o4 12.6 MB, o5 50 MB, o6 176 MB.
- **Key finding:** a LEO object's ground track visits about 1,200 of the 3,072 Earth order-4 cells in a
  single day, so whole-day Earth summaries barely narrow "who passed over X". Earth summaries
  probably need hourly granularity. Star-map daily summaries are compact.

**Layer 3 (events)**
- About 9 of 29 days derived, at about 4.5 min/day.
- Per day: region.pass about 31k rows (8 regions), elements.jump 177–670, appeared/disappeared
  5–50.
- close.approach < 5 km comes to **70–77k rows/day**. That is far too many to be real conjunctions,
  most likely formation flyers and near-identical element sets. It must be categorised before
  trusting it.

The Mac agents' final reports may have been appended to `design/marvin/STARMAP.md`. Check it
before starting T1/T2, and do not redo what is already verified there.

## 7. Pitfalls already hit (do not rediscover them)

- **Broken orbits:**
  - NORAD 54922 (a decaying CZ-6A fragment) flips cells constantly: up to 55k runs/day and a
    516,745 km mean-ellipse deviation. Fence objects with a per-object row cap; the scripts have
    one. Report what was fenced.
  - About 30–100 objects per day fail SGP4 (mostly decayed Starlinks). Count and skip them; never crash.
- **Identical element sets:** 4 groups, 19 objects: the ISS + 9 modules/docked vehicles; the
  Tiangong stack (5); Intelsat 1002 + MEV-2; two PRC test objects. They sit at 0 km from each
  other. Exclude them from proximity results, or group them.
- **History is sparse before about 2026-06-23** (10 objects on 05-26, 14.6k on 06-23, 31.8k on
  06-30). The live app reports coverage up to 2026-10-25, which is in the future: probably
  future-dated element sets. This has not been investigated.
- **satellite.js 6.0.2:** `satrec.jdsatepochF` is undefined, but `jdsatepoch` holds the full Julian
  date. This was verified against `omm.EPOCH` (max difference 0.02 ms).
- **tsx in worker threads** needs the `*-worker-boot.mjs` shim (see section 3).
- **TimescaleDB:**
  - A plain B-tree index added to a compressed chunk does nothing. Choose `segmentby`/`orderby`
    to match the query; `segmentby = bucket` took Q2 from 106 ms to 11 ms.
  - WAL may hold about 1 GB after big loads.
- **Postgres joins:** a plain `unnest(array)` join against a large table hash-joined the whole
  table (1–3 s). A `MATERIALIZED` CTE that prunes by bucket range and cell list first took
  50 ms.
- **MOID numeric search:** polish every coarse local minimum, not only the best few. One version
  missed a real 5.9 km case.
- **Cell-cover queries must be conservative.** Sample cell boundaries at a finer order, then keep
  the parents. Test with random points.
- **Disk:** coverage at all six orders is about 249 MB/day. Plan disk before multi-day runs and
  delete large intermediates.
- **Timing hygiene:** say whether other heavy jobs were running. Benchmarks on the Mac were often
  under shared load.
