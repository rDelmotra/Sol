# Task cards (do them in this order)

Each card is self-contained. Before starting any card, read `README.md` and `CONTEXT.md` in this
folder. Run `bash packages/backend/scripts/starmap/check.sh` before every commit. Append results
to `design/marvin/STARMAP.md` as `## Round 4 — <card id>`, numbers first, then a plain-words
verdict.

---

## T0 — Setup and sanity (about 20 min; must pass before anything else)

1. Follow the setup block in `README.md`. Record cores, RAM, Node version, and disk free.
2. Sanity-reproduce one round-1 number:
   `npx tsx packages/backend/scripts/starmap/build-index.ts --order 4 --step 20 --hours 3`.
   It should report about 7M rows for about 32.6k objects (rows scale with catalog size). Record
   the wall time; it tells you this machine's speed relative to the Mac (3 h took about 4 s on 10 Mac
   cores, at 30 s steps).
3. `npx tsx packages/backend/scripts/starmap/measure.ts --hours 1` should report misses of about
   0.03–0.3% (all about 1 s corner clips) and time errors of about 0.3 s.

**Done when:** `check.sh` passes, both numbers are in the same range, and the machine facts are
noted in STARMAP.md.

---

## T1 — Layer 2: star-map coverage summaries, finished properly

**Owner's design rule (do not break it):** space objects are indexed ONLY in the star map
(TEME, which does not rotate with the Earth). The Earth map (ECEF, rotating) is a separate store
for separate purposes (ground regions, weather, airfields) and is NOT built in this spike.
Never index satellites in Earth-fixed cells. A ground question ("who passed over India") is
answered by rotating the ground region INTO the star map for each time slice (one rotation by
`gmst(t)`; India's footprint maps to a different set of star cells every slice), then looking up
the star-map summaries for those cells and slices.

**Question:** can per-period "which star-map cells did each object visit" summaries, kept forever,
answer long-window questions with 100% recall, small storage and fast queries? The questions
are "who passed through this space box in the last N days" and "who passed over India in the
last N days, and when".

**Read first:**
- `packages/backend/scripts/starmap/coverage.ts`, `coverage-lib.ts`, `coverage-worker.ts`,
  `coverage-codec.ts`, `coverage-query.ts`, `coverage-hourly.ts` (built on the Mac).
  - They ALSO built Earth-frame cells; remove that path.
  - Measured on the Mac: Earth daily summaries pruned nothing, because 99.8% of 208k candidates
    were real. That confirms they are useless.
- `runs.ts` (`buildRunsBy`);
- `spacecell.ts` (`cellKey`, `coverBall`, `pix2angNest`).

**Spec:**
- **Build, per period, using each history file's own element sets:** SGP4 every 20 s + bisection
  (`buildRunsBy` with key `cellKey(order, …)` in TEME), orders 2, 3, 4. Record per (order, cell,
  period) the sorted object list, with delta + varint or a bitmap when dense. Write to
  `packages/backend/data/coverage/` (gitignored).
- **Granularity:** daily AND hourly (and 10-minute if cheap). Within a day an object sweeps a
  whole ring of the star map. Finer periods should make each list sharper; measure how much
  sharper versus the extra storage.

**Run:**
1. Build all 29 contiguous days, 2026-09-20..2026-10-18, plus the weekly days from 2026-06-30.
   Per day, measure wall time, SGP4 calls, peak RSS, and bytes per (order, granularity).
2. Questions, via summary → candidates (object, period) → exact SGP4 refine on candidates only:
   - **Q-L2:** "who passed through order-3 star-map box B in the last 29 days, and when" (pick a
     busy LEO box). Cover = the box itself (plus children at finer orders).
   - **Q-L1:** "who passed over India in the last 29 days, and when".
     - Region = a rough ~12-vertex lat/lon polygon (in code).
     - For each period P, build the conservative set of star-map cells that the volume above India
       (ground to ~2,000 km, plus a separate run for ~36,000 km to catch GEO) occupies at ANY
       instant in P: rotate sampled points of the polygon×height prism into TEME at the period's
       start and end and in between (step ≤ the time India takes to rotate one cell width), and
       take `cellKey` over them, padded with `coverBall` at the cell size.
     - Merge the lists → candidates → refine with SGP4 (sub-satellite point inside the polygon;
       20 s + bisection).
   - Report candidates, refine time, total, #objects, #passes, for each order × granularity.
3. **Graze fix:** the Mac refine missed sub-20 s grazes (49 India / 42 box object-days). `coverage-worker.ts` now keys on cell + pass flag, but this was NOT re-run. Re-run and confirm recall is 100%.
4. **Truth:**
   - The Mac has one day (2026-10-12) of brute force for Q-L1 and box 9138, in
     `packages/backend/data/coverage/truth-*`, only if you rebuild it here.
   - Brute force here: ALL objects over at least 2 days at 10 s, parallel on all cores. On the Mac
     it took about 20 min per day, so budget for it. Measure the first day before committing to
     more.
   - Recall must be 100%.
5. **Q-L3, the orbit-shape shortcut:** predict Q-L1/Q-L2 from elements alone (latitude band reachable
   = i or 180−i; GEO by longitude; height band vs the box's shell). Report false negatives and false
   positives vs truth by regime. Long windows may make the shortcut as good as the summaries; say
   so if they do.
6. Extrapolate to 1,826 days: storage per option and query time.

**Done when:**
- recall is 100% on the truth days;
- the table covers order × granularity;
- there is a recommendation (orders, granularity, GB per 5 years) and a plain statement of where the
  summaries beat the shortcut and where they don't.

Commit the code and the STARMAP.md section.

---

## T2 — Layer 3: derived events, finished properly

**Question:** which facts should a daily job derive once and keep forever, how big are they, and
are they right?

**Read first:**
- `events.ts`, `derive-day.ts`, `events-queries.ts`, `jump-dist.ts`, `events-worker.ts`,
  `events-pool.ts` (built on the Mac, partial);
- `screen-lib.ts`, `screen-all.ts` (grid screen);
- `design/marvin/FABRIC.md` sections B6–B7 (the event log shape).

**Table:** `starmap.event(id bigserial, day date, kind text, subjects int[], t_start timestamptz,
t_end timestamptz, payload jsonb)`, with indexes on (kind, day), GIN(subjects) and (t_start).
Needs `STARMAP_DB`.

**Kinds:**
1. `object.appeared` / `object.disappeared` (set difference vs the previous day). Classify
   disappearance as decay (low last perigee, high drag, falling mean motion) vs stale (elements
   aged out of the 30-day window). Report how ambiguous this is.
2. `elements.jump`: when an object's epoch changes, propagate the old element set to the new epoch
   and compare it with the new one. Report the distribution by regime (p50/p90/p99), choose a
   threshold and justify it, and also flag Δa above a threshold. Show the top examples.
3. `close.approach` < 5 km all-vs-all over the day, via the per-step grid (screen-all's approach):
   - exclude identical element sets;
   - add a separate `close.formation` kind for pairs within 50 km for more than 50% of the day;
   - **Mac finding (12 days, see STARMAP.md Round 4):** the 70–77k/day are REAL geometry (97% relative speed > 2 km/s, consistent with LEO density), not duplicates. So redefine what gets stored (e.g. < 1 km, or ranked by miss distance × relative speed), measure the count, and keep the full < 5 km set on-demand only.
   - **then categorise the remainder.** The Mac saw 70–77k approaches/day, which is not
     believable as conjunctions. Break them down by: same constellation/name prefix, near-identical
     elements (Δa < 1 km, Δi < 0.01°, ΔΩ < 0.01°), same launch (OBJECT_ID prefix), duration of
     closeness. Decide which are real "approaches" and redefine the kind so the count is
     believable. Report before and after.
4. `region.pass` for 8 regions: India, CONUS, Europe, China, Brazil, Australia, Japan, and a 500 km
   circle around Bangalore (rough polygons in code). Record exact entry/exit times (20 s +
   bisection). This is the biggest kind; report rows/day and consider limiting it to payloads, or
   to on-demand computation.

**Run:**
1. Derive all 29 days. Report per day, per kind: rows, derive time, storage, and extrapolate to 5 years.
2. Questions (median of 5 runs each):
   - Q-E1: all ISS (25544) passes over India in the 29 days;
   - Q-E2: all close approaches involving one busy object;
   - Q-E3: Starlink manoeuvres in the last 7 days;
   - Q-E4: which objects disappeared in 29 days, and whether they were decays.
3. Verify:
   - Q-E1 against brute-force SGP4 at 5 s over the 29 days (passes must match within ~20 s);
   - recompute 5 close approaches exactly;
   - spot-check 5 jumps by hand.

**Done when:**
- every kind has counts, size and verification;
- close approaches are categorised and redefined to a believable count;
- there is a verdict per kind: keep forever, compute on demand, or drop.

Commit the code and the STARMAP.md section.

---

## T3 — The planner (`ask.ts`): one router over all layers

**Prerequisites:** T1 and T2 are done.

Write `packages/backend/scripts/starmap/ask.ts`, a small router. It classifies each question by
time window (instant / hours / days / months) and kind (region-in-time, one-vs-all proximity,
all-vs-all, long-window pass, repeated fact). It then runs the cheapest layer path and prints the
path taken plus timings. Six fixed questions:

1. Who is over India right now? (Layer 4: SGP4 all at one instant, then point-in-polygon.)
2. Who came within 100 km of the ISS in the last hour? (Layer 4: coarse time filter, then refine.)
3. Close approaches under 5 km in the last 24 h. (Layer 3 lookup if derived; else the Layer 4 grid.)
4. Who passed over India in the last 29 days, and when? (Layer 2 star-map summaries with India rotated into the star map per period, then refine.)
5. Who passed through star-map box B in the last 29 days? (Layer 2, then refine.)
6. Every ISS pass over India this month. (Layer 3 lookup, cross-checked with Layer 2 + refine.)

For each, also run the brute-force path once and report the speed-up and agreement (100% required).

**Done when:** all six questions agree with brute force and the timing table is in STARMAP.md.

---

## T4 — The decision (write-up only)

Append `## Decision — storage and indexing for the Perceptor` to `design/marvin/STARMAP.md`:

- Which layers to build, with exact settings: orders, granularity (star map only), what is kept forever
  vs computed, retention.
- The daily job: what it computes, how long it takes per day on N cores, its memory.
- Storage per day and per 5 years, per layer.
- What is dropped and why, with one line each and the round that measured it: the stored box
  index, stored day lines, ML surrogate, invariant DB indexes for live data, same-box proximity.
- What production needs:
  - the TimescaleDB + PostGIS image instead of plain Postgres;
  - cores, RAM, disk;
  - whether to do the 5-year backfill. That needs Space-Track history access, which the owner
    must arrange; do not attempt it.
- Open problems (honest).

Then write a short plain-words summary paragraph at the top of that section for the owner.

---

## Optional T5 — Scaling on more cores

Rerun the daily coverage + events job for one day with `--workers 1, 2, 4, 8, 16, …` up to the
machine's cores. Report the speed-up curve, and estimate the time for one day and for a 5-year
backfill on Railway-like machines (8 and 32 vCPU).
