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
is accepted by build-range `--era-file`. The lead copies the final numbers into `packages/backend/src/ssa/history/era.ts` (`ERA_TABLE`; today
PLACEHOLDERS: 1959 60 d, 1970 45 d, 1990 35 d, 2010+ 30 d = production). Windows above 60 d only help the events: coverage skips sets more than 60 d old.

## 3. Numerical check of the mirror (SGP4 chain)
```
cd $R/packages/backend
npx tsx scripts/history/build-range.ts --check-chain --elsets $OUT/conv/elsets --years 1962,1970,1980,1990,2000,2010,2020,2025 --sample 400 --window-days 14 --json $OUT/chain.json
```
Propagates each set to the next set's epoch and prints median / p95 / p99 position difference per year. Reference (local 2026 data, 981 pairs
with gap <= 1 d): median 0.7 km, p95 21 km (manoeuvres). A year whose median at short gaps is hundreds of km indicates a unit or
column problem in that era (B*, mean motion, angles) - stop and report.

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
