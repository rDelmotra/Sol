# History backfill runbook (lab, 1959 .. 2026)

Goal: from the 68 yearly parquet files (239,532,262 rows) produce, as FILES only, per-day element sets, star-map coverage lists
(daily order 3 + 4, no hourly) and change events (object.appeared / object.disappeared / elements.jump / close.formation) for every UTC day,
in the formats production reads. Paths below are examples; every path is a CLI argument. `$R` = the repo clone, `$W` = /workspace/csProjects/orbw.

```
export R=$W/Sol            # the clone
export M=$W/data/tle_history/data
export OUT=$W/out          # on the 2.5 TB disk
```

## 0. Node 22 and the repo (one time)
Any one of:
- `conda install -c conda-forge nodejs=22`
- `pip install 'nodejs-wheel-binaries==22.*'` (then `python3 -m nodejs_wheel node ...`, or put its bin dir on PATH)
- tarball from nodejs.org (`node-v22.*-linux-x64.tar.xz`), unpack, add `bin` to PATH.

Then `cd $R && npm ci && npm run build:libs`. `npm ci` needs the npm registry (no offline mode exists for a fresh clone). If the lab
cannot reach it, run `npm ci` on a machine that can and copy the whole `node_modules/` (root and `packages/*/node_modules`) plus the
built `packages/*/dist` into the clone (same Node major, same CPU architecture). No new dependency was added; no parquet library is
needed in Node (conversion is Python + duckdb).

## 1. Convert (Python, duckdb only)
```
python3 -I $R/packages/backend/scripts/history/convert.py --mirror $M --satcat $W/data/satcat.parquet --gcat $W/data/gcat \
   --out $OUT/conv --jobs 48 --threads 4 --memory-limit 12GB
```
Writes `$OUT/conv/elsets/YYYY/YYYY-MM-DD.jsonl.gz`, `$OUT/conv/objects.jsonl.gz`, per-month markers in `.work/months/` (restartable: rerun the
same command; finished months are skipped, `--force` redoes). Prints per-year rows in / out / dropped; "dropped" = duplicate (norad, epoch)
rows and rows with non-finite elements. Check the total in = 239,532,262.
Measured here (4 cores, 12 M synthetic rows, `--jobs 4 --threads 1`): 50 s => ~60 k rows/s/core => the full mirror is ~1 h of one core
x 66 = well under 30 min on 48 jobs (disk bound at that point). Output ~65 B/row gzipped => ~15-18 GB.

Validate against the one Space-Track dump you have:
```
python3 -I .../convert.py --verify $W/data/check/st-2026-03-14.json --mirror $M
```
Expect ~100 % matched, max deltas at the printed-precision of Space-Track (1e-4 deg, 1e-7 ecc); the mirror/ST ratio of MEAN_MOTION_DOT should be ~1.
A ratio near 2 or 0.5 means the mirror stores a different ndot convention: tell the lead before building.

## 2. Era statistics (sets the catalog staleness window)
```
python3 -I .../era-stats.py --mirror $M --jobs 16 --threads 4 --era-json $OUT/era.json
```
Per year: gap between consecutive sets of an object (median, p90, p99) and window = max(30 d, 1.5 x p90). `$OUT/era.json` (one row per year)
is accepted by build-range `--era-file`. `ERA_TABLE` in `packages/backend/src/ssa/history/era.ts` now holds the owner's measured windows (1959 34,
1960 30, 1961 30, 1962 61, 1963 93, 1964 87, 1965 49, 1966 88, 1967 41, 1968 58, 1969 47, 1970 31, 1971+ 30) plus the pre-1980 SGP policy, jump
thresholds and accuracy (section 8). An era.json from era-stats.py has none of the section 8 fields: for 1959-1979 use `--print-era` instead.
Windows above 60 d only help the events: coverage skips sets more than 60 d old.

