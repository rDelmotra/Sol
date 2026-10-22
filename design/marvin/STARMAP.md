# Star map spike: indexing orbital data in space and time (2026-10-20)

> Spike on branch `spike/starmap` (from `marvin/fabric`). Local only: Colima + TimescaleDB 2.30 /
> PostGIS 3.6 on Postgres 16. Production was not touched; one past day was read from the live
> app's public `/api/history/at` endpoint like any visitor.

## What we built

The space around Earth is cut into numbered boxes that hold still against the stars (the TEME
frame SGP4 outputs). A box is a HEALPix sky tile × a height shell that thickens with height, so
boxes stay roughly cube-shaped from low orbit to the Moon. Each box splits into 8 smaller ones, and
a box number is one integer. Every satellite is run forward with SGP4, and we record each box it
passes through with exact entry and exit times. One row = one object inside one box during one
30-minute time bucket. Exact positions are never stored; any second can be recomputed from the
element set the row points to.

- `packages/orbital-core/src/spacecell.ts`: box numbers, parents/children, storage ranges,
  `coverBall` (all boxes touching a sphere). Zero imports, 134 orbital-core tests pass.
- `packages/backend/scripts/starmap/`: `runs.ts` (one object → runs), `build-index.ts`
  (whole catalog, worker threads, row guard), `measure.ts` (accuracy vs 1 s truth),
  `schema.sql` + `load.sh` (TimescaleDB), `queries.ts` (three questions checked against
  brute-force SGP4).

## Numbers

**Build.** Order 4 (~440 km boxes in LEO), sampled every 20 s, box changes bisected to ~1 s.
Full catalog (~32.6k objects): 6 h in ~32 s, 24 h in ~151 s on the Mac.
10 s and 20 s steps miss the same visits; misses are ~1 s corner clips, below the ~1 km
element-set error.

**Size.** ~56M rows/day at order 4 (LEO objects change box every ~45 s). 111M at order 5.

| | per 6 h | per day |
|---|---|---|
| Uncompressed (heap + 2 indexes) | 1.7 GB | ~7.1 GB |
| Compressed (segmentby bucket, orderby cell, t_in) | ~350 MB | ~1.4 GB |

**Questions** (both days: 2026-10-20 live catalog and 2026-07-15 history, same table):

| Question | Result | Time |
|---|---|---|
| Q1 who is in this region of space, 10-min window | recall 100%, precision 100% / 99.9% | 1–3 ms |
| Q2 how many objects in each region at one instant | exact match, every box and shell | 10–11 ms |
| Q3 same-box with ISS only | caught 12.5% within 500 km | — |
| Q3 v2 ball cover around ISS, then exact refine | caught 100% at 50, 100 and 500 km | 50–173 ms + ≤0.12 s refine |

## What we learned

1. **The index works as a sieve.** Region and crowding questions are exact and take
   milliseconds. The slow exact method took 7.4 s for Q1.
2. **Same box is not "near".** Two objects 10 km apart can sit on either side of a box wall.
   Proximity questions must cover the whole search ball (`coverBall`), then refine with SGP4.
3. **Compression is mandatory.** It cuts size ~5×. Segment by bucket, not just order by cell:
   Q2 went from 106 ms to 11 ms. A plain `(bucket, t_in)` index does nothing on compressed chunks.
4. **Size is the real cost.** ~1.4 GB/day compressed. Production's plain Postgres has no
   compression and a 5 GB disk, so the stored index cannot live there as-is.
5. **Bad orbits must be fenced.** One decaying fragment (NORAD 54922) made 55k rows/day against
   ~2.2k for the next worst. The row guard drops and lists such objects.
6. **Shared element sets.** Nine "objects" sit at 0 km from the ISS: ZVEZDA, DESTINY, UNITY,
   POISK, NAUKA and docked vehicles share its exact element set. Any proximity feature must
   group these.
7. **10- vs 30-minute buckets** made no difference to answers; 30 min is slightly smaller.

## Recommended shape for the real thing

- **Do not store every day forever.** Keep the stored index for a rolling window around "now"
  (e.g. the last 7 days plus 3 days ahead, ~14 GB compressed), and rebuild any other day on
  demand from `omm_daily` (~2.5 min/day on one machine). The element sets stay the truth.
- **Store answers forever, not boxes.** Passes, close approaches and "entered region" facts go
  into the fabric log as events with time ranges (`FABRIC.md` B6/B7).
- **Coarser stored order is an option.** Order 3 halves the rows; finer questions narrow with
  the exact refine step.
- **Production needs the TimescaleDB image** (compression) before any stored index ships.

## Open

- The Earth map (ECEF) and Sun map (GSE) are not built. They fuse with this one by rotating at a
  given instant.
