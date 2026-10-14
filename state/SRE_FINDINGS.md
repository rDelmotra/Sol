# SRE findings — disk, shrinking, upstream politeness, Artemis II

Written 2026-10-13 from the code and from local measurements only.
Nothing here was checked against Railway or the live site.
Update 2026-10-14: the Space-Track attempt log (part c) and the Artemis II ended-mission fix (part d) are now implemented on `sre/hardening`. See `state/STATE.md`.
No data was deleted or changed. These are findings and proposals, not changes.

## How the numbers were made

- Known real numbers, from prod logs: cache file 25.7 MB per day, raw archive 4.6 MB gz per day, about 32,000 objects.
- For the shrink tests I built a fake catalog of 32,000 records in the Space-Track `gp` JSON shape (about 40 string fields, three TLE strings each).
  It is fake data. The generator is not committed.
- Calibration against the real numbers: fake cache file 23.7 MB (real 25.7 MB), fake raw archive 5.5 MB gz (real 4.6 MB).
  So the fake data is a bit less compressible than the real data.
  Trust the percentages more than the megabytes.
- To check on the real file, the owner can run this on one raw archive file. It only reads.
  `node -e "const z=require('zlib'),fs=require('fs'),c=z.constants;const b=z.gunzipSync(fs.readFileSync(process.argv[1]));console.log('raw',b.length,'gz9',z.gzipSync(b,{level:9}).length,'br9',z.brotliCompressSync(b,{params:{[c.BROTLI_PARAM_QUALITY]:9,[c.BROTLI_PARAM_LGWIN]:24}}).length)" FILE.json.gz`

## (a) What the backend writes, and how big it gets

Everything below is under `CACHE_DIR` (the 500 MB volume) unless noted.

| File | Written by | Size | Growth |
|---|---|---|---|
| `tle-cache.json` | `writeCache` in `packages/backend/src/cache/file-cache.ts` | 25.7 MB | None. Overwritten daily. |
| `tle-cache.json.tmp` | same function, during the write | 25.7 MB | Exists for a moment. Peak is 2x (about 51 MB). A crash mid-write leaves it until the next write. |
| `version.json` | same | under 1 KB | None. |
| `visual-cache.json` | `writeVisualCache`, same file | tens of KB (id list) | None. Rewritten at most every 8 h, on demand. |
| `swpc-cache.json` | `packages/backend/src/cache/swpc-cache.ts` | a few KB | None. Rewritten at most every 12 h. |
| `gazetteer-cache.json` | `packages/backend/src/cache/gazetteer-cache.ts` | about 1 to 2 MB (estimate, about 7.3k places) | None. Rewritten every 30 days. |
| `dso/catalog.json`, `dso/manifest.json` | `packages/backend/src/dso/snapshot/store.ts` | a few KB each | None. But both are rewritten on every worker loop, even when nothing changed. |
| `dso/snapshots/<id>/<version>.json` | `publishDsoSnapshot` in the same file | about 0.2 MB per Artemis II file (estimate: about 1,300 samples at about 150 bytes) | Live folder is bounded at the newest 3 per object. Older files are moved to `archive/` next to them and never deleted (about 0.8 MB a day per live object at the 6 hour refresh, estimate). |
| `history/raw/YYYY-MM-DD.json.gz` | `writeRawArchive` in `packages/backend/src/history/archive/raw-writer.ts` | 4.6 MB | **+4.6 MB per day. Nothing ever prunes it.** |

Not on the volume:

- The NL compiler cache and gap log go to `<backend>/data`, not `CACHE_DIR`.
  `backendDataDir()` ignores `CACHE_DIR` on purpose (`packages/backend/src/utils/paths.ts`).
  They are `compile-cache.json` and `gap-log.jsonl` (`packages/backend/src/services/analytic-compiler.ts`).
  On Railway that is the container disk, wiped on every deploy. The gap log is append only with no rotation.
- The history database is Postgres (`DATABASE_URL`). It has its own storage and its own growth.

### When the volume fills

- Steady files plus the write peak: about 26 + 26 + 3 = 55 MB.
- Archive growth: 4.6 MB per day, so about 138 MB per month and about 1.7 GB per year.
- Room left for the archive: about 445 MB. At 4.6 MB per day that is about 97 days from an empty archive.
- The cron bug (fixed in this branch) skipped every other day, so the archive grew about 2.3 MB per day on average.
  **The fix doubles the growth rate.** Once deployed, the time to full halves.
- Check the real number after deploy: `GET /health` now returns a `disk` block, and the log warns at 75% and errors at 90%.
- At 100%, `writeCache` throws on the `.tmp` write. The cron logs `Cron cycle error` and the stale cache keeps serving.
  The raw archive write is non-fatal. The DSO worker would fail its atomic writes.

### What is redundant (no deletion proposed)

1. `tle-cache.json` is a derived copy. The same elements are in the latest raw archive file, joined with the static enrichment data.
   It is the serving copy, so it must stay. It is stored as plain text.
