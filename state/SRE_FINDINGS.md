# SRE findings — disk, shrinking, upstream politeness, Artemis II

Written 2026-10-13 from the code and from local measurements only.
Nothing here was checked against Railway or the live site.
Update 2026-10-14: the Space-Track attempt log (part c) and the Artemis II ended-mission fix (part d) are implemented on `sre/hardening`. A second review pass added: the catalog size guard, the retry timer, the DSO snapshot housekeeping guard, the boot disk report guard, and the weekly re-check of ended missions. Resolved findings were removed from this file; how each fix behaves is in `state/STATE.md` and in parts (c) and (d) below.
Parts (a) and (b) are still findings and proposals. No data was deleted or changed by this report.

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
| `dso/snapshots/<id>/<version>.json` | `publishDsoSnapshot` in the same file | about 0.2 MB per Artemis II file (estimate: about 1,300 samples at about 150 bytes) | Bounded. Only the newest snapshot is served and it replaces older values for the same times. The code keeps the newest 3 per object and deletes older ones, after the manifest points at the new one. |
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
6. Older DSO snapshot generations overlap. Only the newest is served and it replaces older values for the same times, so the older versions (beyond the newest 3 kept) are deleted. Owner decision 2026-10-15: no old data kept, only correct, continuous data.
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
- No retry against Space-Track inside a cycle. Any failure goes straight to the CelesTrak fallback (an overlay, see below).
- 120 s timeout per request.
- Boot guard 24 h, cron guard 1 h. A normal restart loop with a good cache cannot refetch.
- The code comment says Space-Track allows about 30 requests a day and the cycle stays under that.
  I did not verify Space-Track's current published limits (I believe they are per minute and per hour). Please check their API use guidelines.
- **Attempt log** (`packages/backend/src/cache/attempt-log.ts`, file `spacetrack-attempts.json` in `CACHE_DIR`). After a failure the next login waits 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h. After a success it waits 1 h. A restart does not reset the wait. A refused catalog (next bullet) counts as a failure.
- **Size guard** (`assessCatalog` in `packages/backend/src/cache/file-cache.ts`, used by `runUpdateCycle`). Space-Track can answer `200 []`, or a page list can be cut short, and the cycle used to write that over the good cache. Now a catalog with 0 objects, or with fewer than 50% of the cached object count, is refused. This applies to Space-Track and to CelesTrak.
  A refused Space-Track answer is logged at ERROR with the counts, recorded as a Space-Track failure, and the cycle falls through to CelesTrak.
  If CelesTrak is refused or fails too, the cycle returns at once. It does not touch `tle-cache.json`, `version.json`, the payload cache or the history database, and it logs a WARN that the stale cache keeps serving.
  With no cache (first boot, or dev with only CelesTrak) any non-empty catalog is accepted.
  Knob: `CATALOG_MIN_RATIO`, a number from 0 to 1, default 0.5. Use a lower value only if the real catalog shrank by more than half on purpose, then unset it. 0 turns the size check off. An empty catalog is always refused.
- **Retry timer.** When a cycle writes nothing and Space-Track is only waiting out its backoff, one unref'd timer is armed for the moment the wait ends. It runs the cycle again with the `cron` trigger, so it does not wait for the next 02:00. At most one timer is pending. A successful write cancels it, and so does the `stop()` handle that `scheduleTLEUpdater` returns. If the attempt log cannot be written the gate stays open and no timer is armed, so there is no hot loop.
- **Daily cap and alert** (D14). At most 5 Space-Track logins per UTC day, counted in the attempt log (boot, cron and retry-timer attempts, success or failure). At the cap the gate stays shut until 00:00 UTC. The 02:00 cron of a new day is never blocked by it. When the 5th attempt fails and none succeeded that day, one alert is sent (`packages/backend/src/utils/alert.ts`; ERROR log line, optional webhook, optional Resend email; details in `packages/backend/.env.example`).
- **Finding: `GROUP=last-30-days` was never the full catalog.** CelesTrak's `last-30-days` group is only the objects launched in the last 30 days (hundreds of objects). The old comment in `celestrak.ts` called it the full catalog (about 22,000 objects), and the code treated its answer as a replacement for the cache. No CelesTrak group is the full catalog (`GROUP=active` is about 16.7k active satellites). The fallback was never used in production, so nothing was lost, but it would have replaced a 32k cache with a few hundred objects (the size guard would have refused it, correctly). Fixed: the fallback now asks for `GROUP=active` in JSON and lays it over the cached catalog by newer epoch (`packages/backend/src/cache/catalog-overlay.ts`).
- **CelesTrak calling rules** (its usage policy): data changes every 2 hours, asking for the same group sooner is answered with HTTP 403, and repeating after a 403 or 404 can get the IP firewalled (limit 50 such errors in 2 hours). Now no 4xx is retried, and every download is gated to once per 2 hours per group in `celestrak-attempts.json` (`packages/backend/src/cache/celestrak-attempts.ts`), the visual list included.

