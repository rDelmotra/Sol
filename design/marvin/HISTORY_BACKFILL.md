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
  Sets taken from McDowell's archive (section 9, 1957-1972 after the merge) carry ELEMENT_SET_NO / REV_AT_EPOCH from the TLE, HIST_SRC 'jcm'
  and XTLE_* provenance fields; MEAN_MOTION_DDOT stays 0 there too (measured, section 9).
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
**Superseded for the rebuild by section 9** (same commands on the merged element sets, plus 1980-01-01..1980-01-30); do section 9 instead of
the rebuild above if McDowell's archive is available.
Check: `$OUT/build/done/coverage/1965/1965-06-10.json` has `sgpObjects` (locally 514 of 514), the manifest has `propagators` and `accuracy`.
Then section 6 / 7 again for 1959-1980 (tars of those years, `import-events.ts --from 1959-01-11 --to 1980-01-01`). If your era.json windows for
1959-1979 differ from the table above, edit `windowDays` in `$OUT/era-sgp.json` before the rebuild.
Cost (estimate, not measured on the lab): locally 15 CPU-ms per object-day (1979-06-10: 3,897 objects, 14.8 s on 4 workers), < 4 k objects per day
before 1980 -> well under 1 h on 10 x 25 workers, the single-thread change detection per process included.


## 9. McDowell's historical element archive for 1957-1972, outlier filter for 1959-1979 (rebuild 1959-01-11 .. 1980-01-30)

> **Stopped (2026-11-05).** planet4589.org's robots.txt has `Disallow: /space/elements/`, so automated download of this archive is not
> permitted. The fetcher now checks robots.txt and refuses unless `--owner-permission` is passed. Ask Jonathan McDowell for a bulk copy or
> permission first (draft email below). The 1,147-object development sample was fetched before this was checked; it is not used further.

Source: https://planet4589.org/space/elements/ (format XTLE: https://planet4589.org/space/xtle.html; about: https://planet4589.org/space/ele.html).
One plain-text file per object, folders of 100 catalogue numbers. Historical only (not for predictions). US-government sets in it came from public
sources / GSFC OIG without redistribution restrictions (ele.html). Scripts: `scripts/history/fetch-mcdowell.py` (download, stdlib),
`convert-mcdowell.py` (XTLE -> per-day files, stdlib), `merge-history.ts` (merge + outlier filter + chain comparison), `src/ssa/history/merge.ts`.

