# Star map spike — runbook for a fresh (cloud) environment

> Hand this file to a Claude Code cloud session on branch `spike/starmap`. It explains what the
> spike is, how to set up, how to reproduce every round, and what is still to be done.
> Findings so far are in `design/marvin/STARMAP.md` — read it first.

## Rules for the session

- Work on branch `spike/starmap`. Commit one compact commit per step. No `Co-Authored-By` trailer.
- Never touch Railway or the production database. The only allowed contact with production is the
  public read endpoints used by `fetch-data.sh` (one request per day of history, 1 s apart).
- Everything is a SPIKE: scripts live in `packages/backend/scripts/starmap/`, not in `src/`.
- Report numbers honestly, with the machine (cores, RAM) they were measured on.

## 1. Setup

```bash
npm install
npm run build:libs
bash packages/backend/scripts/starmap/fetch-data.sh
```

`fetch-data.sh` fills the gitignored `packages/backend/data/` folder: the live catalog
(`tle-cache.json`) and ~42 past-day catalogs (`history/catalog-YYYY-MM-DD.json`, ~1 GB).
History before ~2026-06-23 is nearly empty; the script skips it.

**Database (needed for rounds 1–3 and the events prototype; not for coverage).** Postgres 16 +
TimescaleDB 2.x + PostGIS. Either:
- Docker: `docker run -d --name orbitwatch-timescaledb -e POSTGRES_USER=orbitwatch -e POSTGRES_PASSWORD=orbitwatch -e POSTGRES_DB=orbitwatch -p 5432:5432 timescale/timescaledb-ha:pg16`
- or no Docker: install Postgres 16 and the `timescaledb` package for it, create user/db
  `orbitwatch`/`orbitwatch`, `shared_preload_libraries = 'timescaledb'`.

Connection: `postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch`. Some scripts call
`docker exec -i orbitwatch-timescaledb psql …` (e.g. `load.sh`, `invariants-db.ts`); without
Docker, replace that with `psql "postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch"`.

**Checks after any change:**

```bash
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck packages/backend/scripts/starmap/*.ts
npx tsx --test packages/orbital-core/src/spacecell.test.ts packages/backend/scripts/starmap/*.test.ts
npx tsx --test tests/architecture.test.ts tests/state.test.ts
```

## 2. Reproduce earlier rounds (optional)

All commands run from the repo root with `npx tsx packages/backend/scripts/starmap/<script>`.

| Round | What | Command(s) |
|---|---|---|
| 1 | Box index accuracy vs 1 s truth | `measure.ts` |
| 1 | Build box runs, whole catalog | `build-index.ts --order 4 --step 20 --hours 6 --out /tmp/starmap/6h-o4.csv`, then `bash …/load.sh /tmp/starmap/6h-o4.csv` |
| 1 | Three checked queries | `queries.ts` (see its header for flags: `--day --catalog --radii --margin`) |
| 2 | DB indexes on orbit invariants | `invariants-db.ts gen`, `load`, `bench` |
| 2 | Pad calibration, MOID, screens | `calibrate.ts`, `screen-iss.ts`, `screen-all.ts`, `screen-box.ts`; `moid.test.ts` |
| 3 | Stored Chebyshev day lines | `build-ephem.ts --catalog … --day … --db`, `bench-ephem.ts --day …` |

Results to compare against are in `design/marvin/STARMAP.md` (Mac: 10 cores, 16 GB).

## 3. Open work (this is what to run)

The proposed architecture has four layers: (1) element sets kept forever, indexed by time;
(2) daily coverage summaries kept forever; (3) derived events kept forever; (4) a live window
computed in memory. Layers 1 and 4 are measured. Layers 2 and 3 were being prototyped on a Mac;
if their files are already committed, re-run them here; if not, build them from these specs.

### 3a. Layer 2 — daily coverage summaries (files `coverage*.ts`)

Once per day, run SGP4 for every object over that UTC day (20 s steps + bisection, reuse
`runs.ts`) and record only which coarse cells each object visited, in two frames: the star map
(SpaceCell boxes in TEME, orders 2/3/4) and the Earth map (HEALPix NESTED ground cell of the
sub-satellite point, orders 4/5/6 ≈ 440/220/110 km; use orbital-core `gmst`, `temeToEcef`, and
the geodetic helpers in `earth.ts`). Store inverted: per (frame, order, cell, day) → sorted
object list (delta + varint, or bitmap when dense). Measure bytes/day, GB per 5 years, build
time per day.

Queries over the 29 contiguous days (2026-09-20..10-18): "who passed over India, and when"
(rough ~12-vertex lat/lon polygon; conservative cell cover) and "who passed through this order-3
star-map box". Pipeline: merge cell-day lists → candidate (object, day) → exact SGP4 refine on
those only. Truth: brute force, all objects, latest 7 days, 10 s. Recall must be 100%. Also test
the orbit-shape shortcut (inclination reaches the latitude band; GEO by longitude; height band
for boxes) against the same truth, by regime. Extrapolate the query to 1,826 days.

### 3b. Layer 3 — derived events (files `events*.ts`, `derive-day.ts`, `jump-dist.ts`)

For each of the 29 days derive and store in `starmap.event(id bigserial, day, kind, subjects
int[], t_start, t_end, payload jsonb)`: object.appeared/disappeared (with decay vs stale
classification), elements.jump (previous elset propagated to the new epoch vs new elset;
threshold from the distribution), close.approach < 5 km all-vs-all via the grid screen
(excluding identical element sets; separate "formation" kind for pairs within 50 km > 50% of the
day), and region.pass for 8 named regions (India, CONUS, Europe, China, Brazil, Australia,
Japan, 500 km around Bangalore). Measure rows/day per kind, derive time, storage per 5 years,
lookup times, and verify ISS passes over India against brute-force SGP4 at 5 s.

### 3c. Then: the planner and the decision

Write `ask.ts`: a small router that answers six example questions through the cheapest layer
path and prints timings — (1) who is over India right now; (2) who came within 100 km of the
ISS in the last hour; (3) close approaches under 5 km in the last 24 h; (4) who passed over India
in the last 29 days, and when; (5) who passed through a star-map box in the last 29 days;
(6) every ISS pass over India this month. Then append a "Decision" section to
`design/marvin/STARMAP.md`: which layers and settings to build for the Perceptor (the "god
feature"), which ideas are dropped (stored box index, stored day lines, ML surrogate, DB
indexes on invariants for live data), storage and compute budget per day and per 5 years, and
what Railway needs (TimescaleDB + PostGIS image, cores, RAM, disk).
