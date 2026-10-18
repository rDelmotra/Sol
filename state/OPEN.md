# OPEN — known problems and deferred work

Remove an item when it is fixed. None of these is scheduled unless the owner says so.

## Needs the owner

- Rotate the Gemini key. It was rejected as leaked, so every Ask fails.
- Rotate the key found in the history of `experiment/nl-to-ir`.
- DSO validity window: `DEFAULT_VALID_PAST_WINDOW_SEC` is 10 days. Should it be "since launch"?
- The raw history archive is never pruned and grows about 4.6 MB a day. The 500 MB volume fills in roughly 97 days, and the daily-cron fix doubles the old rate. Numbers and lossless options: `state/SRE_FINDINGS.md`, parts (a) and (b). Watch `GET /health` (`disk`) after deploy. An alert now goes out through the same channel at 75% and 90% used (D16), so the first warn alert will appear in a few days (production was about 71.5% used, 317 MB of 444 MB). The owner still has to resize the Railway volume.
- Object category is always `unknown` because Space-Track's SATCAT has no operational-status field. Needs another source.
- Dead branch cleanup. Many old branches exist.

## Planned projects (not started)

- **Takram integration.** Tiled Earth, atmosphere, clouds. Start with the depth-buffer decision and the `frames.ts` adapter.
  Known risks: logarithmic depth would force edits to all 7 custom shaders.
  The atmosphere is a screen-space effect and probably won't blend with additive satellite points, so those likely need a separate pass.
- **Perceptor and Analytic IR redesign.** See D3. Marked now by 2 known violations in `tests/architecture.test.ts`
  (`services/analytic-prompt.ts` importing `analytic`) and by the hand-kept list in `packages/analytic/src/capability.ts`.

## Cockpit port (deferred)

- **Idle frame governor: hand-test the feel.** Idle CPU and GPU were measured (about 4 times lower than before). Still to check by hand: camera damping, follow, joyride, ground view, time scrub and gamepad input never look steppy. Rules and flag: `state/STATE.md`, first milestone.
- **No unfollow trigger for the UI.** Dock ORBIT leaves a joyride via `cameraMode` 'returning' (eases home). A store trigger slot for `NavigationController.unfollow` would let it stop in place instead.
- **Place naming after landing.** `NavigationController.landWhereLooking` only sets lat/lon (and clears `observerPlaceName`). Naming the place is left to the UI.
- **No pad look on the ground.** In the dome view pad buttons work, but the right stick does not turn the gaze (the spike had no binding either).
- **Pass search runs on the main thread.** `packages/frontend/src/engine/controllers/PassPlanner.ts` runs a 24-hour `findPasses` (about a thousand SGP4 steps) on each selection, observer, vantage or 5-minute sim-time change. Move it to a worker.

## Left over from the cockpit swap (D8)

The dead-code pass after the swap removed the old keyword query engine, `fuse.js`, the metadata client, the hover pick, the cluster popup state, and the store keys only the old overlay used. What remains below is kept on purpose or needs an owner decision.

- **Kept for later UI:** `selectedDso`, `triggerFlyToDso`, `triggerJoyrideDso` and the rest of the DSO machinery (a DSO panel will need them). `historyLoading` and `planetarium` (the time console cue reads them).
- `historyDay` in `packages/frontend/src/store/historySlice.ts` is written but not read outside the store.
- `packages/frontend/src/store/filterSlice.ts`: engine still reads, UI can no longer set. The filter fields (`typeFilters`, `statusFilters`, `sectorFilters`, `purposeFilters`, `regimeFilters`, `countryFilter`, `programFilter`, `launchFilter`, `ownerFilter`) and `colorBy` are read by `packages/frontend/src/engine/world/layers/SatellitesLayer.ts` and `packages/frontend/src/engine/SatelliteRenderer.ts`, so they stay. Nothing in the cockpit calls their toggles or `setCountryFilter` today; a Lens or country-spotlight surface would. `colorBy` has no setter, so it stays `'type'`.
- `packages/frontend/src/engine/SatelliteRenderer.ts`: still counts visible objects per regime and facet on every filter pass and every position update, then drops the result. The store copy of these counts was removed because nothing read it. The counting loop was left alone to keep rendering code untouched.
- **Clicking a crowded satellite selects nothing.** In `packages/frontend/src/engine/input/InputManager.ts` a click selects only an isolated object. If another visible object is within about 50 km of the hit, the old ClusterPopup opened; it is gone, so now nothing happens. Needs a decision: select the biggest, the nearest, or cycle like the gamepad reticle. Pinned by `packages/frontend/src/engine/input/InputManager.test.ts`.
- **No pointer cursor over satellites.** The hover pick (a GPU pick pass and pixel read-back on pointer move, at most 10 per second) fed only the deleted tooltip and the cursor style, so it was removed. If the hand cursor is wanted back, do it from a cheaper source than a GPU read-back.
- **Launch/owner vocabulary is never installed.** `ensureQueryVocab` in `packages/frontend/src/query/vocab.ts` had one caller, SearchBar, which is gone. So `getRawQueryVocab()` (read by `packages/frontend/src/engine/Engine.ts` for the live analytic source) is always null in the app. Client-run Ask programs that read `launch.family`, `launch.site` or `owner.name` get null for every object. Fix: call `ensureQueryVocab()` once at boot. Not done in the cleanup because it adds a network fetch.