Open gaps:

- During a multi-day Space-Track outage the backoff reaches 6 h, so a later day fits only 4 attempts and never reaches the cap: the alert fires on the first bad day, not on every day.
- Two API replicas would each run the cron and each fetch. Today there is one.

Other upstream fetches, for completeness:

| Upstream | Where | Rules |
|---|---|---|
| CelesTrak fallback (`active`, overlay) | `packages/backend/src/services/celestrak.ts` | Only when Space-Track fails or is held back. Once per 2 hours (persisted gate). 3 tries 5 s apart for timeouts, network errors and 5xx only; a 4xx stops at once. 30 s timeout. |
| CelesTrak visual list | `packages/backend/src/services/celestrak-visual.ts`, called from `packages/backend/src/routes/tle.ts` | On a user request when the cache is over 8 h old. One refresh at a time. Same rules as above: once per 2 hours per group (this also acts as the negative cache while CelesTrak is down; the stale list is served), no retry on a 4xx, 3 tries 2 s apart otherwise. |
| NOAA space weather | `packages/backend/src/services/swpc.ts` | Cache 12 h. One refresh at a time. 3 tries per file, 2 s apart. |
| Natural Earth gazetteer (GitHub) | `packages/backend/src/services/gazetteer.ts` | Cache 30 days. 3 tries, 3 s apart, 90 s timeout. |
| JPL Horizons | `packages/backend/src/dso/providers/horizons.ts` | Requests are serialized one at a time. 30 s timeout. See (d). |

## (d) Artemis II error spam (resolved)

The cause was that the fetch window runs from the launch date to now + 6 h, but Horizons has data only for the mission itself (2026-04-02 to 2026-04-10 in the test fixtures).
Horizons names only one bad bound per error and the old code retried once, so every cycle failed. With no usable snapshot that meant a retry every 30 minutes and about 96 requests a day.

How it works now (`packages/backend/src/dso/providers/horizons.ts`, `packages/backend/src/dso/providers/horizons-coverage.ts`, `packages/backend/src/dso/worker/ended-state.ts`, `packages/backend/src/dso/worker/index.ts`):

- The window is clamped at both ends. At most 3 requests per refresh.
- Data that stopped more than 24 h ago counts as ended. Every check uses the same grace (`EPHEMERIS_ENDED_GRACE_MS`), including `planCoverageRetry`.
- An ended object is saved in `dso/ended.json` under `CACHE_DIR` with `endedAt`, `markedAt` and `lastCheckedAt`. The worker stops asking and keeps serving the stored ephemeris.
- About once a week (`DSO_ENDED_RECHECK_MS`, 7 days, a constant) the worker asks again, in case Horizons published more data. New data clears the flag. A re-check that fails for an ordinary reason is logged at WARN and changes nothing in the manifest.
- `DSO_RETRY_ENDED=1` forces one try per ended object per boot. Unset it afterwards.
- `GET /health` counts an ended object that still has its ephemeris as `dsoEndedCount`, not as fresh. The per-object `freshnessState` in the manifest and catalog is left as the last publish set it, because the shared type has no `ended` value. See `state/OPEN.md`.
- The current stored ephemeris is never deleted. Only superseded older snapshot versions are deleted (part a).

## Edge cache served gzip to brotli clients (2026-10-18)
Seen live: `/api/tle/all` came back `content-encoding: gzip`, `x-cache: HIT`, `age: 475` although brotli was built (2.32 MB against 3.04 MB gzip) and the client asked for it. Railway's edge stored the gzip copy right after the restart, ignores `Vary`, and kept serving it. Fix: `Cache-Control: private, max-age=3600` on `/api/tle/all` (browsers still cache it). With a cache-busting URL the origin did serve brotli (2.43 MB on the wire). Check after deploy: `curl -sI -H "Accept-Encoding: br" .../api/tle/all` must show `content-encoding: br` and no `x-cache: HIT`.
