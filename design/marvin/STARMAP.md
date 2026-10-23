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