**What is in it (measured on 12 downloaded folders = 1,147 objects: 00000-00300, 00400, 00600, 00800, 01000, 01500, 02000, 03000, 08000;
315,672 sets with epochs <= 1979 kept, 558,017 <= 1985).** Origins (<= 1979): NOR 315,123, SPTR 336, UNK 247, JCM 203, TED 2. ELTYPE 'SGP4',
FRAME 'TEME', TSYS 'UTC', PRIMARY 'Earth' on every kept set (the line-3 defaults: ELTYPE says nothing about the model, see below). PROBLEM
codes: N 13, E 9, G 2 (skipped), EI 1 (kept), I 1. Cross-tag corrections (TLE number != file's object): 376 sets in 9 objects, 1962-1971 (e.g.
236's 1962-1968 sets filed under 237). Brouwer mean motions (EPHTYPE 2): 4,459 sets in 288 objects (1962 2,116, 1963 2,021, 1964 321, 1965 1);
the mirror holds the same sets with the Brouwer value unconverted. McDowell also silently corrected other 1962-1964 mean motions (e.g. 45 in
1962: 3.4e-4 lower than the mirror; 222 / 287 / 60 such sets in 1962 / 1963 / 1964 of the first 4 folders). NDOT2: non-zero mostly 1965-1966 and
1972-1975; 4,099 values implausible (|NDOT2| > 10 |NDOT| per day, up to 1e5: e.g. Echo 1, 1965). XTLE3 sets 75 (all epochs; skipped), EPHTYPE 3
on 333 sets (1974-1976; treated like 0), 241 lines with NDOT2/BSTAR one column off (kept, both 0), 35 lines with corrupt digits (skipped). Apart
from these, the sets are the mirror's NORAD sets (same epochs, same numbers); McDowell has some the mirror lacks (other sources) and lacks some
the mirror has (removed / moved).

**Handling (each measured, chain check = set propagated to the next set of the same object, next set <= 5 d; whole years; sample objects):**
- object identity = the file's object (cross-tag corrected); `--identity tle` reproduces the uncorrected assignment.
- Brouwer -> Kozai: SGP and SGP4 expect the Kozai mean motion; EPHTYPE 2 values are converted by inverting SGP4's un-Kozai step (Spacetrack
  Report #3 / Vallado et al. 2006 `initl`: a1 = (ke/n0)^(2/3), d1 = 3/2 k2 (3cos^2 i - 1) / (a1^2 (1-e^2)^(3/2)), a0 = a1 (1 - d1/3 - d1^2 -
  134/81 d1^3), d0 = same with a0, n'' = n0 / (1 + d0); solved for n0 by fixed point). Test: round trip against satellite.js (Vallado's code)
  on SGP4-VER set 00005 and a 1962 fixture, 1e-10 relative (no published table value was used).
- NDOT2 is kept as XTLE_NDDOT but NOT used (MEAN_MOTION_DDOT = 0): with it (plausible values only) the p95 got worse (1965 441 -> 610 km, 1966
  290 -> 423), the median never improved by more than 0.3 %; the raw values put SGP thousands of km off.
- propagation: the era policy of section 8; an explicit ELTYPE 'SGP' would force SGP (none seen). 'SGP4' is ignored: SGP4 on McDowell's sets
  1959-1972 is 2-4x worse (1965: 194 / 2367 km vs 69 / 455 km with the era rule).
- PROBLEM N, S, G, E, EM, EW, EC, EP skipped; EI, ED kept (flagged). Origin preference: per object-year, if any NOR/SPTR set exists, other
  origins are dropped (114 sets; no measurable effect inside the merge, it matters for McDowell-only object-years).
- merge rule ('matched', per object and calendar year, 1957-1972): where McDowell has the object-year, McDowell's version of every set the mirror
  also has (same object, or - for a moved cross-tag - the number inside the TLE; epoch within 1 s); McDowell-only sets only when the mirror has no
  set of that object-year (1957-1958 exist only in McDowell). Elsewhere, and 1973-1979, the mirror. Measured alternatives: all McDowell sets
  ('available': 1960 p95 4209 vs 2330 km, 1961 1503 vs 1376), plus the mirror's extra epochs ('union': worse 1961-1971, it re-adds sets McDowell
  removed), McDowell for 1973-1979 too (1973 8.0 / 40 vs 7.9 / 37, 1974 8.4 / 36 vs 8.3 / 33).
- outlier filter (all objects, 1957-1979, after the merge): drop a set when BOTH neighbours (<= 5 d away) disagree with it by > k x the year's
  chain p95 (of the merged sets, computed in the same run) AND the neighbours agree with each other within that limit. k = 1: the number of
  dropped sets is nearly flat between k = 1 and 3 in most years (clear outliers; mirror sample 1967 58 / 55 / 55, 1971 67 / 68 / 69 at k 1 / 2 / 3)
  and rises sharply below 1 (normal noise: 1979 sample 15 -> 79 -> 328 dropped at k 1 / 0.5 / 0.25). Whole local catalog 1959-1979: 0.0-0.7 % of sets dropped (1972 1,249 of 180,510; 1979 1,292 of 510,887).
  Without the neighbour-agreement condition the drops were up to 16x larger in the 1970s-1980s for the same k (mirror sample k = 1: 1979 240 vs
  15, 1973 76 vs 7) and similar in the 1960s. It is a self-consistency filter: the chain numbers
  after it are partly circular (the dropped sets are the ones the chain check penalises), so read the drop counts with them.

