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

## Round 4 — T1 (cloud): star-map coverage summaries

Machine: cloud container, 4 cores, 15 GB RAM, no swap, Node 22. Nothing else heavy ran, except two stretches
where I ran a debug query beside the brute-force truth (those truth days show 74-81 s instead of 48 s; noted
below). The container restarted once mid-task; all caches were checked and re-run from the last complete day.

**What changed in the code (all in `packages/backend/scripts/starmap/`).** The Earth-frame cell path is
gone from coverage code. Satellites are indexed only in the star map (TEME). A ground question is answered by
rotating the ground region into the star map for each time slice (`coverage-cover.ts`), then reading star-map
lists, then an exact SGP4 check. Files: `coverage.ts` (daily build), `coverage-worker.ts` (build / refine /
brute force), `coverage-cover.ts` (India into the star map; randomized conservative-cover test),
`coverage-scan.ts` (exact pass scan; graze test), `coverage-codec.ts` (file format, now keyed by
granularity), `coverage-query.ts` (Q-L1, Q-L2), `coverage-shortcut.ts` (Q-L3), `coverage-diag.ts`
(explains every miss). `coverage-hourly.ts` deleted (Earth-frame only).

**How the summaries work, in plain words.** The space around Earth is cut into numbered boxes that hold still
against the stars. For one UTC day we run SGP4 for every object and note which boxes it visited, in which
period (whole day, each hour, each 10 minutes). The result is stored upside-down: for each (box, period) a
list of the objects that were in it. "Who passed through box B in 29 days" then means reading 29 short lists.
"Who passed over India" first needs the star boxes that the sky above India occupies in each period: India
turns once around the polar axis per day, so over a whole day it sweeps a full ring of boxes, but within one
hour it covers only a sector. Hence hourly lists are much sharper for ground questions.

### Numbers

Question definitions. **Q-L1:** an object's sub-satellite point (geodetic, inside a rough 18-vertex India
polygon) at any height inside the star map's radial range. **Q-L2:** the object is inside order-3 box 9138
(a LEO box, altitude 0-870 km, 5,594 objects on 2026-10-18; the same box the Mac used). Window: 29 days,
2026-09-20..10-18, each day using its own element sets. Fenced as before: NORAD 54922 (removed from every
question and from truth). "Truth positive" means at least one 10-second sample inside.

**Build, per day** (29 days, 4 workers, one star-map SGP4 pass at order 4, orders 3 and 2 are exact parents):

| step | wall/day | SGP4 calls/day | sgp4 / sort / encode (s) | peak RSS |
|---|---|---|---|---|
| 20 s sample + 1 s bisection | 133.6 s (131-141) | 407 M | 95.6 / 26.9 / 10.9 | 4.8 GB |
| **10 s sample + 1 s bisection (used)** | **150.0 s (148-162)** | 498 M | 114.5 / 25.7 / 9.6 | 4.8 GB |

(The Mac's six-cell-system job took 250-450 s/day; one star-only pass is cheaper. The 10 s build is 12% slower
than the 20 s build.) Per day, skipped: ~84 objects with no valid SGP4 position, ~1 fenced, ~0.6 broken
element sets; 45 object-days over the row cap (a decaying object, mostly NORAD 69730, flips boxes constantly).
Weekly days (2026-06-30..09-15) were NOT built: not needed for the 29-day window and it would cost about
34 min and 3.9 GB for no new result.

**Bytes per day by order x granularity** (mean of 29 days; `.bin` file = lists + directory; 5-year = x1,826):

| granularity | order 2 | order 3 | order 4 | all three orders |
|---|---|---|---|---|
| whole day | 0.96 MB (1.8 GB/5y) | 2.60 MB (4.7 GB) | 6.27 MB (11.4 GB) | 9.9 MB (18.0 GB) |
| each hour | 14.8 MB (26.9 GB) | 31.7 MB (57.8 GB) | 70.8 MB (129 GB) | 117 MB (214 GB) |
| each 10 min | 21.7 MB (39.6 GB) | 47.0 MB (85.8 GB) | 100.3 MB (183 GB) | 169 MB (309 GB) |

Disk for the 29 days: day files 286 MB, hour files 3.40 GB, 10-min files 4.90 GB (the 10-min files were
deleted after the runs to free disk). Lists per file at order 4: 84k (day), 1.05 M (hour), 3.2 M (10 min); most
of the hour/10-min size is the directory of (box, period) keys, not the object lists, so it would compress.
Going from a 20 s to a 10 s build changed storage by under 0.1%.

**Q-L1 India, 29 days** (cover cost to rotate India into the star map: 0.04 / 0.15 / 0.65 s per day at orders
2/3/4; it needs no data and could be precomputed). True answer (exact refine, 1 s near India): 857,161 object-days (LEO 825,728, HEO 22,024,
MEO 8,436, GEO 877, other 96), 2,327,933 passes. That is 91% of all object-days in the window, so almost
nothing can be pruned. Refine = exact SGP4 (20 s step, 1 s step near India) on candidate windows.

| gran | order | candidate obj-days | answer share of candidates | candidate window per obj-day | merge s (29 d) | open+parse s | refine s/day (3-day sample) | total s/day |
|---|---|---|---|---|---|---|---|---|
| day | 2 | 945,519 | 90.7% | 24.0 h | 0.14 | 0.13 | 78.0 | 78.0 |
| day | 3 | 945,448 | 90.7% | 24.0 h | 0.16 | 0.13 | 79.1 | 79.1 |
| day | 4 | 927,824 | 92.4% | 24.0 h | 0.59 | 0.13 | 77.5 | 77.5 |
| hour | 2 | 903,151 | 94.9% | 8.7 h | 0.14 | 4.7 | 42.8 | 43.0 |
| hour | 3 | 892,595 | 96.0% | 6.4 h | 0.28 | 4.7 | 37.1 | 37.3 |
| hour | 4 | 882,024 | 97.2% | 5.3 h | 1.57 | 4.7 | 34.2 | 34.4 |
| 10 min | 2 | 897,086 | 95.5% | 2.3 h | 0.34 | 6.4 | 29.1 | 29.3 |
| 10 min | 3 | 883,126 | 97.1% | 1.4 h | 0.62 | 6.4 | 25.6 | 25.8 |
| 10 min | 4 | 872,068 | 98.3% | 1.0 h | 2.73 | 6.4 | 23.2 | 23.5 |

(merge and open are totals over 29 days; refine is per day on 4 workers, averaged over 3 sample days
(2026-09-20, 10-04, 10-18) where each variant's own windows were run; on those days every variant returned the
same passes as the union run, 0 mismatches.) Brute force for comparison: 48 s/day on the same 4 cores (10 s
step, 282 M SGP4 calls, clean runs), but it only knows 10 s resolution, whereas refine gives pass times to 1 s.
Daily candidates by regime: GEO 47,876 candidates vs 877 true (daily summaries cannot tell GEO objects apart:
a GEO sits still over the Earth, so it sweeps the whole star-map ring in a day); hourly order 4: 5,939;
10-min order 4: 3,058.

**Q-L2 box 9138, 29 days.** True answer (exact refine, 1 s near the box): 156,759 object-days (LEO 156,730, HEO 29), 2,298,161 passes.

| gran | order | cover cells | candidate obj-days | answer share | candidate window per obj-day | merge s (29 d) | open+parse s | refine s/day | missed vs 1 s refine (obj-days / passes) |
|---|---|---|---|---|---|---|---|---|---|
| day | 2 | 1 | 274,013 | 57.2% | 24.0 h | 0.00 | 0.15 | 14.5 | 0 / 0 |
| day | 3 | 1 | 156,829 | 100.0% | 24.0 h | 0.00 | 0.15 | 9.5 | 4 / 5 |
| day | 4 | 8 | 156,829 | 100.0% | 24.0 h | 0.00 | 0.15 | 9.5 | 4 / 5 |
| hour | 2 | 24 | 274,013 | 57.2% | 15.1 h | 0.04 | 4.2 | 11.5 | 0 / 34 |
| hour | 3 | 24 | 156,829 | 100.0% | 15.0 h | 0.01 | 4.2 | 7.8 | 7 / 103 |
| hour | 4 | 192 | 156,829 | 100.0% | 15.0 h | 0.03 | 4.2 | 7.8 | 7 / 103 |
| 10 min | 2 | 144 | 274,013 | 57.2% | 3.3 h | 0.04 | 5.9 | 7.6 | 0 / 34 |
| 10 min | 3 | 144 | 156,829 | 100.0% | 2.8 h | 0.03 | 5.9 | 5.2 | 7 / 103 |
| 10 min | 4 | 1,152 | 156,829 | 100.0% | 2.8 h | 0.06 | 5.9 | 5.2 | 7 / 103 |