## 3. Numerical check of the mirror (SGP4 chain)
```
cd $R/packages/backend
npx tsx scripts/history/build-range.ts --check-chain --elsets $OUT/conv/elsets --years 1962,1970,1980,1990,2000,2010,2020,2025 --sample 400 --window-days 14 --json $OUT/chain.json
```
Propagates each set to the next set's epoch and prints median / p95 / p99 position difference per year. Reference (local 2026 data, 981 pairs
with gap <= 1 d): median 0.7 km, p95 21 km (manoeuvres). A year whose median at short gaps is hundreds of km indicates a unit or
column problem in that era (B*, mean motion, angles) - stop and report. Exception: 1959-1979, see section 8 (the default propagation is now the
era table's model; `--propagator sgp4` gives the old SGP4-only numbers). A 14-day window gives only 4-23 short-gap pairs in the 1960s; use
`--start 01-01 --window-days 365 --sample 100000` there.

## 4. Build (coverage + events), sharded
Measured here: 13.6 CPU-ms per object-day for coverage (32,740 objects: 115 s on 4 cores, 7.4 CPU-min), changes ~26 s/day at 32.7 k objects
(single thread, runs in its own worker), peak RSS 1.7 GB per process at 32 k objects with 4 workers.
Reading the cost for the whole range (objects/year interpolated from your counts, ~252 M object-days): ~950 CPU-hours => **~5 h on 192
cores**, ~6-7 h with changes and imbalance. Leave ~64 cores free on the shared box: **8 processes x 24 workers = 192**.

```
cd $R/packages/backend
for k in 0 1 2 3 4 5 6 7; do
  nohup npx tsx scripts/history/build-range.ts --elsets $OUT/conv/elsets --objects $OUT/conv/objects.jsonl.gz --out $OUT/build \
     --from 1959-01-11 --to 2026-03-31 --workers 24 --parts coverage,changes --shard $k/8 --era-file $OUT/era.json \
     > $OUT/build-$k.log 2>&1 &
done
```
(drop `--era-file` to use the table in `era.ts`). Shards are round robin by day so they finish together; each process re-reads the day files (cheap).
The log prints every 15 s: days done, days/hour, ETA, peak RSS. Restart: rerun the same commands; a day/part with a marker under
`$OUT/build/done/<part>/YYYY/<day>.json` is skipped. Failed days are logged (`FAILED`), exit code 1, and have no marker, so a rerun retries them.
Memory: ~2 GB x 8 = 16 GB of 1 TB; the machine is CPU bound. Early years finish in minutes (hundreds to thousands of objects).

Output tree: `build/coverage/<day>/{manifest.json,day.o3.bin,day.o4.bin}`, `build/events/YYYY/<day>.jsonl.gz`, `build/done/...`.

## 5. Sizes (measured per object, scaled)
- coverage: ~266 B per object-day (8.7 MB/day at 32.7 k objects; 0.5 MB/day in 1968, 4.6 MB in 2017) => **~65-70 GB** total.
- events: 8 KB-1 MB per day (the first day after a data gap is large) => a few GB at most.
- converted element sets: ~15-18 GB. Markers: ~50 k tiny files.

## 6. Copy results back
One tar per year (the app volume layout is `<SSA_COVERAGE_DIR>/<day>/...`):
```
cd $OUT/build
for y in $(seq 1959 2026); do
  tar -cf $OUT/cov-$y.tar -C coverage $(cd coverage && ls -d $y-* 2>/dev/null)     # coverage days of the year
  tar -cf $OUT/events-$y.tar events/$y done/changes/$y done/coverage/$y 2>/dev/null
done
```
(coverage .bin files do not compress; the events do not need extra compression, they are already gz.)
Bring back `$OUT/era.json`, `chain.json`, the logs, and `conv/objects.jsonl.gz`.

## 7. Import on the app side
Coverage: untar the `cov-*.tar` files into the app's `SSA_COVERAGE_DIR` (a day exists once its `manifest.json` does; the production reader
works on these directories - daily layers only, no hour layer; the hourly retention does not touch them). Events + status:
```
DATABASE_URL=... npx tsx packages/backend/scripts/history/import-events.ts --in <dir with events/ and done/> --coverage $SSA_COVERAGE_DIR [--from D --to D] [--dry-run]
```
One transaction per day (delete the day's rows of those kinds, insert, mark `ssa_day_status` changes done); `--coverage` also marks coverage done so
the nightly catch-up does not rebuild the days. Idempotent. Migrations must already be applied (app boot).

## Notes / limits
- Frames: every per-day file stays in TEME of its own day. `packages/orbital-core/src/frames.ts` (TEME <-> J2000, `rotateBetweenDates`) exists for
  comparing cells across dates; it is not used by the build.
- ELEMENT_SET_NO, REV_AT_EPOCH, MEAN_MOTION_DDOT are 0, classification 'U', ephemeris type 0 (not in the mirror). Epochs are truncated to ms.
- Regime / perigee / apogee are computed from each day's own element set (not from the future); object name, launch date, decay date come from the
  objects file. Objects with decay_date before the day are left out of that day's catalog.
- GCAT parsing (`satcat.tsv`, fallback only) was written from the documented format and tested on a hand-made fixture, not on the real file.
- From 1986 the mirror holds duplicate element sets: identical elements with epochs exactly TAI-UTC apart (23 s in 1986-87, 24 s in 1988-89;
  0.9-2.4 % of all sets; a handful before 1986). They show as ~170-185 km along-track chain differences (1986-89 chain p95 ~175-186 km vs
  30-45 km in 1980-85). Not handled yet (needs a dedupe rule in convert.py and a rebuild of the affected years); measured on 1986-1989 only.

## 8. Pre-1980 element sets: SGP propagation, era jump thresholds, accuracy (rebuild 1959-01-11 .. 1979-12-31)
**Cause (measured on the mirror's 1959-1989 files, converted locally).** Sets before ~1974 were generated for the original SGP model: B* = 0 in
99-100 % of 1959-1972 sets; their drag is in MEAN_MOTION_DOT. The mirror's MEAN_MOTION_DOT is ndot/2 in rev/day^2 like today (change of
MEAN_MOTION between consecutive sets / gap = 2.0-2.35 x the field in every era, 2.00 in 1980), no x2 / x1/2 error; epochs are not quantised;
duplicate (norad, epoch) rows are identical copies. SGP4 ignores MEAN_MOTION_DOT, so B* = 0 objects fly drag-free: the chain error is along-track
(|I| >> |R|, |C|), the later set ahead in 70-94 % of low-perigee pairs, and the along-track angle / 2 pi (ndot/2) t^2 has median 1.01-1.13 for
B* = 0 low-perigee pairs 1960-1979 (~0 for B* != 0 pairs). That is the 1965-1979 excess. 1959-1964 also carry genuinely bad sets (two sets
seconds apart half an orbit apart, gross mean-motion jumps of debris): no propagator removes those.

**Fix.** `packages/orbital-core/src/sgp.ts` (Spacetrack Report #3 SGP; nddot = 0, the mirror has none; estimating it from the previous set did
not help). Policy (`src/ssa/history/propagator-policy.ts`, era rows `sgp`): 1959-1972 SGP for every B* = 0 set; 1973-1979 SGP for near-Earth
B* = 0 sets with drag drift 2 pi a |ndot/2| >= 3 km/day^2; everything else, and all of 1980+, SGP4 (byte-identical to before). Coverage
manifests of such days list the SGP objects (`propagators.sgp`) and carry `accuracy {medianKm, p95Km, basis}`; elements.jump payloads carry
`acc: [median, p95]`. 1980-1989 need NO rebuild: SGP on their B* = 0 sets is worse (1980 B* = 0 pairs: 5.3 -> 8.4 km median; they are mostly
deep space).

**Measured chain check** (whole year, every object 1959-1972, 3000-object sample 1973-1979, next set <= 5 d later; median / p95 km):

| year | SGP4 | era model | | year | SGP4 | era model |
|---|---|---|---|---|---|---|
| 1959 | 2446 / 12961 | 1024 / 13526 | | 1970 | 49 / 1241 | 17 / 240 |
| 1960 | 905 / 7764 | 443 / 2426 | | 1971 | 20 / 451 | 11 / 126 |
| 1961 | 312 / 9042 | 182 / 3783 | | 1972 | 21 / 418 | 12 / 136 |
| 1962 | 1856 / 12851 | 999 / 12920 | | 1973 | 9.7 / 254 | 9.9 / 96 |
| 1963 | 867 / 6204 | 661 / 2624 | | 1974 | 9.5 / 78 | 9.5 / 72 |
| 1964 | 542 / 5711 | 181 / 2664 | | 1975 | 9.2 / 78 | 9.1 / 51 |
| 1965 | 287 / 3440 | 79 / 808 | | 1976 | 10.8 / 157 | 10.5 / 60 |
| 1966 | 189 / 2325 | 58 / 397 | | 1977 | 10.9 / 122 | 10.6 / 50 |
| 1967 | 166 / 2854 | 78 / 854 | | 1978 | 11.4 / 118 | 11.1 / 59 |
| 1968 | 262 / 3336 | 97 / 966 | | 1979 | 8.6 / 103 | 8.6 / 61 |
| 1969 | 185 / 3934 | 85 / 1306 | | 1980-85 | 4.2-5.0 / 30-46 | unchanged |

**Jump thresholds.** With the production thresholds, 9.6-37.5 % of the changed sets of debris and rocket bodies (which cannot manoeuvre) were
flagged as elements.jump in 1959-1969 (1980-1985: 0.9-1.3 %). The binding test is |da| / |resid|, not the 16.3 km position step, so the model
change alone does not move it. Per-year `jumpDaKm` (era.ts) brings it to <= 1.2 % (fitted on the same data, in-sample): 1959-1961 15 km, 1962 20,
1963 50, 1964-1965 10, 1966 75, 1967 150, 1968 100, 1969 150, 1970 30, 1971 5, 1972-1973 7, 1974 2, 1975 1, 1976 1.5, 1977 2, 1978-1979 1.5;
jumpDposKm stays 16.3. Before 1971 only large orbit changes are detectable.

**Lab commands** (W=/workspace/csProjects/orbw, repo at $W/Sol, converted files already at $OUT/conv):
```
export W=/workspace/csProjects/orbw R=$W/Sol OUT=$W/out PATH=$HOME/bin:$PATH
cd $R && git pull && npm run build:libs              # after the lead has committed this change; orbital-core dist gains sgp.js
cd $R/packages/backend
npx tsx scripts/history/build-range.ts --print-era > $OUT/era-sgp.json      # NOT $OUT/era.json: that file has no sgp policy (warning, fix off)
# optional check, a few minutes: era model vs SGP4 on whole-year samples
for p in era sgp4; do
  nice -n 10 npx tsx scripts/history/build-range.ts --check-chain --elsets $OUT/conv/elsets --years 1960,1965,1970,1975,1979,1985 \
     --start 01-01 --window-days 365 --sample 100000 --era-file $OUT/era-sgp.json --propagator $p --json $OUT/chain-$p.json
done
# rebuild coverage + changes of 1959-01-11 .. 1979-12-31 (--force: those days have markers)
for k in 0 1 2 3 4 5 6 7 8 9; do
  nohup nice -n 10 npx tsx scripts/history/build-range.ts --elsets $OUT/conv/elsets --objects $OUT/conv/objects.jsonl.gz --out $OUT/build \
     --from 1959-01-11 --to 1979-12-31 --workers 25 --parts coverage,changes --shard $k/10 --era-file $OUT/era-sgp.json --force \
     > $OUT/build-sgp-$k.log 2>&1 &
done
wait
# 1980-01-01's changes compare against 1979-12-31's catalog (now SGP for some sets): redo that one day's changes
nice -n 10 npx tsx scripts/history/build-range.ts --elsets $OUT/conv/elsets --objects $OUT/conv/objects.jsonl.gz --out $OUT/build \
   --from 1980-01-01 --to 1980-01-01 --workers 1 --parts changes --era-file $OUT/era-sgp.json --force > $OUT/build-sgp-1980.log 2>&1
grep -h FAILED $OUT/build-sgp-*.log | head        # expect nothing
```
Check: `$OUT/build/done/coverage/1965/1965-06-10.json` has `sgpObjects` (locally 514 of 514), the manifest has `propagators` and `accuracy`.
Then section 6 / 7 again for 1959-1980 (tars of those years, `import-events.ts --from 1959-01-11 --to 1980-01-01`). If your era.json windows for
1959-1979 differ from the table above, edit `windowDays` in `$OUT/era-sgp.json` before the rebuild.
Cost (estimate, not measured on the lab): locally 15 CPU-ms per object-day (1979-06-10: 3,897 objects, 14.8 s on 4 workers), < 4 k objects per day
before 1980 -> well under 1 h on 10 x 25 workers, the single-thread change detection per process included.