## Ops gaps found by the SRE pass (details in `state/SRE_FINDINGS.md`)

- **A hung history migration would delay the TLE updater at boot.** The `history-init` step in `packages/backend/src/boot.ts` is awaited before `tle-freshness`, which schedules the cron. The DB pool has a 10 s connect timeout, but the migration queries have no statement timeout. Only the disk report was made fire-and-forget.
- **Catalog staleness alerts are partial.** A refused catalog counts as a Space-Track failure, so the day's 5th failed attempt sends one alert (`packages/backend/src/utils/alert.ts`, to ntfy). Nothing else warns about a stale catalog: watch `lastUpdate` in `GET /health`. If the real catalog ever shrinks by more than half on purpose, set `CATALOG_MIN_RATIO` lower, then unset it.
- **An ended DSO still says `fresh` in the manifest and catalog.** `GET /health` reports it as `dsoEndedCount`, but the per-object `freshnessState` comes from the shared `DsoFreshnessState` type in `packages/contracts/src/dso.ts`, which has no `ended` value. Adding one is a contract change (frontend included), so it was not done.
- The NL compiler cache and gap log live in `<backend>/data`, not on the volume. The gap log has no rotation.
- Unpruned `.tmp` files from a crashed write (cache, raw archive) stay on the volume.
- **Only the newest DSO snapshot is served, and older versions are deleted (decision 2026-10-15: correct, continuous data matters, not old data).** Readers use only the snapshot the manifest points to, so a newer snapshot replaces the older values for the same times. After a publish the manifest is updated first; only then does the worker delete older snapshot files in `<CACHE_DIR>/dso/snapshots/<id>/`, keeping the newest 3 (and the one the manifest names). A delete that fails is logged and retried on the next publish; it never fails the publish. Code: `packages/backend/src/dso/snapshot/store.ts`. The size stays bounded at about 3 files per object, about 0.6 MB per Artemis II (estimate).
- The gzip copy of `/api/tle/all` is still built with the sync `gzipSync` (about 0.5 s on the fake catalog), at boot and after each daily fetch. The brotli copy is async. `/api/history/at` builds its day snapshots with the same sync gzip and has no brotli yet.
- A missing `/assets/...` file falls through to the SPA fallback and returns `index.html` with status 200. A tab left open across a deploy that lazy-loads a removed chunk gets HTML instead of a clean 404.

## Later, not pressing (noted 2026-10-18 so nothing is forgotten)

None of these is a problem today. The owner decided the work is finished for now.

**Goal for the future (owner direction, 2026-10-18):** a minimal, hyper-realistic space view, not a cockpit. Sun-lit silvery satellites, a Moon, a Sun disc, real stars, 3D clouds, Takram atmosphere, map tiles. Suggested order: fix the colour and tone-mapping path, GPU sun-lit satellites, Sun disc with bloom, Moon, real stars, Takram, tiles. The scene is built from layers, so each piece has a place to plug in (Earth layer, satellite shaders, a new Moon layer next to the stars layer, the renderer's post-processing slot). No Moon, no Sun disc and no lighting on satellites exist today.

**Decisions for the owner:**
- **The Ask / analytic stack** (about 14,000 lines, the `analytic` package, backend compiler and query route, the Ask bar). The Gemini key was rejected, so it does not work. Remove it or keep it dormant.
- **Other deep-space missions.** JWST, DSCOVR, LRO and Chandrayaan-3 are off in `packages/backend/src/dso/registry/entries.ts`. A mission with a long life is a long list of points (JWST at 10-minute steps is about 250,000 points, about 12 MB). If they are switched on later, use hourly steps and check the volume first. Chandrayaan-3 waits for confirmed NASA coverage. `packages/backend/src/dso/NOTES.md` still lists three of them as enabled, which is out of date.
- **An alert if the process dies in the middle of the day's 5th attempt.** The daily alert is sent when the 5th failure is recorded, so a crash during that attempt sends nothing that day (the next day's cycle starts a new count). A "dead man" check from outside would be needed to cover this.
- **More cockpit decoration still in place** that a minimal view would not need: the reticle ring (`packages/frontend/src/ui/cockpit/hud/Reticle.tsx`), the edge arcs (`packages/frontend/src/ui/cockpit/hud/EdgeArc.tsx`), the ring of facts (`packages/frontend/src/ui/cockpit/hud/ObjectDisc.tsx`), the voice-wave bar (`packages/frontend/src/ui/cockpit/hud/Waveform.tsx`), the glass panes (`packages/frontend/src/ui/cockpit/primitives/GlassPane.tsx`), the dock (`packages/frontend/src/ui/cockpit/dock/Dock.tsx`), the gamepad drawing, and the "MODE" and "TRACKING n OBJ" lines (`packages/frontend/src/ui/cockpit/time/ConsoleReadouts.tsx`). The orbit diagram stays by decision. The cockpit panes have no deep-space info card, which is fine for now.

