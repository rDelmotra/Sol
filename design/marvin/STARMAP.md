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