2. Raw archive days repeat each other. In the fake data about 12% of objects have no new element set on a given day.
   Names, IDs, launch dates, sites and key names repeat every day. Only the orbital numbers change.
   Separate daily gzip files cannot exploit that.
3. Each raw record holds `TLE_LINE0/1/2`, which restate the numeric fields.
   In the fake data they are 17% of the uncompressed bytes. They are provider-supplied text, so dropping them is not lossless.
4. Each object in `tle-cache.json` repeats `name`, `inclination` and `epoch` at the top level and again inside `omm`.
   Clients read both, so this is a wire-format question, not a free win.
5. `dso/catalog.json` is derived from `dso/manifest.json` plus the registry. It is tiny.
6. Older DSO snapshot generations overlap. They exist for rollback.
7. The history database's daily checkpoint is derived from the raw archive by design.
   The raw archive is the source of truth. The database can be rebuilt from it.
8. `.tmp` files from a crashed write are never cleaned, except for DSO snapshots. Each is at most 25.7 MB (cache) or 4.6 MB (archive day).

## (b) Lossless ways to slow the growth

Measured on the fake 32,000-record day. Percent is size compared with today's gzip level 9.
Sizes in MB are for the fake data. Scale by about 0.85 for the real file.
Rows marked "30k run" come from an earlier 30,000-record run of the same generator.

| Option | Size | vs today | Compress time | Notes |
|---|---|---|---|---|
| Today: gzip level 9, sync | 5.53 | 100% | 1.2 s | Blocks the event loop for that second. |
| Brotli quality 9 | 5.00 | 90% | 1.7 s | Almost free. |
| Brotli quality 10 | 4.23 | 76% | 17 s | Use the async `zlib.brotliCompress`, not the sync call. |
| Brotli quality 11 (30k run) | 3.73 vs 5.18 | 72% | about 40 s | Async only. |
| Columnar layout (key names written once), then gzip 9 (30k run) | 4.54 vs 5.18 | 88% | 1.5 s | Raw JSON halves, 32.4 to 16.6 MB. Lossless if every record has the same keys. The CelesTrak fallback has different keys. |
| Columnar, then brotli 11 (30k run) | 3.46 vs 5.18 | 67% | 22 s | |
| Zstd level 19 (30k run) | 4.00 vs 5.18 | 77% | 12 s | Needs Node 22.15 or newer. `engines` says 20 or newer. Check the Railway Node version first. |
| One solid stream for 3 days (zstd, long window) (30k run) | 8.4 vs 15.6 | 54% | 12 s | Day 2 costs 2.2 MB inside the stream vs 5.2 MB as its own file. Depends on my fake day-to-day drift, so the least certain row. |

Plain reading:

- Easy win: write `.json.br` with brotli quality 9 to 10 in the async API. Expect 10% to 24% less. Real: about 4.6 MB to about 3.5 MB per day.
  Readers (the Phase 2 backfill) must accept both `.json.gz` and `.json.br`.
- Bigger win, more work: pack days into weekly or monthly solid files so day-to-day repeats are removed.
  Possible total near 2 MB per day. That would stretch the 97 days to about 220 days.
  Cost: reading one day means decoding from the start of its chunk, unless there are periodic restart points.
- Biggest headroom win for the least risk: store `tle-cache.json` compressed. It is the one big constant.
  Fake data: 23.7 MB plain, 3.5 MB gzip 9, 3.1 MB brotli 9.
  That frees about 22 MB and cuts the write peak from about 51 MB to about 7 MB.
  It does not slow growth. The server would unzip at boot, which is cheap.
- One cache file vs per-version: the TLE cache already is one overwritten file. Only DSO snapshots keep versions (3 each, already bounded).
  Per-version TLE files would add 25.7 MB a day, so do not.
- None of this frees space already used. Old `.json.gz` files stay as they are.

## (c) Every Space-Track fetch, and the rules in force

Space-Track is contacted from exactly one place: `fetchFromSpaceTrack` in `packages/backend/src/services/spacetrack.ts`.
Its only caller is `runUpdateCycle` in `packages/backend/src/cron/tle-updater.ts`. No HTTP route can trigger it. The DSO worker never calls it.

When it runs:

1. At boot, only if `tle-cache.json` is missing or older than 24 h. Decided in `packages/backend/src/boot.ts`, then checked again inside `runUpdateCycle` with trigger `boot`.
2. Daily at 02:00 UTC from node-cron, trigger `cron`. Skipped only if the cache is under 1 hour old (`CRON_MIN_AGE_MS`). This was the bug fix: the old 24 h guard skipped every other day.

Rules in force:

- One login, then pages of 25,000 rows, then one logout. About 4 requests per cycle for 32,000 objects (login, 2 pages, logout).
- Logout runs in a `finally` block, so a session is never left open.
- The query is one narrow `gp` class query: not decayed, epoch within 30 days, ordered by NORAD id. It does not use `gp_history` or SATCAT.
- No retry against Space-Track inside a cycle. Any failure goes straight to the CelesTrak fallback.
- 120 s timeout per request.
- Boot guard 24 h, cron guard 1 h. A normal restart loop with a good cache cannot refetch.
- The code comment says Space-Track allows about 30 requests a day and the cycle stays under that.
  I did not verify Space-Track's current published limits (I believe they are per minute and per hour). Please check their API use guidelines.

Gaps (proposals only):

- **No record of failed attempts.** If both Space-Track and CelesTrak fail, nothing is written, so the next boot tries Space-Track again.
  A crash loop with no cache would log in on every restart. The new supervisor delays its exit by 5 s only when a child dies in under 10 s.
  Proposal: write a small `last-attempt` stamp in `CACHE_DIR` and refuse a new Space-Track login within, say, 1 hour of the last one, whatever the outcome.
- Two API replicas would each run the cron and each fetch. Today there is one.

Other upstream fetches, for completeness:

| Upstream | Where | Rules |
|---|---|---|
| CelesTrak fallback (`last-30-days`) | `packages/backend/src/services/celestrak.ts` | Only when Space-Track fails. 3 tries, 5 s apart, 30 s timeout. |
| CelesTrak visual list | `packages/backend/src/services/celestrak-visual.ts`, called from `packages/backend/src/routes/tle.ts` | On a user request when the cache is over 8 h old. One refresh at a time. 3 tries, 2 s apart. **No negative cache:** while CelesTrak is down, every request starts another 3-try fetch. The `/api` limit of 100 requests per 15 min per IP is the only brake. |
| NOAA space weather | `packages/backend/src/services/swpc.ts` | Cache 12 h. One refresh at a time. 3 tries per file, 2 s apart. |
| Natural Earth gazetteer (GitHub) | `packages/backend/src/services/gazetteer.ts` | Cache 30 days. 3 tries, 3 s apart, 90 s timeout. |
| JPL Horizons | `packages/backend/src/dso/providers/horizons.ts` | Requests are serialized one at a time. 30 s timeout. See (d). |

## (d) Artemis II error spam

What the code does today (from `packages/backend/src/dso/` and its tests; I have not seen the prod log lines):

1. Artemis II is the only enabled DSO. Its entry in `packages/backend/src/dso/registry/entries.ts` has launch date 2026-04-01.
2. The fetch window starts at the launch date and ends at now + 6 h. `DEFAULT_VALID_PAST_WINDOW_SEC` is really 1000 days, so the launch date always wins (`computeWindow` in `packages/backend/src/dso/worker/index.ts`).
3. Horizons has no ephemeris after the mission ended. The test fixtures in `packages/backend/tests/dso/providers/horizons.test.ts` show coverage from 2026-04-02 to 2026-04-10.
   Today is 2026-10-13, so the end of the window is about six months past the data.
4. Horizons answers with "No ephemeris for target ... prior to ..." or "... after ...". `packages/backend/src/dso/providers/horizons-coverage.ts` reads that and retries once with a clamped window.
   The first error gives only one bound. The single retry fixes that bound, then fails on the other one. There is no third try.
5. So each cycle makes 2 Horizons requests, both fail, and the failure is recorded.
6. With no snapshot on disk, `packages/backend/src/dso/worker/retry-policy.ts` backs off 1, 2, 4, 8, 16 minutes and then caps at 30 minutes, forever.
   That matches "fails every 30 minutes" in `state/OPEN.md`: 48 cycles a day, 96 Horizons requests a day, about 4 log lines per cycle, 2 of them at WARN or ERROR.
7. If an old snapshot exists, the backoff does not apply. The loop sleeps about 6 h and still fails each time.

Proposal (not implemented):

1. Add an optional end date to the registry entry, for example `ephemerisEndsAt`. Set it for Artemis II from the Horizons coverage end.
   Clamp the window end to it in `computeWindow`.
   One fetch then succeeds and publishes the full historical track.
2. Once a snapshot covers the end date, `shouldRefreshDsoEntry` returns false for that object. The worker stops asking. Also leave finished objects out of the loop-delay calculation.
3. Safety net for objects without an end date: let the clamp retry run until both bounds are applied (up to 2 retries).
   If the parsed upper bound is more than a day in the past, remember it in the manifest and treat the mission as finished.
   That needs one new optional field on the shared `DsoObjectStatus` type in `packages/contracts/src/dso.ts`.
4. Use a long cap (6 to 24 h) for "no ephemeris" style errors instead of 30 minutes. They do not heal by waiting a few minutes.
5. Log the first failure at ERROR and repeats of the same message once per hour with a count, not every cycle.
6. Stopgap with no code: set `enabled: false` for Artemis II. That is the "disable it or fix it" question in `state/OPEN.md`.
   It stops the requests and the log lines. The frontend then has no Artemis track unless a snapshot already exists on the volume.
7. Add cases to `packages/backend/tests/dso/worker/retry-policy.test.ts` for the finished-mission path.