(The "cover cells" is cells per day: the box itself, its parent, its 8 children, times the number of periods.
"Missed vs 1 s refine" counts passes that exist at 1 s resolution but are not in the summary: sub-10-second
corner clips of the box and edge rounding of a few seconds; they are not misses against the 10 s truth, see
below.) Brute force: 48 s/day. So the box question is 5-9x faster than brute force with day/hour/10-min
order 3 summaries, and about 6x with the day-only summary alone (9.5 s/day).

**Recall against brute-force SGP4 truth (the hard rule).** Truth: ALL objects (about 32.6k), every one of the
29 days, 10 s step, 8,640 steps per object per day, 282 M SGP4 calls per day, 4 workers: 48 s per day clean
(74-81 s on the 13 days that ran beside my debug job). Truth positives: India 857,003 object-days
(2,892,029 object-10-minute slices), box 156,521 object-days (2,588,555 slices).

| | candidates from summaries (all 9 variants, with the over-row-cap fix below) | final answer after exact refine |
|---|---|---|
| India, object-days | 857,003 / 857,003 = **100%**, all 2,892,029 slices inside a candidate period | 857,001 / 857,003 |
| Box, object-days | 156,521 / 156,521 = **100%**, all 2,588,555 slices inside a candidate period | 156,520 / 156,521 |

The three object-days the refine does not reproduce are not real passes: they are single-sample SGP4 garbage
from decaying objects. NORAD 34861 (2026-10-04) and 35248 (2026-10-18) each "pass over India" in exactly one
10 s sample whose radius is 9,092 km and 732,602 km for orbits of about 6,900 km radius. NORAD 61486
(2026-10-18) is re-entering; SGP4 returns a position that jumps to a different box every second (radius
falling 15 km/s), and exactly one second lands in box 9138. I count these as truth artefacts, name them, and
do not claim they are passes. A 500 km near-zone margin did not recover 61486 either (tested on 2026-10-18).

(The refine answers above, 857,161 and 156,759, are larger than the 10 s truth counts, 857,003 and 156,521,
because the refine steps 1 s near the target and also catches visits shorter than 10 s.)

**Lead's independent check** (separate code: own SGP4 loop over the raw catalog, own sub-satellite point, not the
worker's scan; single thread, 220 s): 2026-10-04 at 10 s, 32.6k objects. Box 9138: 5,387 objects, the same as the
truth file, and every one is in that day's order-3 list for box 9138 (0 missing). India: 29,510 vs truth 29,511;
the one difference is NORAD 34861 (COSMOS 2251 DEB), which on that day has a valid SGP4 position in only 190 of
8,640 samples, at radii up to 13.6 million km. That confirms it as SGP4 garbage, not a pass.

**Bugs found and fixed on the way (recall below 100% was real, twice).** (1) First full run, 20 s build:
candidates missed 45 India and 5 box truth object-days (99.99%). 45 India + 3 box were the objects the build
drops for flipping boxes too often (the row cap); fix: those objects (listed in `report.jsonl`, 1-4 per day)
are always candidates. The other 2 box misses were 1 s corner clips of box 9138 lying between two 20 s
samples that were both in the same neighbour box: a 20 s sample + bisection cannot see an out-and-back
excursion. Fix: sample every 10 s, aligned with the truth grid, so every truth sample is also a build
sample (cost: +12% build time, no storage change). With this, recall is 100% on every variant. Residual:
visits shorter than 10 s can still be missed by the summaries (11 object-days in 29 days were found at
1 s resolution that the summaries do not list: 4 at order 3/4 daily, 7 hourly/10-min); that is the
limit of the sampling, and the planner should treat the summary as "nothing missed at 10 s resolution".
(2) The Mac's graze fix (refine keys on cell + pass flag) is replaced by a stronger one: wherever an object is
near the target the refine steps 1 s, so no pass of 1 s or more can fall between samples (`coverage-scan.ts`,
unit-tested: a 2.5 s graze is found, and the old coarse-only scan misses it). This was re-run and confirmed:
no refine-only gaps remain beyond the three garbage object-days above.

**Q-L3: orbit-shape shortcut** (from elements alone: can the orbit reach India's latitudes; GEO by longitude;
height band and latitude band for the box; "plane" also tests whether the box direction is near the orbit
plane at some hour). Per object-day, vs the 10 s truth on all 29 days:

| India | truth+ | false negatives | false positives | recall | precision |
|---|---|---|---|---|---|
| LEO | 825,704 | 0 | 2,540 | 100% | 99.7% |
| MEO | 8,405 | 0 | 8,958 | 100% | 48.4% |
| GEO | 877 | **41** | 5,838 | **95.3%** | 12.5% |
| HEO | 21,921 | 0 | 19,832 | 100% | 52.5% |
| other | 96 | 0 | 1,495 | 100% | 6.0% |
| all | 857,003 | 41 | 38,663 | 99.995% | 95.7% |

| Box 9138 | truth+ | false negatives | false positives | recall | precision |
|---|---|---|---|---|---|
| height + latitude band, LEO | 156,492 | 0 | 168,242 | 100% | 48.2% |
| height + latitude band, all regimes | 156,521 | 0 | 168,764 | 100% | 48.1% |
| band + orbit plane, all regimes | 156,521 | **1** | 45,592 | 99.9994% | 77.4% |

(HEO/MEO have 29 / 0 true box positives; they appear in the false positives.) For comparison the summaries
have 0 false negatives, and precision 92.4% (India, day o4), 97.2% (hour o4), 98.3% (10-min o4), 100.0%
(box, order 3).

### 1,826-day extrapolation (linear in days from the 29 measured; nothing here was run at 5 years)

Storage per option is in the table above (day order 4 only: 11.4 GB; day orders 3+4: 16.2 GB; hour order
4: 129 GB; 10-min order 4: 183 GB). Query time, summary read + refine on 4 cores:

| question | variant | merge+open (s) | candidates | refine | brute force at 48 s/day |
|---|---|---|---|---|---|
| India | day o4 | 45 | 58.4 M obj-days | 39.3 h | 24.3 h |
| India | hour o4 | 395 | 55.5 M | 17.4 h | 24.3 h |
| India | 10 min o4 | 574 | 54.9 M | 11.8 h | 24.3 h |
| box 9138 | day o3 | 9.6 | 9.9 M | 4.8 h | 24.3 h |
| box 9138 | hour o3 | 263 | 9.9 M | 3.9 h | 24.3 h |
| box 9138 | 10 min o3 | 373 | 9.9 M | 2.6 h | 24.3 h |

These are "list every pass with its exact times" jobs: the answer itself is 2.3 M passes per 29 days (India),
so the refine time is the cost of producing the answer, not of finding it. The read of the lists is seconds.

### Verdict in plain words

**Recall.** Every one of nine variants (day / hour / 10 minutes x orders 2 / 3 / 4) finds every truth
object-day and every truth 10-minute slice for both questions, once the build samples every 10 seconds and
the objects the build cannot index are always checked. The earlier 99.99% was real, found, and fixed twice.

**Where summaries beat the orbit-shape shortcut.** (a) Box questions: the shortcut keeps 2 objects for every
real one (48% precision, or 77% with the plane test, which also misses one real pass); the order-3 summary
keeps only the real ones (100%) and, since the box itself is a summary cell, nearly all of the work is
reading a 29-entry list. (b) Ground questions about stationary or slow objects: the shortcut loses 41 real GEO
object-days (95% GEO recall) and keeps 12% GEO precision; hourly summaries cut GEO candidates from 47,876 to
5,939 (day vs hour, order 4). (c) Time: summaries say when, so the refine looks at 1-5 hours of the day
instead of 24 h; this makes the exact answer 1.5-3.4x cheaper than the daily summary. (d) Anything where
"closest approach" wording would need the shape filter to be guessed: summaries are mechanical and have no
tunable pads.

