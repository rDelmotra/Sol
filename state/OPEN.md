# OPEN — known problems and deferred work

Remove an item when it is fixed. None of these is scheduled unless the owner says so.

## Needs the owner

- Change the Railway start command to `node packages/backend/dist/supervisor.js` when ready. It replaces `sh -c "node packages/backend/dist/index.js & node packages/backend/dist/dso-worker.js & wait"`. The supervisor restarts the container if either the API or the DSO worker dies. (`npm run start:prod -w @orbitwatch/backend` runs the same file.)
- Rotate the Gemini key. It was rejected as leaked, so every Ask fails.
- Rotate the key found in the history of `experiment/nl-to-ir`.
- DSO validity window: `DEFAULT_VALID_PAST_WINDOW_SEC` is 10 days. Should it be "since launch"?
- The raw history archive is never pruned and grows about 4.6 MB a day. The 500 MB volume fills in roughly 97 days, and the daily-cron fix doubles the old rate. Numbers and lossless options: `state/SRE_FINDINGS.md`, parts (a) and (b). Watch `GET /health` (`disk`) after deploy.
- Object category is always `unknown` because Space-Track's SATCAT has no operational-status field. Needs another source.
- Dead branch cleanup. Many old branches exist.

## Planned projects (not started)

- **Takram integration.** Tiled Earth, atmosphere, clouds. Start with the depth-buffer decision and the `frames.ts` adapter.
  Known risks: logarithmic depth would force edits to all 7 custom shaders.
  The atmosphere is a screen-space effect and probably won't blend with additive satellite points, so those likely need a separate pass.
- **Perceptor and Analytic IR redesign.** See D3. Marked now by 2 known violations in `tests/architecture.test.ts`
  (`services/analytic-prompt.ts` importing `analytic`) and by the hand-kept list in `packages/analytic/src/capability.ts`.

## Cockpit port (deferred)

- **Idle frame governor needs a browser check.** Measure Chrome CPU and GPU with an idle cockpit, with and without `?perf=full`. Check that camera damping, follow, joyride, ground view, time scrub, and gamepad input never look steppy. Rules and flag: `state/STATE.md`, first milestone.
- **No unfollow trigger for the UI.** Dock ORBIT leaves a joyride via `cameraMode` 'returning' (eases home). A store trigger slot for `NavigationController.unfollow` would let it stop in place instead.
- **Place naming after landing.** `NavigationController.landWhereLooking` only sets lat/lon (and clears `observerPlaceName`). Naming the place is left to the UI.
- **No pad look on the ground.** In the dome view pad buttons work, but the right stick does not turn the gaze (the spike had no binding either).
- **Pass search runs on the main thread.** `packages/frontend/src/engine/controllers/PassPlanner.ts` runs a 24-hour `findPasses` (about a thousand SGP4 steps) on each selection, observer, vantage or 5-minute sim-time change. Move it to a worker.

## Dead after the cockpit swap (D8) — remove in a follow-up

The old overlay is deleted. These have no reader left in the UI. Check each before removing.

- `packages/frontend/src/store/filterSlice.ts`: engine still reads, UI can no longer set. The filter fields (`typeFilters`, `statusFilters`, `sectorFilters`, `purposeFilters`, `regimeFilters`, `countryFilter`, `programFilter`, `launchFilter`, `ownerFilter`) and `colorBy` are read by `packages/frontend/src/engine/world/layers/SatellitesLayer.ts` and `packages/frontend/src/engine/SatelliteRenderer.ts`, so they stay. Nothing in the cockpit calls their toggles or `setCountryFilter` today; a Lens or country-spotlight surface would. `colorBy` has no setter, so it stays `'type'`.
- `packages/frontend/src/engine/SatelliteRenderer.ts`: still counts visible objects per regime and facet on every filter pass and every position update, then drops the result. The store copy of these counts was removed because nothing read it. The counting loop was left alone to keep rendering code untouched.
- `packages/frontend/src/store/types.ts`: hover state (`hoveredName`) and cluster state (`clusterItems`, `clusterScreenX`, `clusterScreenY`, `setCluster`, `clearCluster`). Tooltip and ClusterPopup read them. The engine may still write them.
- **Launch/owner vocabulary is never installed.** `ensureQueryVocab` in `packages/frontend/src/query/vocab.ts` had one caller, SearchBar, which is gone. So `getRawQueryVocab()` (read by `packages/frontend/src/engine/Engine.ts` for the live analytic source) is always null in the app. Client-run Ask programs that read `launch.family`, `launch.site` or `owner.name` get null for every object. Fix: call `ensureQueryVocab()` once at boot. Not done in the cleanup because it adds a network fetch.

## Ops gaps found by the SRE pass (details in `state/SRE_FINDINGS.md`)

- The CelesTrak fallback has no attempt log. With a stale cache and a crash loop it is still tried on every restart (3 tries, 5 s apart). Space-Track is now held back by `packages/backend/src/cache/attempt-log.ts`.
- `GET /api/tle/visual` has no negative cache. While CelesTrak is down, every request starts a new 3-try fetch.
- The NL compiler cache and gap log live in `<backend>/data`, not on the volume. The gap log has no rotation.
- Unpruned `.tmp` files from a crashed write (cache, raw archive) stay on the volume.
- The gzip copy of `/api/tle/all` is still built with the sync `gzipSync` (about 0.5 s on the fake catalog), at boot and after each daily fetch. The brotli copy is async. `/api/history/at` builds its day snapshots with the same sync gzip and has no brotli yet.
- A missing `/assets/...` file falls through to the SPA fallback and returns `index.html` with status 200. A tab left open across a deploy that lazy-loads a removed chunk gets HTML instead of a clean 404.

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