- TEME vs J2000 (~0.3° today) is tagged, not converted.
- The live app reports history coverage to 2026-10-25, five days ahead: probably future-dated
  element sets. Not investigated.
- One extra object in Q1 on 2026-07-15 (precision 99.9%) is likely the ~1 s boundary
  resolution. Not traced.

## Round 2 (2026-10-21): orbital-invariant filters vs grids

Question: is "index the orbit's shape" (perigee/apogee, MOID; B-tree/GiST) what SSA uses, and
does it beat our boxes? Public literature: every screener descends from the Hoots, Crawford &
Roehrich 1984 filters, but run as in-memory maths; large-catalog papers compare in-memory grids
and k-d trees, not database indexes. Operators' internals are not public.

**Database indexes on invariants** (`invariants-db.*`; history table is 4.89M SYNTHETIC rows):

| | best | time | note |
|---|---|---|---|
| catalog (65k rows) | 2D GiST on point(perigee, apogee) | ~1 ms | plain scan ~2 ms; btree(perigee) worse than a scan |
| history, one day | btree(epoch, perigee, apogee) | ~1 ms | BRIN(epoch) 2 ms, 40 kB; GiST(alt range) 180 ms, slower than a scan (62 ms) |
| history, 30 days | BRIN(epoch) / composite btree | 23–26 ms | 1-day hypertable 42 ms |

Time must lead any history index; the height filter adds little.

**In-memory filters** (`calibrate.ts`, `moid.ts`, `screen-*.ts`), all 100% recall:

- Mean elements are not where SGP4 puts objects: LEO p99 19 km off the mean ellipse, HEO up to
  265 km, some objects thousands of km. Safe pads must be per object, which weakens the filters.
- ISS within 50/100/500 km over 1 h: height+MOID filters keep 40–77% of the catalog; coarse
  time filter (SGP4 every 30 s, 20 km/s pad, then 1 s near hits) answers in 0.3 s vs 6.6 s
  brute force and 2.3–4.2 s with filters. Around a GEO target the filters do cut to 3–5%.
- All-vs-all < 10 km over 1 h: 21,661 pairs. In-memory grid rebuilt every 5 s: 3.0 s total.
  Height filter keeps 28.6% of 531M pairs, MOID keeps 82% of those; the filter pipeline needs
  ~10 CPU-minutes. Grid wins ~1,500×. Height filter + grid: no measurable gain.
- Region boxes: the height filter trims propagation to 5–8% for MEO/GEO boxes, nothing in LEO.
- Shared element sets: 4 groups, 19 objects (ISS stack, Tiangong stack, Intelsat 1002 + MEV-2,
  two PRC test objects).

**Verdict.** In the crowded low-orbit shells, where most of the catalog lives, orbit-shape
filters barely prune, and a time-stepped in-memory grid wins. Orbit-shape filters pay off for
high-altitude targets and as a free prefilter there. Database indexes matter only for history
scale, keyed by time first.

**Updated recommendation.** The database stores element sets (indexed by time) and results
(events). Proximity and region questions run in memory: a coarse time filter for one-vs-all, a
per-step grid for all-vs-all, the box index for region-in-time, and the height filter in front
when the target is above LEO.

## Round 3 (2026-10-22): stored day lines instead of re-running SGP4

Idea: when elements arrive, run SGP4 once per object per UTC day, store the path as piecewise
Chebyshev polynomials (like SPICE SPK), and answer "where was it at t" from the stored line.
Files: `ephem.ts`, `build-ephem.ts`, `bench-ephem.ts`, `ephem-db.ts`. Bench used the live
2026-10-20 catalog (the 2026-07-15 file had been cleared from /tmp).

- Size at 100 m tolerance, float32 coefficients: LEO 2.1 KB, HEO 3.7 KB, MEO 0.9 KB, GEO 0.2 KB
  per object per day. 67 MB/day raw, 85 MB/day in Postgres (~31 GB/year) vs 20.7 MB/day for
  elements. Coefficients barely compress (gzip 65 MB vs 3.45 MB for the elements JSON).
- Build: ~2 min per day on 9 workers. Accuracy: within 100 m of SGP4 everywhere (LEO median 32 m).
  33 objects fenced (SGP4 errors, mostly decayed Starlinks; 54922 by size).
- End to end, single thread, both fetched from the same Postgres:

| Scenario | SGP4 from elements | Stored lines | Lines vs SGP4 |
|---|---|---|---|
| one instant, all objects | 163 ms | 263 ms | 0.6× (loses: fetch) |
| 1 h at 10 s, all objects | 4.9 s | 2.0 s | 2.4× |
| 1 day at 60 s, all objects | 19.8 s | 7.4 s | 2.7× |
| ISS at 1,000 instants | 0.6 ms | 0.4 ms | tie |
| 985 objects, one instant | 6.3 ms | 9.4 ms | 0.7× |