**Where they do not.** (a) India over long windows: 91% of all object-days are real passes, so there is nothing
to prune; the shortcut (95.7% precision, one cheap check) is as sharp as the daily summary (92.4%), and the
daily summary + exact refine (77.5 s/day) is slower than brute force at 10 s (48 s/day) because the refine
does finer work. Only hourly and 10-minute summaries beat brute force (34 s and 23 s per day, 1.4x and 2.0x)
and give pass times to 1 s. (b) Storage: hour and 10-minute lists cost 11-16x the daily ones for 2-3x speed.

**Recommendation.** Keep forever: daily summaries at orders 3 and 4 (2.6 + 6.3 MB/day = 16.2 GB per 5 years;
order 4 alone is 11.4 GB). Order 2 is useless (57% precision on the box, no better for India). Drop 10-minute
summaries (183 GB at order 4 for a further 1.5x). Hourly order 4 (129 GB per 5 years) is worth keeping
only as a rolling window, for example 90 days = 6.4 GB, for ground questions near "now"; beyond that, answer
India-type questions with the shortcut plus on-demand SGP4 on the shortcut's survivors, and answer box-type
questions from the daily lists. Always check the unindexable objects (1-4 per day) and treat the summary as
exact at 10 s resolution. Production's 5 GB disk fits the daily layer only if stored compressed on a larger
disk; the daily order-4 layer alone is 11.4 GB per 5 years.

**Caveats.** All times are from one 4-core, 15 GB machine, about 3x slower than the Mac for whole-catalog
jobs. Refine times for the nine variants were measured on 3 of 29 days and scaled; union refine and the
summary read were measured on all 29. The 1,826-day figures are straight-line extrapolations. The India cover
is derived to be conservative and was checked by a randomized test (heights from below ground to 60,000 km,
points on the polygon edges), not proved. The weekly days were not built. Not done: compression of the hourly
directories; a trial of 5 s sampling.

Reproduce (from the repo root):
```
npx tsx packages/backend/scripts/starmap/coverage.ts --days daily --workers 4 --step 10 --force     # 29 days, ~75 min
npx tsx packages/backend/scripts/starmap/coverage-query.ts --stage truth --truth-days <comma list of the 29 days>  # ~25 min
npx tsx packages/backend/scripts/starmap/coverage-query.ts --stage query --ndays 29 --timing-days 3 --workers 4   # ~80 min
npx tsx packages/backend/scripts/starmap/coverage-shortcut.ts ; npx tsx packages/backend/scripts/starmap/coverage-diag.ts
bash packages/backend/scripts/starmap/check.sh
```
Raw outputs are in `packages/backend/data/coverage/q/report.txt`, `.../q/shortcut.txt`, `.../report.jsonl` (step 10 s)
and `.../q20/report-step20.jsonl` (the first, 20 s run, kept for comparison).

## Round 4 — T2 (cloud): derived events

Machine: the same cloud container as T0/T1 (4 cores, 15 GB RAM, no swap, Node 22), worker budget 4 threads. During the
29-day derive nothing else heavy ran (I only ran two few-second report queries). The verification scripts and the
checks below ran one at a time afterwards. Local TimescaleDB 2.31 in Docker for the table `starmap.event`.

**What a "derived event" is, in plain words.** Once a day a job looks at that day's element sets and writes down the
facts people keep asking about, so a question later becomes a lookup instead of a calculation. The facts: a new object
appeared; an object vanished; an object's orbit changed suddenly (`elements.jump`, a manoeuvre candidate); two objects
flew within a few km of each other (`close.approach`) or stayed together (`close.formation`); an object flew over a
named region (`region.pass`, 8 regions). A "regime" is the orbit family: LEO is low (up to about 2,000 km), MEO is
medium (GPS and similar), GEO is the 36,000 km ring where satellites hover over one spot, HEO is the stretched
elliptical orbits. "p50 / p90 / p99" mean: half / nine in ten / ninety-nine in a hundred of the cases are below this.

### What changed in the code (all in `packages/backend/scripts/starmap/`)

- `derive-day.ts` (the daily job) is now resumable and transactional: a day is written in one transaction, and a
  re-run skips days already recorded. It runs 4 workers, writes its caches into `data/events/` (gitignored) and reuses
  the Mac pipeline for the grid.
- `events.ts`: the India polygon is now **the same `INDIA_POLY` as T1** (`coverage-lib.ts`), so results can be
  cross-checked. The other seven regions are still the Mac's rough polygons.
- Region passes (`events-worker.ts`, new `events-region.ts`): the Mac's 20 s step + bisection can miss a pass shorter
  than 20 s. Now every 20 s bracket is walked at 1 s if the straight line between its two sample points could touch
  a region edge (chord test in `events.ts`; a step longer than 400 km is always walked). Same idea as T1's graze fix.
- `events-ca.ts` (new): classification of close approaches (below). `events-report.ts`, `verify-events.ts`,
  `jump-study.ts`, `ca-categorize.ts` are new analysis/verification scripts. `events-queries.ts` and `jump-dist.ts`
  were adapted. New unit tests: `events-region.test.ts` (a 3 s graze between two samples is found and the old logic
  misses it), `events-region-geo.test.ts` (chord tests, antimeridian, circle), `events-ca.test.ts`.

### Numbers

**Time to derive.** One day = about 3.7 minutes on 4 cores, so all 29 days took **107.6 minutes** (under the 2-hour
line, so every kind was derived for every day; nothing was skipped or sampled). Mean per day over 29 days:

| part | seconds/day | share |
|---|---|---|
| diff (appeared, disappeared, jumps) | 0.2 | 0.1% |
| region.pass, 8 regions, 1 s resolution | 66.1 | 30% |
| close approaches: all-vs-all grid | 140.0 | 63% |
| close approaches: formation check + exact refine | 12.3 + 2.7 | 7% |
| load + worker start | about 1.2 | 0.5% |
| **total** | **222.6** (min 215.7, max 240.8) | |

Peak memory about 1.2 GB (polled every 2 s). A full 1,826-day backfill on this machine would be 222.6 s x 1,826 = about
113 hours (4.7 days) of 4 cores; the close-approach grid is 70% of that. The first day (2026-09-20) has no previous
day, so the three diff kinds cover 28 days. Every day the job skips about 90 objects whose SGP4 output is garbage
(mostly decaying objects, "fenced"), 0.6 with unusable elements, and excludes 5 groups of identical element sets.

**Rows and storage, per kind** (table `starmap.event`, 29 days; "storage" is heap + the three indexes, measured by
copying each kind into its own table with the same indexes; whole table 529 MB):

| kind | rows (29 d) | rows/day | MB/day | 5 years (linear x1,826) |
|---|---|---|---|---|
| object.appeared | 641 | 22 | 0.01 | 40 k rows, 0.03 GB |
| object.disappeared | 390 | 13 | 0.01 | 25 k rows, 0.02 GB |
| elements.jump | 8,968 | 309 | 0.13 | 0.56 M rows, 0.24 GB |
| close.formation | 4,753 | 164 | 0.05 | 0.30 M rows, 0.09 GB |
| close.approach (stored: under 1 km, relative speed 0.5 km/s or more, label in payload) | 55,503 | 1,914 | 0.59 | 3.49 M rows, 1.08 GB |
| region.pass (8 regions, one row per object per day) | 898,158 | 30,971 | 18.0 | 56.6 M rows, 32.8 GB |
| **all kinds** | 968,413 | 33.4 k | 18.7 | 34.3 GB |

