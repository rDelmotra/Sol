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

---

# Round 5 (owner decisions 2026-10-24): uncertainty, forward screener, browser pack

Owner rulings: storage (~500 GB) and compute are not constraints. 14-day recent-window box index dropped. Three
operational layers: (1) browser computes single-object paths and the live globe; (2) backend screens all-vs-all
for the next 36 h; (3) history archive as decided. Uncertainty (an error region around each prediction) is
needed for collision probability, so it is measured from history. Order: U5 and P5 in parallel, then S5.

## U5 — Uncertainty model from element-set history

Element sets carry no error estimate. Estimate one the standard way (CSSI, SDC4; Flohrer et al., SDC5):
propagate an object's older element set to the epoch of a newer one, and take the position and velocity
difference in the newer one's radial / along-track / cross-track frame (RIC). Collect this for all pairs with
epoch gap 0.25–14 days, over the 29 daily files 2026-09-20..10-18 (deduplicate element sets by
(noradId, EPOCH)).
- Output `packages/backend/data/uncertainty/model.json`: per class (regime x object type x perigee band for
  LEO) and per gap bin: sigma_R, sigma_I, sigma_C (robust: from median absolute deviation, also p50/p90/p99), and
  a fitted growth law sigma(t) = a + b·t + c·t² per axis. Plus a per-object scale factor where an object has
  >= 8 pairs (its own error / its class's).
- Fence: SGP4 failures, NORAD 54922, objects with manoeuvre jumps between the two epochs (T2 rule) are excluded
  from fitting and counted.
- Calibration (mandatory): hold out the last 5 days. For held-out pairs compute the Mahalanobis distance
  using the model covariance (diagonal in RIC); report the fraction inside 1, 2, 3 sigma vs the chi-square(3)
  expectation (19.9%, 73.9%, 97.1%), per regime. Fix the model until coverage is close, or say where it isn't.
- Done when: the table, the growth curves by regime, the calibration table, and a plain verdict are in
  STARMAP.md as "## Round 5 — U5".

## S5 — 36 h forward conjunction screener with collision probability

`screen-forward.ts`: from the latest element set per object at a batch time, screen all-vs-all for the next
36 h (`--hours` adjustable) with the per-step SpaceCell hash grid (5 s step, neighbour cells; reuse T2's grid
code) and exact refine to the time of closest approach (TCA). Threshold 5 km.
- Per event: pair, TCA, miss km, relative speed, RIC miss, epochs, category label (crossing / same_family /
  same_launch), covariances from U5 at age (TCA − epoch) for each object, combined and projected on the
  encounter plane, collision probability Pc by the 2D Foster method with a stated hard-body radius (by object
  type; say the values), and the maximum possible Pc as a cross-check.
- Store in `starmap.conjunction` (+ `starmap.conjunction_update`), matched across batches (same pair, TCA
  within 60 s) so updates form a history.
- Run: replay batches using consecutive history days 2026-10-12..10-18 as successive ingests (batch time =
  that day 12:00 UTC); report run time per batch, events, Pc distribution, how events persist / change /
  vanish between batches, and the top events by Pc.
- Verify: grid recall vs brute force on a 3 h slice (ISS + 30 busiest + 12 random vs all; T2 method); 5 events
  recomputed exactly; Pc code unit-tested against analytic cases (zero miss with circular covariance:
  Pc = 1 − exp(−R²/2σ²)) and against a numerical 2D integration.
- Done when: recall 100%, tests pass, results in STARMAP.md as "## Round 5 — S5".

## P5 — Browser pack prototype (offline Perceptor in the browser)

Like browser game ports that download a pack once and keep it in the Origin Private File System (OPFS):
build a versioned pack, load it in the browser, answer questions locally in a Web Worker.
- `build-pack.ts`: pack = live catalog elements, the last 14 days of element sets, daily star-map lists of the
  last 14 days (T1 format), U5 model (if present), S5 conjunctions (if present), a manifest with hashes and
  sizes; `.tar.gz` or a chunked format, plus a small daily delta (new element sets only). Report sizes.
- A static prototype page under `packages/backend/scripts/starmap/pack-web/` (not the app): downloads the pack,
  stores it in OPFS, reopens it offline, and in a worker answers: who is over India now (SGP4 + polygon), the
  ISS path for the next 24 h, which objects were in a given star-map box on a given past day.
- Test in headless Chromium via Playwright (pre-installed; do not run `playwright install`): first-load time,
  reload-from-OPFS time, query times, and agreement with the same questions answered in Node.
- Done when: sizes, timings and agreement are in STARMAP.md as "## Round 5 — P5", with a verdict on whether to
  build this into the app and whether WASM is needed (only if JS SGP4 is a measured bottleneck).

## S6 — Faster, industry-shaped 36 h screener (owner approval 2026-10-25)

Upgrade `screen-forward.ts` (S5) on the current codebase and TLE (GP) input. No external test sets (TraCSS
dataset skipped by the owner: ephemeris input, 22 GB).
1. **Apogee–perigee pre-filter** in front of the grid. Use each object's MEASURED radius range over the window
   (a coarse SGP4 pass, padded), not mean-element perigee/apogee (round 2: LEO p99 19 km off, HEO up to 265 km).
   Sort by r_min, sweep, drop pairs whose shells are apart by more than the largest screening extent. Report pairs
   removed and whether it removes propagation work (objects with no overlapping partner) or only pair checks.
2. **Adaptive time stepping.** Coarse step with a provably conservative pad (cell size / neighbour cover large
   enough that no pair inside the screening volume between samples is missed, using a bound on relative
   motion), then fine refinement only on candidate pairs and their time windows. State the bound in the code.
3. **Space Flight Safety Handbook screening volumes** in RIC (U radial, V in-track, W cross-track), by the
   primary's regime; report a conjunction only if the local minimum of miss distance lies inside the volume:

| ID | U km | V km | W km | regime |
|---|---|---|---|---|
| 1 | 10 | 10 | 10 | deep space: 1300 < period < 1800 min, e < 0.25, i < 35° |
| 2 | 0.4 | 2 | 2 | LEO4: 1200 < perigee ≤ 2000 km, e < 0.25 |
| 3 | 0.4 | 12 | 12 | LEO3: 750 < perigee ≤ 1200 km, e < 0.25 |
| 4 | 0.4 | 25 | 25 | LEO2: 500 < perigee ≤ 750 km, e < 0.25 |
| 5 | 0.4 | 44 | 51 | LEO1: perigee ≤ 500 km, e < 0.25 |
| 6 | 20 | 20 | 20 | other deep space: period > 225 min |
| 7 | 2 | 25 | 25 | other near Earth: period < 225 min |
| 8 | 20 | 50 | 20 | hyperbolic: e ≥ 1 |

   (Table 3 of the 2026 TraCSS/Aerospace Conjunction Screening Testset Users Guide, citing the SFS Handbook v1.7.)
   Screen asymmetric volumes as the guide says: a pair is reported with A as primary if B is in A's volume, and
   vice versa. Also keep a 5 km sphere mode so results compare with S5.
4. **Pc validated against NASA CARA reference cases** in unit tests (CARA_Analysis_Tools publishes Pc test
   cases with expected values; fetch only those small public files, read-only, cite paths and commit them as
   fixtures if their licence allows, else store expected values with a citation).

Run on the same 7 batches (2026-10-12..10-18, batch 12:00 UTC, 36 h). Report per batch: SGP4 calls (instrumented,
not formula), wall time, peak RSS, vs S5. Recall must be 100%: reference = S5's 5 s grid run with a sphere at
least as large as the largest volume's half-diagonal (validated vs brute force in S5), plus a fresh brute-force
3 h slice for the new volumes. Done when: recall 100%, SGP4-call and time reduction tables, CARA tests pass,
results in STARMAP.md as "## Round 5 — S6".
