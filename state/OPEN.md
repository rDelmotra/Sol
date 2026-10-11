# OPEN — known problems and deferred work

Remove an item when it is fixed. None of these is scheduled unless the owner says so.

## Needs the owner

- Rotate the Gemini key. It was rejected as leaked, so every Ask fails.
- Rotate the key found in the history of `experiment/nl-to-ir`.
- DSO validity window: `DEFAULT_VALID_PAST_WINDOW_SEC` is 10 days. Should it be "since launch"?
- Artemis II fetch fails every 30 minutes. Disable it or fix it?
- Object category is always `unknown` because Space-Track's SATCAT has no operational-status field. Needs another source.
- Dead branch cleanup. Many old branches exist.

## Planned projects (not started)

- **Takram integration.** Tiled Earth, atmosphere, clouds. Start with the depth-buffer decision and the `frames.ts` adapter.
  Known risks: logarithmic depth would force edits to all 7 custom shaders.
  The atmosphere is a screen-space effect and probably won't blend with additive satellite points, so those likely need a separate pass.
- **Perceptor and Analytic IR redesign.** See D3. Marked now by 2 known violations in `tests/architecture.test.ts`
  (`services/analytic-prompt.ts` importing `analytic`) and by the hand-kept list in `packages/analytic/src/capability.ts`.

## Cockpit port (deferred)

- **Cockpit HUD pieces still missing.** Time console / scrubber, ask bar, object disc, orbit diagram (OBJECT SCAN has an empty slot), pass readout + compass, controls sheet (`?` already hides the dock and toggles `controlsSheetOpen`, but nothing draws yet). No HUD reads the pass plan yet.
- **No unfollow trigger for the UI.** Dock ORBIT leaves a joyride via `cameraMode` 'returning' (eases home). A store trigger slot for `NavigationController.unfollow` would let it stop in place instead.
- **Place naming after landing.** `NavigationController.landWhereLooking` only sets lat/lon (and clears `observerPlaceName`). Naming the place is left to the UI.
- **No pad look on the ground.** In the dome view pad buttons work, but the right stick does not turn the gaze (the spike had no binding either).
- **Pass search runs on the main thread.** `packages/frontend/src/ui/hooks/useNextPasses.ts` runs a 24-hour `findPasses` (about a thousand SGP4 steps) on each selection, observer, vantage or 5-minute sim-time change. Move it to a worker.

## Dead after the cockpit swap (D8) — remove in a follow-up

The old overlay is deleted. These have no reader left in the UI. Check each before removing.

- `packages/frontend/src/store/filterSlice.ts`: filter state that only FilterPanel set.
- `packages/frontend/src/store/commandSlice.ts`: `injectSearchQuery` and its setter (SearchBar registered it).
- `packages/frontend/src/store/types.ts`: hover state (`hoveredName`) and cluster state (`clusterItems`, `clusterScreenX`, `clusterScreenY`, `setCluster`, `clearCluster`). Tooltip and ClusterPopup read them. The engine may still write them.
- `packages/frontend/src/query/`: the older keyword engine (parser, executor, aliases, vocab, tokenize). SearchBar was its caller. `vocab` is still imported by `packages/frontend/src/engine/Engine.ts`, and `types` by the store.
- `packages/frontend/src/data/metadata-client.ts`: nothing imports it now.
- `fuse.js` in `packages/frontend/package.json`: only SearchBar used it.

## Known weaknesses (left alone by decision D2)

- **Filter fan-out.** Adding one filter group touches about 18 files. It needs a facet registry.
- **Engine reads the store directly** about 95 times across 15 files.
- **Test blind spots.** The architecture test has no rules for the catch-all `engine` zone, and cannot see `new URL()` worker edges.
- **Untested critical code.** `World.ts`, `SatelliteRenderer.applyVisibilityAndFilters`, `routes/tle.ts`, cron, history, the Rust crate.
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