Everything except region.pass is **1.5 GB per 5 years**. region.pass is 97% of the storage. If it were stored one
row per pass (the "natural" form) it would be 881,199 rows and 154 MB per day (281 GB per 5 years), measured on
2026-09-30; packing one row per object per day (all that object's passes of that day in one text field) is 8.6x smaller.
The Mac measured about 17 MB/day packed; same ballpark. About 67.6% of the passes belong to objects that are neither
debris nor rocket bodies (the history files do not separate payloads from "unknown"), so a payload-only table would be
about 22 GB per 5 years (extrapolated from that share, not stored). The information content is much smaller than the
rows (881 k passes x two times of day), so a binary format would shrink it again; not tried.

**Row counts by day** (rows/day: appeared / disappeared / jumps / region / approach / formation): 2026-09-21
49/10/586/30,900/1,108/297; 2026-09-30 36/21/44/30,923/1,222/227; 2026-10-18 21/12/484/31,093/1,070/144. Daily
region rows are steady (30,894 to 31,108); jumps swing 33 to 757 with how many element sets were refreshed that day
(about 15,900 sets change per day, between 3,400 and 28,200).

### Element jumps (maneuver candidates)

For every object whose element set changed since the previous day, I propagate the old set to the new set's epoch and
measure how far the old prediction is from the new set (`dpos`, km), and the change in orbit size (semi-major axis,
`Δa`, km, from the mean motion). 444,635 changed sets in 28 days:

| regime | n | dpos p50 / p90 / p99 / p99.9 (km) | abs(Δa) p50 / p90 / p99 (km) | share with dpos > 16.3 km | share with abs(Δa) > 1 km |
|---|---|---|---|---|---|
| LEO | 396,142 | 1.63 / 55.8 / 766 / 8,313 | 0.018 / 0.152 / 7.7 | 24.5% | 3.05% |
| MEO | 6,851 | 0.36 / 2.3 / 48 / 294 | 0.003 / 0.094 / 0.79 | 2.4% | 0.79% |
| GEO | 21,580 | 1.02 / 10.9 / 57 / 1,046 | 0.159 / 0.449 / 2.26 | 6.7% | 3.90% |
| HEO | 19,190 | 1.53 / 13.6 / 220 / 3,505 | 0.116 / 1.59 / 26.9 | 8.7% | 14.1% |
| other | 872 | 0.70 / 2.8 / 227 / 452 | 0.118 / 0.284 / 13.9 | 4.8% | 3.2% |

The gap between the two element sets is a median of 2 days (p90 2.8 d), and the error grows with the gap, so a
position difference alone mostly measures drag and age, not manoeuvres: a quarter of all LEO updates differ by more
than 16 km without anything having been done.

**Chosen rule** (stored as `elements.jump`): `dpos > 16.3 km` AND `abs(Δa) > 1 km` AND `abs(Δa - drag) > 1 km`.
Justification: 16.3 km is ten times the LEO median error (the Mac's number); 1 km in Δa is 6.6 times the LEO p90
(0.15 km) and above the MEO/GEO p90; and the third test removes the shrinking that drag alone predicts (the old
set's own drag term `MEAN_MOTION_DOT` times the gap). That third test removed 26% of what the Mac rule stored (3,319
of 12,556 jumps in 28 days were "lowering, explained by drag"). A raise can never be drag. Result: 8,968 jumps in 28
days (309/day): LEO 7,960 (Starlink 5,997 of them: 4,144 lowering, 1,853 raising), GEO 523, HEO 449, MEO 10, other 26.
Last 7 days, Starlink: 1,393 jumps on 754 satellites (1,133 lowering, 260 raising) of 2,127 jumps overall.
Caution: this is a manoeuvre **candidate**. A lowering of several km in two days is also what an atmosphere-heavy
Starlink at about 465 km does, and Starlink was in a shell-lowering campaign; I have no manoeuvre log to
separate them, so the label stays "candidate". Objects with absurd orbits (a lunar-distance spacecraft, DRO-A, with
Δa = 154,000 km) are SGP4-invalid; they appear in the unfiltered list but SGP4 cannot be trusted there.

Top examples stored (by abs Δa, excluding HEO): CZ-3B rocket body 2026-09-25 Δa = -1,341 km (re-entering, garbage);
GEO satellites changing slot: LDPE-2 +245 km (2026-10-13) and +239 km (10-09); EOS-5 +222 km; TJS-17 +202 km;
TIANLIAN-2 06 +199 km on 10-10 and -199 km on 10-15 (out and back); TJS-19 -197 km. The **ISS reboost is caught**:
2026-09-27, Δa = +1.826 km, dpos 427 km, raise.

### Close approaches, categorised

What the grid finds (all pairs of different, non-identical objects within 5 km at their closest, found with a spatial
grid of the whole catalog every 5 s, then refined exactly): **73,873 per day on average** (68,702 to 95,840; two
days above 95 k). That is geometry, not duplicates: a back-of-envelope uniform-density estimate (28,500 LEO objects in a
shell of 5.4 x 10^11 km^3, average speed difference 10 km/s) gives about 51,000 per day, so tens of thousands of
random crossings a day under 5 km is what a crowded low orbit produces. The fraction below 1 km (1,942) is smaller
than the area rule would give (2,955), consistent with constellation operators keeping their planes apart. Breakdown,
mean per day over 29 days, events with a miss distance below the column value:

| category (first match wins) | < 5 km | < 2 km | < 1 km | < 0.5 km | < 0.25 km |
|---|---|---|---|---|---|
| near-identical elements (a within 1 km, inclination and node within 0.01 deg) | 0 | 0 | 0 | 0 | 0 |
| co-moving (relative speed below 0.5 km/s) | 495 | 82 | 28 | 8 | 2 |
| same launch (same launch id, e.g. a deployment batch or one breakup) | 678 | 107 | 26 | 6 | 1 |
| same name prefix, different launch (98% Starlink x Starlink on the day I checked) | 43,804 | 2,380 | 762 | 217 | 55 |
| **crossing: unrelated objects that actually cross** | **28,895** | 4,572 | **1,126** | 279 | 68 |
| all | 73,873 | 7,141 | 1,942 | 511 | 127 |

Other facts (all < 5 km events): 83% last under 1 s inside the 5 km sphere (a fast crossing; 15% 1 to 5 s, 1.5% 5 to
30 s, 0.3% 30 s or more). For crossings under 1 km on 2026-09-30, 64% had a relative speed of 12 km/s or more (nearly
head-on), only 2% below 2 km/s; 47% of them involve a Starlink. Near-identical-element pairs are zero in the approach
list because those pairs stay together all day, so they are in `close.formation` instead (73 per day, plus 32 same-launch,
31 same-name, 28 other; 164 per day in total). The 19 objects with literally identical element sets (ISS stack, etc.)
are excluded before the grid.

**Before and after (lead's revised definition).** Before: 73,873 rows/day (the Mac saw 70 to 77 k). **After: 1,914 rows/day**
(1,246 to 5,155 on a single day), a 39-fold cut; 55,503 rows in 29 days. The stored kind `close.approach` is now:
miss distance **under 1 km** AND relative speed **0.5 km/s or more**, excluding only identical element sets and pairs
already recorded as `close.formation` (the slow, co-moving ones). The category is a **payload label** (`cat`), not a filter.
Stored rows by label, per day: `crossing` 1,126 (unrelated objects), `same_family` 762 (98% Starlink x Starlink), `same_launch` 26,
no near-identical pairs (those sit in formation). The old 1,126/day is the "crossing-only subset" (`WHERE payload->>'cat'='crossing'`).
Why labels and not filters: a pair of the same constellation or the same launch that passes at 0.5 km/s or more is flying
in different planes or shells and really crosses; it is the traffic operators screen for. Dropping them (my first version) hid
more than half of the real sub-km encounters (on 2026-09-30: 1,220 crossings, 1,478 same-family, 29 same-launch). Only what stays
together (slow, in formation) is separated out; a reader who wants only unrelated pairs filters on the label.
Why 1 km: public element sets are good to about 1 km at their epoch and drift about 1 km a day, so a miss distance
under 1 km is already "indistinguishable from a hit" and a tighter number would claim accuracy the data do not have;
there is no covariance, so I cannot rank by collision probability and rank by miss distance. The full set under
5 km is **compute on demand only**: the grid costs about 150 s of the 4 cores per day; the one day I kept for
evidence (2026-09-30, 78,324 events) is a 1.1 MB file. The name-prefix test is crude (it also lumps unrelated COSMOS x
COSMOS pairs, about 1% of the same-family bucket), which now only affects a label.

### Disappeared objects: decay or just stale?

Each day's history file lists every object's latest element set from the **previous 30 days**. So an object also
"disappears" from the file when its last set simply reaches 30 days of age, whether or not it decayed. Classes
(390 disappearances in 28 days): `decay_likely` 98 (last perigee below 250 km or SGP4 height below 140 km at the
vanishing time), `ambiguous_low` 6 (perigee 250 to 350 km), `stale_window` 286 (nothing wrong with the orbit, last set
about 29.5 days old). The Mac's old rule put every case into "stale" because it tested age first; checking the
decay signature first is the fix. Checks against what happened afterwards (Q-E4): of the 286 stale, **195 are still in the
live catalog of 2026-10-22 and 189 reappeared inside the window**, so they were certainly not decays; of the 98
decay_likely, **1** is in the live catalog (97 are gone). The ambiguity: **91 of the 286 "stale" objects are not in
the live catalog and have no decay signature** (48 LEO with perigee 365 to 1,483 km, 35 HEO, 6 MEO, 2 GEO). They may have
decayed, or been dropped from the catalog; elements alone cannot tell, so these stay "stale/unknown", never "decayed". The only
independent status source in the repo (GCAT, 2026-07-03) is older than these days and cannot serve as truth.
Appearances (641 in 28 days): 323 returned after an earlier absence, 217 new launches (launched within 31 days), 101 newly
cataloged older objects.

### The four questions (median of 5 runs each, warm cache, local database)

| Question | Answer | Median |
|---|---|---|
| Q-E1: all ISS passes over India, 29 days | 91 passes (5 runs: 2.6 / 0.8 / 0.9 / 1.0 / 0.7 ms) | **0.9 ms** (brute-force SGP4 at 5 s: 4.5 s) |
| Q-E2: all close approaches involving one busy object (PELICAN-6 300D, the object in most) | 185 events; closest 0.068 km on 2026-10-07 (re-run after the redefinition: 6.3 / 3.2 / 2.9 / 2.3 / 2.3 ms; first run 1.9 ms median) | **2.9 ms** (last 7 days only: 34 events, 1.1 ms) |
| Q-E3: Starlink manoeuvre candidates, last 7 days | 1,393 events on 754 satellites (1,133 lowering, 260 raising) | **5.1 ms** |
| Q-E4: who disappeared in 29 days and was it a decay | 390 events, by class with live-catalog and reappearance check (above) | **6.2 ms** |

### Verification (all against code that does not share the fast path)

1. **Q-E1 ISS vs brute force.** Own SGP4 loop at 5 s over all 29 days with each day's own element set, geodetic
   latitude by satellite.js, T1's polygon. **90 brute-force passes; all 90 are in the stored rows (100% recall)**,
   start times within 4 s and end times within 5 s (the brute force only knows 5 s). The stored data have 91: the extra
   one is a 2-second corner clip (2026-09-25 07:23:48) shorter than the brute-force step, found by the 1 s walk.
2. **Region passes, random sample of other objects, all eight regions.** 6 random days, about 480 objects per day
   (60% LEO, 10% each of the other regimes, 2,888 object-days), brute force every 2 s: **58,137 brute-force passes, 58,137
   inside a stored pass: recall 100.000%**, per region EU 11,296, CN 11,331, US 10,127, BR 7,533, JP 3,604, AU 7,336, BLR
   1,628, IN 5,282 (each 100%). 48 stored passes have no brute-force pass nearby: all shorter than the 2 s brute step.
   A first 3-day run showed 28,819 of 28,820; the one apparent miss was a 276 s pass that the stored data split at a 1 s
   notch where the track crosses a vertex of the India polygon (confirmed second by second), so nothing was missing;
   the checker now treats passes separated by 2 s or less as one. The max start/end differences on the clean
   passes are 1 s and 2 s; a few long "passes" of slow MEO/GEO objects that crawl along a polygon edge differ by hundreds
   of seconds (6-day run: 637 s); I did not look into them, the likely cause is an object hugging a polygon edge so that the stored pass is chopped
   into many short pieces which the checker merges, but all 58,137 passes were still covered.
3. **Cross-check with T1.** Object-days with an India pass: this job 857,054 vs T1's brute-force truth 857,003
   (per day -5 to +8; the +51 are visits shorter than T1's 10 s step, plus T1's three garbage cases and the fence).
4. **Recall bugs found and fixed on the way (real).** Making region passes faster than "walk 1 s wherever near"
   (201 s/day) with the straight-line test (now 66 s) first missed 4 short passes (2 to 6 s long) that the slow reference found: a GPS satellite creeping
   along a polygon edge (I had computed latitude as for ground level, off by up to 0.6 degrees at 20,000 km), two on a decaying
   object whose garbage SGP4 track moves 110 km/s so 20 s is 2,200 km, and a 4 s US pass on another object that the same two
   fixes also recovered. Fixes: exact latitude for high objects, and any step over 400 km is always walked. After the fix the 2026-09-30 table equals the slow
   reference on all 30,923 rows (two garbage-orbit rows differ by 1 s in an edge time).
5. **Close approaches recomputed exactly.** Five random stored approaches, scanned by brute force every 10 ms over plus
   or minus 20 s (no optimiser) from the raw element sets: miss distance, time and relative speed identical to the
   stored values (|difference| 0.000 km, 0.00 s) for all five, e.g. 327 / 64972 on 2026-10-14: 0.684 km at 21:19:10.314 UTC, 13.47
   km/s. A second set of five with a different method gave the same. **After the redefinition** the exact recompute was repeated on the new rows: 3 `same_family` (0.537, 0.364, 0.575 km) and 2 `crossing` (0.781, 0.712 km) stored approaches match the 10 ms brute-force scan exactly (0.000 km, 0.00 s, same relative speed); the golden-section spot-check of 5 more also matches. `check.sh` passes. **Recall of the grid** (this had not been checked
   here): the ISS, the 30 objects with the most approaches and 12 random ones, against every other object for 3 hours
   of 2026-09-30 at 2 s plus exact refinement: 237 brute-force approaches under 5 km, **237 in the derived full set (100%)**. Pairs
   in `close.formation` are excluded from both sides. Not checked: a whole-day all-vs-all brute force (it would be
   32,000 x 32,000 pairs).
6. **Formation.** Five random stored formation pairs recomputed at 60 s: the fraction of the day within 50 km and the
   minimum distance match exactly (e.g. TerraSAR-X / TanDEM-X 1.000, 0.239 km; Dragon Freedom 3 / Dragon Grace 2 0.881, 37.9 km).
7. **Appeared/disappeared** equal the plain set difference of the two raw history files on 3 days (8/11, 76/10, 33/31).
8. **Five jumps by hand** (period from mean motion, a = (mu x (T / 2 pi)^2)^(1/3), mu = 398,600.4418 km^3/s^2): STARLINK-4196
   (2026-10-18): n = 15.33550274 rev/day gives T = 5,633.985 s, a = 6,843.367 km; new n = 15.34316581 gives a = 6,841.088 km;
   Δa = -2.279 km, stored -2.279. STARLINK-4746: -6.407 km (stored -6.407), dpos 708.7 km. STARLINK-36255: -10.199, dpos 1,120 km.
   COSMOS 2539 (GEO): -2.769 km, dpos 42.9 km. FLOCK 4BE 15: -10.489 km, dpos 195.3 km. In all five the stored Δa and dpos equal
   the recomputation (old set propagated to the new epoch with SGP4, compared with the new set). All five happen to be lowerings,
   which is the caution above: this proves the arithmetic, not that each was a manoeuvre.

### Verdict per kind

| kind | verdict | why |
|---|---|---|
| object.appeared / disappeared | **keep forever** | 35 rows a day, 0.05 GB per 5 years, exact set difference. Say "left the catalog", not "decayed", unless the class is `decay_likely` (97 of 98 verified by absence) and an outside source confirms it. |
| elements.jump | **keep forever** (as "manoeuvre candidates") | 309/day, 0.24 GB per 5 years; catches the ISS reboost and GEO slot changes; about two thirds are Starlink and cannot be told apart from drag-driven lowering with public elements alone. |
| close.formation | **keep forever** | 164/day, 0.09 GB per 5 years, verified; it also explains the pairs removed from the approach list. |
| close.approach, under 1 km and 0.5 km/s or faster, labelled crossing / same_family / same_launch | **keep forever** | 1,914/day (crossing-only subset 1,126/day), 1.08 GB per 5 years, verified exactly (miss, time, speed) and 100% recall in the grid test; queryable in 2 to 3 ms. |
| close.approach, the full set under 5 km | **compute on demand** | 73,873/day, mostly random crossings and Starlink-on-Starlink; about 155 s of 4 cores per day; do not store. |
| region.pass (8 regions) | **compute on demand** (or keep only a rolling window, such as the last 30 days, or only watched regions) | 32.8 GB per 5 years packed, 97% of everything, 66 s of 4 cores per day to rebuild; T1's star-map summaries already answer the long-window "who passed over X" question. Even India alone, packed (857,054 rows, 179 MB for 29 days, measured, = 6.2 MB/day or about 11 GB per 5 years), is 11 times the rest of the table combined. |

**Caveats and what was not done.** Everything is one machine, one run per kind; the 5-year figures are straight-line
multiples of 29 days (the real history before June 2026 is too sparse for a true 5-year backfill). The seven non-India
regions are rough polygons from the Mac, and only India shares T1's polygon. The grid was verified for 3 hours and 43
objects, not for a whole day all-vs-all. The decay/stale split has no outside truth. Region and approach rows
skip about 90 objects a day with garbage SGP4 output (mostly decaying objects), so their re-entry passes are not
listed. Peak memory was polled, not traced. The payload-only region size is extrapolated from a pass share.

**Region-pass checker cases that differ by up to 637 s: explained, not a defect.** I re-ran the 6-day check printing every
case with a start/end difference over 60 s. All 30 listed cases (cap of the listing; the 637 s maximum is among that pattern) have the same shape: the brute force sees
**two** passes separated by a gap of about 4 s (e.g. Starlink-2479 over China, 58546..58900 s and 58904..59070 s), the stored
data have two pieces separated by 1 to 2 s inside one merged span (58546..59072 s). So a track briefly (about 1 s) leaves the
polygon at a vertex notch; the 2 s brute force sees it as a longer gap, and my checker, which merges stored pieces separated by 2 s or
less, then compares each brute pass against the whole merged span, which makes the start or end look hundreds of seconds off. Every
brute-force pass is still inside a stored piece; 58,137 of 58,137 covered (output: `verify-regions6b.txt`).

**Re-derive after the definition change.** Only the close-approach part was re-derived for all 29 days (`--only ca`, resumable
via a `caDef` marker in the day statistics): about 150 s per day on 4 cores (the run was interrupted by a container restart and resumed); other kinds unchanged.

Reproduce (from the repo root; `export STARMAP_DB=postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch`):
```
npx tsx packages/backend/scripts/starmap/derive-day.ts --from 2026-09-20 --to 2026-10-18        # ~108 min, resumable
npx tsx packages/backend/scripts/starmap/derive-day.ts --from 2026-09-30 --only ca --ca-full --force   # keep the <5 km set of a day
npx tsx packages/backend/scripts/starmap/events-report.ts days | ca | diff | storage              # tables above
npx tsx packages/backend/scripts/starmap/events-queries.ts q                                     # Q-E1..Q-E4, median of 5
npx tsx packages/backend/scripts/starmap/events-queries.ts verify                               # ISS vs brute force; 5 approaches
npx tsx packages/backend/scripts/starmap/verify-events.ts regions --objects 500 --days 6 --step 2   # ~13 min
npx tsx packages/backend/scripts/starmap/verify-events.ts ca-recall 2026-09-30 0 3               # ~4 min
npx tsx packages/backend/scripts/starmap/verify-events.ts ca-exact | formation | diff | jumps
npx tsx packages/backend/scripts/starmap/jump-dist.ts ; npx tsx packages/backend/scripts/starmap/jump-study.ts
bash packages/backend/scripts/starmap/check.sh
```
Raw outputs: `packages/backend/data/events/` (`derive-all.log`, `events-stats.jsonl`, `report-*.txt`, `q-run1.txt`,
`verify-*.txt`, `jump-study.txt`, `ca-full-2026-09-30.jsonl.gz`).

**Lead's independent check** (separate code, own SGP4 loop at 10 ms): a random stored same_family row,
STARLINK-5503 x STARLINK-36744 on 2026-10-12, recomputes to 0.610 km at the stored instant (0.00 s) at 2.64 km/s,
identical to the stored payload. The lead also confirmed from the 2026-09-30 evidence file that under 1 km and
>= 0.5 km/s there were 1,220 crossing, 1,478 same_family and 29 same_launch encounters, which is why the
categories are labels and not filters.

## Round 4 — T3 (cloud): the planner

Machine: the same cloud container (4 cores, 15 GB, Node 22). Jobs ran one at a time (routed Q4/Q5, then brute-force Q4/Q5, and so on), so no
two heavy jobs overlapped; only short DB lookups and the check script ran beside nothing else. "Now" for Q1/Q2 is fixed at
**2026-10-23T06:30:00Z**, with the live catalog `tle-cache.json` (32,778 objects). Q3 uses the most recent derived day, 2026-10-18. Q4/Q5 use
2026-09-20..10-18 with each day's own element sets. Q6 uses 2026-10-01..10-18.

### What was built (all in `packages/backend/scripts/starmap/`)

- `ask.ts` is the router and the six fixed questions; it prints the plan, then runs the routed path and the brute-force path and writes `data/ask/q<N>.json`.
- `ask-plan.ts` is the decision table: window (instant / hours / days / months) times kind (region-in-time, one-vs-all, all-vs-all, box, repeated fact) goes to a layer.
  It looks at what exists (derived days in `starmap.event`, hourly and daily coverage files) and falls back (underived day goes to the live grid, no hourly summaries go to daily, none go to brute force).
  `ask.test.ts` tests the table.
- `ask-worker.ts` / `ask-worker-boot.mjs` hold the ISS coarse filter and brute force, and a brute-force pass scan that returns pass start/end times.
- Reused as they were: T1's `coverage-cover.ts` (India rotated into the star map), `coverage-codec.ts`, the refine in `coverage-worker.ts`, `coverage-lib.ts`
  (`INDIA_POLY`, `inPoly`, `subPoint`, `FENCED`); T2's `derive-day.ts` (as the Layer 4 grid) and `starmap.event`; `runs.ts`.
  Two small refactors with no behaviour change: the merge/window helpers moved out of `coverage-query.ts` into `coverage-qlib.ts`, and `Pool` in
  `coverage-lib.ts` takes an optional worker boot file. The Q2 coarse filter repeats the logic of `screen-worker.ts` `issCoarse`
  (rather than importing it, because `screen-lib.ts` needs calibration files in `/tmp/starmap` that this machine does not have).

### Table

Times are wall clock. "Brute" is the brute-force run done here for that question (how, below). Speed-up is brute divided by routed.

| Q | route chosen and why | routed | brute force | speed-up | answer | agreement with brute force |
|---|---|---|---|---|---|---|
| 1 Over India now | **L4**: SGP4 for all objects at the instant, then point-in-polygon. One instant, nothing stored can be cheaper. | 0.065 s (median of 5) | 0.478 s (median of 5) | 7.4x (see note) | 188 objects (168 LEO, 9 MEO, 11 HEO) | recall 100% (188/188), 0 extras |
| 2 Within 100 km of the ISS, last hour | **L4**: coarse time filter (SGP4 every 30 s, 20 km/s pad), 1 s refine near hits. | 0.638 s (median of 3 warm runs; the first run, with worker start, was 1.18 s) | 13.2 s (1 s step, 118 M SGP4 calls) | 20.7x | 90 objects; 5 of them sit at 0 km (identical element sets of the ISS stack) | recall 100% (90/90), 0 extras, closest distance and time identical |
| 3 Close approaches under 5 km, last 24 h (2026-10-18) | **L3**: the day is derived, so a lookup in `starmap.event`. It answers only the stored subset (miss under 1 km, relative speed at least 0.5 km/s). | 0.006 s (median of 5) | 151.8 s (the whole-day L4 grid: 5 s grid over all pairs + exact refine) | about 25,000x | 1,482 stored rows. The full under-5-km set from the grid is 72,276 (under 2 km 6,547; under 1 km 1,494; under 0.5 km 357); 144 formation pairs excluded | recall 100% of the stored definition (1,481 grid events vs 1,482 rows); 1 extra row, a pair at a rounded 1.000 km that the stored file rounds below 1 km; the re-derived rows equal the database rows exactly (0 and 0 differences). The 1-5 km remainder (70,794 events) has NO stored answer |
| 4 Over India, 29 days, with times | **L2**: hourly order-4 summaries, India rotated into the star map per hour, refine on candidate windows. Hourly was cheaper than daily in T1 (34 vs 78 s/day). | 1,123.8 s (38.8 s/day) | 1,382.4 s (47.7 s/day; the sweep also answers Q5). India alone, measured on 1 day: 32.4 s | **1.23x** vs the shared sweep; **0.8x (slower)** vs an India-only sweep (32.4 s/day, times 29 = about 940 s, extrapolated) | 857,161 object-days, 2,327,933 passes | object-days 857,001 of 857,003 (99.9998%); passes within 20 s at both ends 2,284,322 of 2,284,701 (99.983%); the 2 + 379 misses are decaying-debris artefacts (below); extras: 160 object-days and 37,757 passes, all shorter than the 10 s brute-force step |
| 5 Through box 9138, 29 days | **L2**: hourly order-3 summaries; the box is itself a summary cell, so the lists give the candidates. | 293.6 s (10.1 s/day) | 1,382.4 s shared sweep (box alone, 1 day: 46.2 s) | **4.7x** vs the shared sweep; 4.6x vs a box-only sweep (extrapolated) | 156,759 object-days, 2,298,058 passes | object-days 156,520 of 156,521; passes 2,290,445 of 2,290,446; the 1 miss is a decaying-debris artefact; extras: 232 object-days, 7,612 passes, all shorter than 10 s |
| 6 ISS passes over India, 1-18 Oct | **L3** lookup (rows of kind `region.pass`, region IN), cross-checked with L2 (hourly summaries + refine, ISS only) | 0.003 s (median of 5); L2 cross-check 17.8 s (88.9 s the first time, cold file cache) | 0.757 s (5 s step, independent geodetic code) | 250x for the lookup | 55 passes | 55 of 55 within 20 s of the lookup and of L2 (max start/end differences 4 s / 5 s, brute step 5 s); lookup vs L2: all 55, within 0-1 s; 0 extras |

Note on Q1: both paths are one SGP4 evaluation per object. The 7x is mostly that the routed path keeps the parsed element sets in memory
while the brute-force loop builds each satellite record again and uses a separate geodetic conversion. In a real server the
live path would be about 65 ms; the brute-force result matters here as an independent check, not as a speed contest.

### How brute force was run for each question

- **Q1:** separate code. `satellite.propagate` on a Date, `satellite.eciToGeodetic`, the polygon test from `events.ts` (same India polygon), no radius filter. 5 runs.
- **Q2:** SGP4 for every one of the 32,777 other objects at every second of the hour (3,601 steps), minimum distance to the ISS track, 4 workers. One run.
- **Q3:** `derive-day.ts --only ca --dry --ca-full` for 2026-10-18, the T2 grid (every pair, every 5 s, exact refine), 4 workers, no database write. Its full under-5-km output is the truth; I filtered it to the stored definition for the agreement. The grid itself was checked in T2 (237 of 237 at 3 hours, 43 objects); a different, whole-day all-vs-all brute force was **not** run (about 32,000 x 32,000 pairs).
- **Q4 and Q5:** **live brute force on all 29 days, not reused**: every object, 10 s step, 8,640 steps, 4 workers, one sweep per day that answers both questions and returns pass start and end times (47.7 s/day, 1,382 s total). As a check on the earlier work, the per-object pass counts of all 29 live sweeps equal T1's cached truth in `data/coverage/q/` for every object (0 different of about 65,700 per day). The cached truth was NOT used as the answer. Matching rule: a brute-force pass is found if a routed pass starts and ends within 20 s of it (routed pieces separated by 10 s or less count as one, because the 10 s step cannot see a shorter gap).
- **Q6:** each day's own ISS element set, 5 s step, satellite.js geodetic conversion, `events.ts` polygon test.

### The misses are the known artefacts, named

Every miss in Q4 and Q5 is a **single brute-force sample (a pass of 0 s)** from a decaying object whose SGP4 output is unreliable. For India: NORAD
54947 (146), 69730 (137), 54352 (74), 54334 (16), 35248 (2), 61486 (2), 34861 (1), 60778 (1); in total 379 passes. Of these, 34861 (2026-10-04) and 35248 (2026-10-18) are also the two missing object-days. For the box, one: 61486 on 2026-10-18.
34861, 35248 and 61486 are the T1 artefacts; the others are CZ-6A / CZ-4C debris at 240-330 km perigee (checked for 54352, 54334, 60778, 35248, 61486) or objects that are not in the 10-18 file (54947, 69730; 69730 was the row-cap object in T1). I did not inspect each of the 379 one by one. They are real SGP4 outputs at one instant, so I count them as artefacts of the model, not as passes, but they are listed here and not dropped from the numbers.

### Not done, skipped, extrapolated

- Q4/Q5 speed-ups against a single-question sweep are extrapolated from one measured day (2026-10-18) times 29; the shared-sweep comparison is fully measured.
- The routed Q4/Q5 time includes loading the day's element sets and reading the coverage files, and the same load is counted in the brute force.
- Q6 excludes the load of the ISS element sets (2-3 s for 18 days), because production would index them.
- Q2 has one brute-force run; Q3 has one; Q4/Q5 were run once per day.
- The first Q6 L2 run (88.9 s) was on a cold file cache; the 17.8 s is the warm run. Q3's 1-5 km events were not compared against the database (it does not store them).

### Verdict in plain words

The planner works, and for these six questions every cheaper path found everything the slow path found, except for single-instant glitches of
a few decaying pieces of debris, which are named above. The speed-ups tell a clear story. A question about **one instant or one object over an hour**
(Q1, Q2) is already cheap enough live, with nothing stored: 0.07 s and 0.6 s. Questions the **daily job has answered in advance** (Q3, Q6) become
lookups of a few milliseconds, thousands of times faster than recomputing them (152 s and 0.8 s). But the lookup for Q3 only holds the close
approaches under 1 km at a real relative speed; the other 70,000 "under 5 km" events of the day exist only if you pay for the 2.5-minute grid.
The **long-window box question** (Q5) is where the stored star-map summaries pay off: 4.7x faster than looking at everything, with every object found.
The **long-window "over India" question** (Q4) is the honest disappointment: about nine in ten objects pass over India on any day, so the
summaries cannot throw much away. The routed path took 39 s a day against 32-48 s for brute force, and it is only worth using because it gives
passes to the second (the 10 s sweep gives only 10 s), not because it is faster. So the planner should send ground questions that cover most of the catalog straight to the brute-force sweep
unless the second-level times are needed. State machine: the router has no state; its only inputs are the question, the days derived in the event table, and the coverage files present. Shared load: all timings are on 4 cores
with nothing else running; two users asking Q4 together would double those times.

Reproduce (repo root; `export STARMAP_DB=postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch`):
```
npx tsx packages/backend/scripts/starmap/ask.ts --q 1          # likewise --q 2, --q 3 (152 s; add --reuse to re-compare), --q 6
npx tsx packages/backend/scripts/starmap/ask.ts --q 4,5 --stage routed    # about 19 min
npx tsx packages/backend/scripts/starmap/ask.ts --q 4,5 --stage brute     # about 23 min
npx tsx packages/backend/scripts/starmap/ask.ts --q 4,5 --stage brute --which india --days 2026-10-18   # and --which box
npx tsx packages/backend/scripts/starmap/ask.ts --q 4,5 --stage compare ; npx tsx packages/backend/scripts/starmap/ask.ts --stage report
bash packages/backend/scripts/starmap/check.sh
```
Raw results: `packages/backend/data/ask/` (`q1.json` .. `q6.json`, per-day routed/brute files and logs).

## Decision — storage and indexing for the Perceptor

**In plain words.** Keep the raw orbit numbers (element sets) forever; everything else can be rebuilt from them.
On top of them keep two small things forever: daily star-map lists ("which objects passed through which box of
space that day") and a short list of daily facts (new and vanished objects, orbit jumps, formation pairs, close
approaches under 1 km). Answer everything else on demand by re-running SGP4 only on the objects the lists point to.
"Now" questions run in memory and store nothing. Satellites are indexed only in the star map; ground questions
turn the ground region into star-map boxes for each hour or day. One nightly job of about 6 minutes per day (4
cores) keeps it all current. Five years cost about 25–60 GB depending on whether the element sets are
compressed. That is more than production's 5 GB disk, so production needs a bigger volume (and TimescaleDB if the
element sets are to be compressed).

### Layers to build (exact settings)

| layer | what | kept | per day | per 5 years | measured in |
|---|---|---|---|---|---|
| 1 truth | one element set per object per UTC day (`omm_daily`), time-leading index | forever | 13.7 MB as JSON, 20.7 MB in plain Postgres (round 3); 2.1 MB gzip | 38 GB plain; ~4–6 GB compressed (estimate from gzip, TimescaleDB ratio not measured) | R3, this section |
| 2 coverage | star-map (TEME) lists, daily, orders 3 and 4; 10 s sample + 1 s bisection; row-capped objects always candidates | forever | 8.9 MB (2.6 + 6.3) | 16.2 GB | T1 |
| 2 coverage, recent | the same, hourly, order 4 | rolling 90 days | 70.8 MB | 6.4 GB in total | T1 |
| 3 events | object.appeared / disappeared, elements.jump, close.formation, close.approach (< 1 km, ≥ 0.5 km/s, category as label) | forever | 0.8 MB, ~2.4k rows | 1.5 GB | T2 |
| 3 events, recent | region.pass for watched regions | rolling 30 days | 18 MB (8 regions) | ~0.5 GB in total | T2 |
| 4 live | SGP4 in memory: coarse time filter (one-vs-all), per-step grid (all-vs-all), point-in-polygon (region now) | nothing stored | — | — | R2, T2 |

Total: about 63 GB per 5 years with plain Postgres element sets, about 29 GB if the element sets are compressed.

Not stored, computed on demand: the full close-approach set under 5 km (~74k/day, ~150 s of 4 cores per day);
region passes outside the rolling window (T1's lists + refine answer "who passed over X in N days").

Router check (T3): all six fixed questions route to these layers and agree with brute force (the only misses are
single-sample SGP4 hits from decaying debris, named in T3). Lookups take 3–6 ms; long India questions are no faster
than a plain sweep (91% of object-days are real passes) but give pass times to 1 s; box questions are ~4.7x faster.

Guarantee to state with every answer: the lists miss nothing at 10-second resolution (100% recall on 29 days, T1);
visits shorter than 10 s may only be found by the exact refine. Exact pass times come from the refine, to 1 s.

### The daily job

Per UTC day, after the day's element sets land:
1. Layer 2 build: one SGP4 pass over all objects at 10 s with 1 s bisection, orders 3 and 4 daily plus order 4
   hourly. **150 s on 4 cores, peak 4.8 GB RAM** (T1, mean of 29 days).
2. Layer 3 derive: set differences, jumps, formation pairs, close approaches (per-step grid), region passes for
   the rolling window. **About 220 s on 4 cores, peak about 1.2 GB** (T2, mean of 29 days).
3. Drop hourly lists older than 90 days and region passes older than 30 days.

Total about **6.2 minutes per day on 4 cores**, peak about 5 GB RAM. A 5-year backfill at that rate is about 190 h
on 4 cores; on 8 and 32 vCPU roughly 95 h and 25 h if it scales linearly. Scaling was NOT measured (T5 not run).

### Dropped, and why

| idea | why dropped | measured in |
|---|---|---|
| stored box index (every visit with entry/exit times) | ~1.4 GB/day even compressed; the daily lists + refine give the same recall at 9 MB/day | R1, T1 |
| stored Chebyshev day lines | 67–85 MB/day; only ~2.5× faster for long all-object scans, slower for single instants; parallel SGP4 gives the same gain | R3 |
| ML surrogate for SGP4 | slower and less accurate than SGP4 | R3 |
| database indexes on orbit shape (perigee/apogee, MOID) | at catalog size a scan takes ~2 ms; in LEO the filters barely prune; time must lead any history index | R2 |
| "same box = near" proximity | caught only 12.5% of objects within 500 km; always cover the search ball | R1 |
| satellites in Earth-fixed cells | against the design rule; daily Earth cells pruned nothing (99.8% of candidates real) | Mac R4 |
| order-2 lists, 10-minute lists | order 2: 57% precision on the box; 10-minute: 183 GB per 5 years for 1.5× more speed | T1 |
| storing every close approach under 5 km | ~74k/day of real but routine crossings; stored subset under 1 km is 1.9k/day | T2 |
| storing region passes forever | 33 GB per 5 years (97% of the event table) for an answer the lists rebuild | T2 |

### What production needs

- **Disk:** a volume of at least ~70 GB for 5 years (or ~35 GB with compressed element sets). The current 5 GB fits
  about 6 months of everything above. The layer-2 lists are binary blobs (one per day, granularity and order); they
  can live in a `bytea` table or as files on the volume.
- **Database:** Postgres is enough for layers 2 and 3. TimescaleDB is worth adding only to compress `omm_daily`
  (about 7× by the gzip figure; not measured in TimescaleDB). PostGIS is not needed by anything measured: all
  polygon work runs in code.
- **Compute:** a worker with 4 vCPU and 6–8 GB RAM for the nightly job (about 6 minutes per day). The API itself
  needs no extra cores: lookups take 1–10 ms and the refine runs per question.
- **Backfill:** 5 years of history needs Space-Track history access, which the owner must arrange. Then about 190 h
  on 4 cores, or a day or two on a 32-vCPU machine. Not attempted.

### Open problems

- Scaling with more cores (T5) was not measured; the backfill estimates assume linear scaling.
- Element-set compression in TimescaleDB was not measured; the 4–6 GB figure is from gzip.
- 5-year figures are straight-line multiples of 29 measured days.
- History before 2026-06-23 is sparse, and the live app reports coverage up to 2026-10-25 (future-dated element
  sets?); not investigated.
- Decay vs "aged out of the 30-day window" is unconfirmed without an outside decay source; say "left the catalog".
- Starlink orbit lowering cannot be told apart from drag-driven lowering with public element sets alone, so jumps
  stay "manoeuvre candidates".
- SGP4 returns garbage for some re-entering objects (about 90 per day fenced); 3 such object-days appeared as false
  "passes" in the brute-force truth. Any production answer should fence them the same way.
- Only India's polygon is careful; the other region polygons are rough.
- No whole-day all-vs-all brute force was run for close approaches (recall was checked on 3 hours × 43 objects).
- TEME vs J2000 (~0.3°) is tagged, not converted.

## Decision update (owner, 2026-10-24): three operational layers

Owner rulings: storage is not a constraint (~500 GB available); compute is not a constraint; the 14-day
recent-window research and the error-growth experiments are dropped. Locked in:

1. **Client: browser, Web Workers (WASM optional).** Single-satellite paths for the next 18–24 h and the live
   globe animation stay dynamic: SGP4 on the fly into typed arrays, nothing stored on the backend. A 24 h path at
   10 s is ~8,600 SGP4 calls, a few ms. WASM only if a bench shows a real gain over the existing JS worker (T7).
2. **Backend: conjunction screener, next 36 h.** All-vs-all, precomputed, written to the database.
3. **Backend: history archive.** Layers 1–3 of the decision above (element sets forever, daily star-map lists at
   orders 3 and 4, derived events). With 500 GB, hourly order-4 lists (~129 GB / 5 y), region passes for watched
   regions (~33 GB) and the full close-approach set under 5 km may also be kept forever instead of dropped.

**Screener design (engineering choice, from rounds 2 and T2).**
- Filter: the SpaceCell key used as a hash grid per time step (5 s), with neighbour cells covered, then exact
  refine. This is "the spatial box index" applied per step. A per-object, whole-window box filter prunes almost
  nothing in LEO (round 2: orbit-shape filters keep 28–77%; the per-step grid was ~1,500× faster).
- Re-run policy: about 28,000 of ~33,000 objects get new element sets each day (measured, 2026-10-17 → 10-18), and
  the cost of a screen is dominated by propagating everything, not by pair checks. So each ingest batch reruns
  the full 36 h screen (~210 s on 4 cores, from T2's 140 s/day grid) rather than an "affected objects only"
  pass, which would save pair checks but still propagate the whole catalog. Event identity is kept across runs
  (same pair, time of closest approach within a tolerance), so each conjunction carries its update history.
- Stored per event: pair, time of closest approach, miss distance, relative speed, radial / along-track /
  cross-track miss, element-set epochs used, category label (crossing / same_family / same_launch), first seen,
  last updated. Formation pairs and identical element sets are excluded as in T2. Screening threshold 5 km
  (~110k events per 36 h window); events under 1 km flagged.
- Collision probability: included. The uncertainty around each prediction is measured from element-set history
  (U5, owner restored it 2026-10-24) and feeds Pc in the screener (S5). The browser pack prototype (P5) replaces
  the WASM bench: WASM only if JS SGP4 is a measured bottleneck.