**Safe cleanup, found by the audit, not done:**
- Server routes the website never calls: metadata, launch, org and decayed (`packages/backend/src/routes/metadata.ts`) with their data files in `packages/backend/enrichment-data/` (`decayed-catalog.json` 4.6 MB, `launches.json` 2.0 MB, `orgs.json` 420 KB).
- The query vocabulary chain: `packages/backend/enrichment-data/query-vocab.json` (368 KB) plus its route and client.
- A 0-byte `packages/frontend/public/favicon.svg`, the unused dev dependency `@rollup/pluginutils`, and 26 MB of master images in `packages/frontend/texture-src` (never shipped, only used by the texture script).

**Unverified in the real world:**
- The CelesTrak fallback has never run against the real CelesTrak. It lays `GROUP=active` over the saved catalog by newer epoch and takes only the orbit from a newer record, keeping the cached type, country, launch date and size (`packages/backend/src/cache/catalog-overlay.ts`, `packages/backend/src/cron/tle-updater.ts`, D16). The tests use fixtures with the 17 keys CelesTrak is documented to send; the real answer was not fetched. The computed period and apsides were checked against Space-Track's own definition only on an ISS-like fixture. An id that CelesTrak has and the cache does not is added with type, country and size unknown until the next Space-Track fetch. If Space-Track ever fails, read the first fallback in the logs.
- The new alerts (write failure, volume, and the daily Space-Track one) go through the existing `sendAlert`; the delivery to ntfy was not seen end to end in production. Set `ALERT_WEBHOOK_URL` with `ALERT_WEBHOOK_FORMAT=ntfy` and watch for the first volume warn.
- Heat and idle power after the turning orbit arc, the blur removal and the scanline removal were not measured in the owner's Chrome.

**Performance notes:**
- First load is limited by the satellite list: about 2.3 MB with brotli, close to the floor for JSON. A binary format could get it near 1.3 MB, but it is a large rewrite. Repeat visits use the copy stored in the browser.
- Railway's edge ignores `Vary`, so `/api/tle/all` is marked `private` (`packages/backend/src/routes/tle.ts`). Do not turn it back to `public` without checking.
- The volume is about 71% full and grows about 4.6 MB a day. The owner resizes it. `GET /health` shows `disk`; alerts at 75% and 90% are wired through `sendAlert` (D16).
- Harmless warning at every boot: the TimescaleDB extension is not available, so the history table is a plain Postgres table.

## Known weaknesses (left alone by decision D2)

- **Filter fan-out.** Adding one filter group touches about 18 files. It needs a facet registry.
- **Engine reads the store directly** about 95 times across 15 files.
- **Test blind spots.** The architecture test has no rules for the catch-all `engine` zone, and cannot see `new URL()` worker edges.
- **Untested critical code.** `World.ts`, `SatelliteRenderer.applyVisibilityAndFilters`, `routes/tle.ts` (only `/all` is tested), cron, history, the Rust crate.
- **Large files.** SatelliteRenderer 517, SatellitesLayer about 510,
  and in the Perceptor area `execute` 950, `validate` 676, `analytic-prompt` 623, `compiler` 565.
- **Duplicated physics in DSO convert.** `packages/backend/src/dso/normalize/convert.ts` has its own Julian date and precession/nutation.
- **Duplicated constants.** `MS_PER_DAY` in `packages/analytic/src/validate.ts` and `packages/backend/src/routes/query.ts`.
  `MS_PER_YEAR` in `packages/backend/src/analytic/providers/catalog.ts` and `packages/frontend/src/query/analytic/live-source.ts`.
- **`VITE_API_URL`** is read in 7 places.
- **Type-level import cycles.** `data/facets.ts` and `data/types.ts`. `history/archive/raw-writer.ts` and `history/ingest/sink.ts`.
- **Mutable module singletons**, for example `packages/frontend/src/data/dso-client.ts`.
- **No CI, no linter.** README is 16 lines.
- **Two propagation engines** differ slightly. See STATE.md.
- **Globe is a unit sphere.** See STATE.md.