**Results** (median / p95 km, next set <= 5 d; "sample" = the 1,147 objects McDowell was downloaded for, "all" = every object of the local
mirror 1959-1985, of which only the sample got McDowell's sets; 1980+ identical by construction):

| year | sample mirror | sample merged | all mirror | all merged | | year | sample mirror | sample merged | all mirror | all merged |
|---|---|---|---|---|---|---|---|---|---|---|
| 1959 | 1025 / 13526 | 1025 / 13526 | 1025 / 13526 | 1025 / 13526 | | 1970 | 13.9 / 113 | 13.9 / 110 | 16.9 / 240 | 16.5 / 193 |
| 1960 | 443 / 2426 | 443 / 2330 | 443 / 2426 | 443 / 2330 | | 1971 | 9.5 / 76 | 9.4 / 56 | 10.7 / 126 | 10.6 / 92 |
| 1961 | 182 / 3783 | 173 / 1376 | 182 / 3783 | 173 / 1398 | | 1972 | 10.1 / 52 | 10.1 / 50 | 11.7 / 136 | 11.6 / 97 |
| 1962 | 1020 / 12965 | 532 / 12324 | 999 / 12920 | 532 / 12321 | | 1973 | 7.9 / 37 | 7.9 / 37 | 9.9 / 95 | 9.8 / 67 |
| 1963 | 730 / 4165 | 198 / 1490 | 661 / 2624 | 283 / 1806 | | 1974 | 8.3 / 33 | 8.3 / 33 | 9.5 / 73 | 9.4 / 60 |
| 1964 | 167 / 1778 | 93 / 1155 | 181 / 2664 | 131 / 1443 | | 1975 | 8.2 / 47 | 8.2 / 45 | 9.1 / 51 | 9.1 / 48 |
| 1965 | 70 / 692 | 68 / 441 | 79 / 808 | 78 / 599 | | 1976 | 10.7 / 66 | 10.6 / 62 | 10.5 / 59 | 10.5 / 55 |
| 1966 | 55 / 342 | 55 / 290 | 58 / 397 | 57 / 329 | | 1977 | 10.5 / 25 | 10.5 / 25 | 10.5 / 51 | 10.5 / 45 |
| 1967 | 79 / 625 | 77 / 412 | 78 / 854 | 75 / 476 | | 1978 | 9.9 / 44 | 9.9 / 44 | 11.1 / 59 | 11.0 / 54 |
| 1968 | 100 / 1124 | 99 / 432 | 97 / 966 | 96 / 559 | | 1979 | 8.0 / 46 | 8.0 / 46 | 8.7 / 61 | 8.7 / 58 |
| 1969 | 87 / 865 | 86 / 273 | 85 / 1306 | 83 / 561 | | 1980-85 | | identical | | identical |

Next set <= 1 d (sample, median / p95): 1963 144 / 12968 -> 0.9 / 632 km, 1964 34 / 1253 -> 0.2 / 568, 1965 44 / 10670 -> 39 / 311, 1969 61 / 10318
-> 60 / 437, 1971 10.0 / 8915 -> 9.4 / 156 (pairs 1963 70 -> 145, 1964 149 -> 411: object-years only McDowell has add sets - 1963 4,412 mirror
sets -> 4,489 merged in the whole catalogue - so the pair sets differ; compare medians, not counts). 1959-1960 stay poor: 39 / 204 pairs, the sets themselves
are bad (no source fixes them).

Attribution (sample, final configuration with one fix switched off; median / p95 km, <= 5 d):
- Brouwer conversion off: 1962 532 -> 961, 1963 198 -> 561, 1964 93 -> 96 (p95 1155 -> 1164); <= 1 d 1963 0.9 -> 2.5, 1964 0.2 -> 1.7.
- cross-tag correction off (sets under the number inside the TLE): 1962 532 -> 546; p95 1963 1490 -> 1725, 1964 1155 -> 1325, 1965 441 -> 542,
  1968 432 -> 492, 1969 273 -> 327; <= 1 d p95 1965 311 -> 8431, 1969 437 -> 1995.
- NDOT2 on: p95 1965 441 -> 610, 1966 290 -> 423, 1967 412 -> 422; 1962 p95 12324 -> 12067 (median 532 -> 530). Off by default.
- outlier filter off (merge only): p95 1962 12324 -> 12580, 1963 1490 -> 1625, 1965 441 -> 456, 1969 273 -> 287, 1971 56 -> 58, 1976 62 -> 66.
  On the mirror alone (k = 1): p95 1961 3783 -> 2190, 1963 4165 -> 2918, 1968 1124 -> 492, 1969 865 -> 364; <= 1 d 1971 8915 -> 300.
- no fixes at all (McDowell's sets, TLE numbers, Brouwer values, all origins, no filter): 1960 481 / 6425, 1962 975 / 12920, 1963 577 / 2466 -
  the McDowell gain is the fixes plus McDowell's silent corrections, not the extra sets.
The 1959-1979 accuracy in era.ts (section 8) is the mirror's; after the lab run, `accuracy` can be updated from the merged chain check (below).
The jump thresholds (jumpDaKm) were fitted on the mirror and were not refitted on merged data.

**Lab commands** (W=/workspace/csProjects/orbw, repo $W/Sol, OUT=$W/out; after the lead has committed this change):
```
export W=/workspace/csProjects/orbw R=$W/Sol OUT=$W/out PATH=$HOME/bin:$PATH
cd $R && git pull && npm run build:libs
mkdir -p $W/data/mcdowell            # data only: no scripts in there; everything downloaded is untrusted text
# 1. download: ONE request at a time, 1.5 s apart by default (--interval sets any value), resumable (rerun the same command), gzip on disk.
#    Measured here: 117 folder listings -> 10,821 files / 3,216 MB listed for catalogue numbers 1..11651 (the GCAT cut: smallest number launched
#    after 1979 = 11652; folder 09100/ does not exist) + 203 late-catalogued objects with mirror epochs <= 1979 = 11,024 files.
#    At 1.5 s per request: 11,024 x 1.5 s = 4.6 h (estimate; locally 1,147 files at 1.2 s took 1,386 s, i.e. interval-bound). ~0.7 GB on disk gzipped
#    (estimate from a 4.8x ratio on 18.6 MB of files).
nohup nice -n 10 python3 -I $R/packages/backend/scripts/history/fetch-mcdowell.py --out $W/data/mcdowell --gcat $W/data/gcat/satcat.tsv \
   --objects $OUT/conv/objects.jsonl.gz --gzip --interval 1.5 > $OUT/fetch-mcdowell.log 2>&1 &
#    (--list-only first prints the file count and the estimate after ~3 min of listings.) If the lab cannot reach planet4589.org, run it on a
#    machine that can and copy $W/data/mcdowell over. Check: `tail $OUT/fetch-mcdowell.log` ends "finished: ... 0 errors".
# 2. convert (single process; locally 1,147 files in 21 s, 559 MB RSS -> full archive est. 3-5 min, ~5 GB RSS)
python3 -I $R/packages/backend/scripts/history/convert-mcdowell.py --in $W/data/mcdowell --out $OUT/mcd --to 1979-12-31 > $OUT/convert-mcdowell.log
#    prints counts (cross-tags, Brouwer, problems, origins, eltype / frame / tsys values); any frame other than TEME or tsys other than UTC is
#    skipped and counted - tell the lead if those counts are not ~0.
# 3. merge + outlier filter (single thread; locally 89 s for 1957-1979 of the full mirror). 1980+ day files = hard links to conv/ (same disk).
cd $R/packages/backend
nice -n 10 npx tsx scripts/history/merge-history.ts --merge --mirror $OUT/conv/elsets --jcm $OUT/mcd/elsets --objects $OUT/conv/objects.jsonl.gz \
   --out $OUT/merged --link > $OUT/merge.log 2>&1
# 4. chain check, mirror vs merged, every object, whole years (a few minutes)
nice -n 10 npx tsx scripts/history/merge-history.ts --compare --sources mirror=$OUT/conv/elsets,merged=$OUT/merged/elsets --years 1959-1985 \
   --json $OUT/chain-merged.json > $OUT/chain-merged.log 2>&1
#    expect merged <= mirror in every year 1959-1979 and identical 1980-1985. Optional: era file with the merged accuracy for the manifests
npx tsx scripts/history/build-range.ts --print-era > $OUT/era-sgp.json
python3 -I -c "import json; e=json.load(open('$OUT/era-sgp.json')); c={r['year']: r['merged'] for r in json.load(open('$OUT/chain-merged.json'))}; [r.update(accuracy={**r['accuracy'], 'medianKm': round(c[r['fromYear']]['medianKm'], 1), 'p95Km': round(c[r['fromYear']]['p95Km'])}) for r in e if r.get('accuracy') and r['fromYear'] in c]; json.dump(e, open('$OUT/era-merged.json', 'w'), indent=1)"
# 5. rebuild coverage + changes 1959-01-11 .. 1979-12-31 on the merged files (--force: markers exist); 10 shards x 25 workers
for k in 0 1 2 3 4 5 6 7 8 9; do
  nohup nice -n 10 npx tsx scripts/history/build-range.ts --elsets $OUT/merged/elsets --objects $OUT/merged/objects.jsonl.gz --out $OUT/build \
     --from 1959-01-11 --to 1979-12-31 --workers 25 --parts coverage,changes --shard $k/10 --era-file $OUT/era-merged.json --force \
     > $OUT/build-merged-$k.log 2>&1 &
done
wait
# 6. 1980-01-01 .. 1980-01-30: their catalogs (30-day window) still reach back into 1979, whose sets the filter changed; changes of 1980-01-01 compare
#    with 1979-12-31. Locally 1980-01-05, 01-31 and 02-05 came out byte-identical (coverage .bin + events), but the lab merge covers ~10x more
#    objects, so rebuild them (est. a few minutes). From 1980-01-31 on nothing reads a pre-1980 set.
nice -n 10 npx tsx scripts/history/build-range.ts --elsets $OUT/merged/elsets --objects $OUT/merged/objects.jsonl.gz --out $OUT/build \
   --from 1980-01-01 --to 1980-01-30 --workers 25 --parts coverage,changes --era-file $OUT/era-merged.json --force > $OUT/build-merged-1980.log 2>&1
grep -h FAILED $OUT/build-merged-*.log | head        # expect nothing
```
(`$OUT/era-merged.json` -> `$OUT/era-sgp.json` if step 4's optional part was skipped.) Then section 6 / 7 for 1959-1980 (`import-events.ts --from
1959-01-11 --to 1980-01-30`). The merged objects file changes only pre-1980 statistics (firstEpoch / lastEpoch / nSets) of pre-1980 objects; an
object first seen after 1979 keeps its line byte-identical. Optional: 1957-10-04 .. 1959-01-10 now has element sets (McDowell only, mostly UNK /
JCM origin, unchecked: 20 sets in the sample); building those days is possible (`--from 1957-10-04`) but their accuracy is unknown.
Cost of step 5: as section 8 (well under 1 h on 10 x 25 workers, estimate).

**Draft email to Jonathan McDowell (not sent; for the lead):**
> Subject: Bulk download of the historical TLE archive?
>
> Dear Dr McDowell,
>
> thank you for maintaining the historical element archive on planet4589.org. We are using it, with attribution, for a non-commercial
> research project that reconstructs the historical satellite catalogue day by day before 1980 (Brouwer mean motions and your cross-tag
> corrections make a large difference for 1962-1964).
>
> To avoid putting load on your server with ~11,000 individual requests, is there a bulk archive (for example one tar or zip file of the
> elements directory) that we could download instead? If not, we will fetch the files one at a time with pauses between requests; please
> tell us if you would prefer a different rate or time of day.
>
> With kind regards,
> the Orbitwatch project


## 10. Serving the history (backend)

`SSA_HISTORY_DIR` = the root with `elsets/`, `objects.jsonl.gz`, `coverage/`, `events/` (what the lab produced, section 6 layout: copy `conv/elsets`
+ `conv/objects.jsonl.gz` (or the merged ones, section 9) next to `build/coverage` and `build/events`). Unset or missing: the history API answers 503.
- `GET /api/history/range` -> first / last built day, number of days, events extent, `hasCoverage`.
- `GET /api/history/catalog?day=D` -> the catalog as of the END of D (per object the latest set before then within the era's window, the era's
  propagator `sgp4 | sgp`, `accuracy {medianKm,p95Km}` of the era, `objects[]` with the OMM set incl. MEAN_MOTION_DDOT / EPHEMERIS_TYPE). Built by
  the same `FileCatalog` + `eraFor` + `assignPropagators` as the coverage build, so its objects / sets equal the day's coverage manifest (`norad`,
  `propagators.sgp`); `Cache-Control: public, max-age=604800`, ETag, gzip. Cached per day in memory (24 days) and as `<root>/cache/catalog/<day>-<sig>.json.gz`.
- `GET /api/history/timeline?from&to&bucket=day|month|year&kinds=a,b` -> event counts per bucket from `ssa_event` (empty buckets omitted).
- Events: `/api/ssa/events` takes `kind=a,b` (dotted names), `from` + `to` (event time) besides `since`.
- Coverage fallback: `/api/ssa/passes` (and Perceptor `passedOver`) read `<root>/coverage` for days `SSA_COVERAGE_DIR` does not have and refine them with
  the element sets of `<root>/elsets` (the manifest's `propagators.sgp` picks SGP). The live directory wins. The window limit stays 90 days.
  NOTE: instants before 1970 are negative; the pass scan used `-1` / `< 0` as "no pass" and silently found nothing for 1959-1969 days (fixed:
  `coverage/scan.ts` NaN sentinel, `NO_TIME`).

### object.breakup
Derived kind (not per day): `src/ssa/history/breakup.ts` clusters the debris pieces (`objectType = debris`, designator `YYYY-NNN`, first appearance
`newly_cataloged` or `new_launch`, not `returned`) of one launch: a new cluster starts after a gap of more than 60 days, a cluster with >= 10 pieces
is a breakup. Parent = the launch's non-debris object whose tracking ended within 14 days of the cluster's first day, else the lowest NORAD id, else the
earliest piece. Row: `day` = first day, `t_start`/`t_end` = first/last piece day, `subjects` = [parent, ...pieces], payload
`{launch, parentNorad, parentName, pieces, firstDay, lastDay, names}`. Written to `events/breakups.jsonl.gz` by `build-range.ts --parts breakups` (not with
`--shard`) or `scripts/history/derive-breakups.ts --in ROOT`, or over events already in the database with `derive-breakups.ts --db --objects FILE`;
`import-events.ts` replaces the object.breakup rows of its `--from/--to` range with the file's. Limits: debris launched under another designator,
breakups with < 10 pieces, launch-time debris of busy launches (false positives), piece counts only as far as the data goes, and the first
`windowDays` of a build that starts without the preceding years (objects look new).
Perceptor fields (backend SSA provider): `breakupAt`, `breakupPieces` (on the parent), `breakupParent` (on the pieces).