Verdict: SGP4 costs ~0.4 µs per call here, so the line only saves 2–3× on evaluation, and its
fetch is 4× heavier. Lines win only for long scans over all objects (~2.5×), lose for single
instants, and would be a 19× regression for the browser. Parallel SGP4 across cores buys the same
2.5× without 25 GB/year. Not recommended as the default; possibly useful as a cache for repeated
heavy scans, or as the common format for non-SGP4 sources (Horizons, operator ephemerides).

## Round 4 (Mac, partial, 2026-10-23): layers 2 and 3

Cut short to free the Mac; the cloud handbook (`design/marvin/cloud/`) finishes it. Measured under
heavy shared load (load average 11–14 on 10 cores).

**Layer 2: coverage summaries** (`coverage*.ts`; 7 days, 2026-10-12..18)

- Star map, MB/day: order 2 1.0, order 3 2.6, order 4 6.3 (1.8 / 4.8 / 11.5 GB per 5 years).
  A LEO object visits only 34 / 73 / 162 star cells per day, because its orbit is a nearly fixed
  ring against the stars.
- Space box question (order-3 LEO box, 7 days): 38,884 candidate object-days at 99.8% precision,
  refine 22 s, ~10× faster than brute force. Recall is 100% on unfenced objects. The orbit-shape
  shortcut alone reached 79.6% precision.
- Earth-frame cells were also built, against the owner's design (satellites are indexed only in
  the star map; the Earth map is a separate later store). They pruned nothing: 99.8% of 208k India
  candidates were real. Dropped.
- India via the shortcut alone: recall 99.99%, precision 97.9% (LEO 99.7%, GEO 22%). Over long
  windows, almost every LEO object whose inclination reaches India's latitude passes over it.
- Grazes shorter than 20 s were missed by the refine key (49 India and 42 box object-days vs the
  10 s truth). The worker now keys on cell + pass flag; the fix has NOT been re-run.
- Build: ~250–450 s per day for one SGP4 pass feeding all orders. Peak RSS 2.8 GB.

**Layer 3: derived events** (`events*.ts`, `derive-day.ts`, `jump-dist.ts`, `ca-composition.ts`;
12 days, 2026-09-20..10-01)

| Kind | Rows/day | Verdict |
|---|---|---|
| object.appeared / disappeared | 5–49 | keep forever. All 196 disappearances were stale elements aging out of the 30-day window, not decays; decay detection was not validated |
| elements.jump (position error > 16.3 km and Δa > 1 km) | ~450 (61% Starlink) | keep forever. The ISS reboost on 09-27 was caught (+1.83 km) |
| close.formation | ~220 | keep forever |
| close.approach < 5 km | 69–78k | real geometry (97% have relative speed > 2 km/s; matches a uniform-density estimate), but too many. Store only a tighter or ranked subset (e.g. < 1 km) |
| region.pass, 8 regions | 873k naive / 30.9k packed | compute on demand or keep packed (17 MB/day) |

- Derive time: 3–4 min/day on 5 threads (close approaches 130–200 s, region passes 28–53 s).
  Storage ~32.5 MB/day, ~59 GB per 5 years with packed passes.
- Lookups: 1–10 ms (ISS over India 6.1 ms, 44 passes, matching brute force within 5 s except one
  5 s corner clip; 5 recomputed close approaches agree to 0.001 km).

## Round 4 — T0 (cloud, 2026-10-22): setup and sanity

Machine: cloud container, 4 cores, 15 GB RAM, no swap, Node 22.22.0, ~29 GB disk free. No other
jobs running (load average ~2 during the runs, all from the runs themselves). Data: live catalog
plus 42 history days (weekly 2026-06-23..09-15, daily 2026-09-20..10-18), ~1 GB, all fetched
with `fetch-data.sh`, no failed days. Local TimescaleDB in Docker.

- `build-index.ts --order 4 --step 20 --hours 3`: 32,778 objects in, 32,768 indexed, 10 skipped
  (no valid position), 7,072,328 rows, 51M SGP4 calls, 56.6M rows/day extrapolated. Wall 12.6 s
  on 4 workers, peak RSS 571 MB. Round 1 had ~7M rows and ~56M/day, so the numbers reproduce.
  This machine is about 3× slower than the 10-core Mac for whole-catalog jobs (the Mac did 3 h in
  ~4 s at 30 s steps).
- `measure.ts --hours 1` (480 sampled objects): order 4 at 20 s misses 17 of 27,117 visits
  (0.06%), all 1 s corner clips; mean entry/exit error 0.28 s. Order 3 at 20 s misses 0.03%.
  Same range as round 1.

Verdict: the environment reproduces the Mac's numbers. Check passes.
