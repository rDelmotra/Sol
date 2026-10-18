# DECISIONS — owner choices and why

Append only. Newest last. A new entry supersedes an old one. Never edit an old entry.

## D1 — Cleanup order (2026-09)
Clean up first, then refactor, then WGS84.
Why: each phase is safer on a smaller, tidier base.

## D2 — Cleanup means cleanup (2026-10-08, 2026-10-10)
Cleanup removes dead code and fixes stale text. It does not redesign.
If code is not completely unnecessary, leave it.
Docs, linter, CI and redesign are out of scope unless asked.

## D3 — Perceptor and Analytic IR redesign is a separate later project (2026-10-08)
Principles for that project:
- The browser is an abstract end entity. It can be swapped for anything.
- Routing between client and server is implicit. It is not a hand-kept field list and not a question to the user.
- Answers are exact, instant and pushed. They are not fetched on request.
- Many entity types are coming.
Rejected: a routing manifest, and asking the user questions like "is a day loaded".

## D4 — WGS84 only (2026-10-09)
The Earth model is WGS84. No WGS72 switch now or later.
- Umbra radius is the equatorial radius `a`.
- Stale worker buffers are extrapolated, position + velocity × time.
- Sweep prefilter margins are 50 km and 0.1 degrees.
- Rust crate stays on WGS84. `satellite.js` stays on its built-in WGS72. The small gap is accepted.

## D5 — `ER_KM` is a unit, not a shape (2026-10-09)
`ER_KM = 6371` stays as the scene and wire unit. Earth's shape lives only in `earth.ts`.

## D6 — Tooling rules for agents (standing)
- No `Co-Authored-By` trailer on commits.
- One compact commit per step.
- Never read, print or commit `packages/backend/.env`.
- Do not touch Railway or the production database.
- Verify in the browser only when behaviour is rewired. Pure moves are verified by tests.
- Talk in short plain sentences. Define terms.

## D7 — Claude-specific docs stay out of git (2026-10-10)
`CLAUDE.md`, `PROJECT_MAP/` and similar tool files stay untracked.
Tool-neutral project state lives in `state/` and is tracked.

## D8 — The cockpit HUD becomes the UI (2026-10-11)
Supersedes the 2026-09-27 rejection of `claude/ui-run-spike-c350c8`.
- The cockpit HUD replaces the whole old overlay. SearchBar, FilterPanel, InfoCard, AnswerCard, HUD, ResetViewButton and the old TimeScrubber component go.
- It is rebuilt on branch `cockpit/port` off `spike/god1`, not merged from the spike. Spike code is reused only after review.
- Time scrubbing keeps god1's engine and store logic, including the loaded-day snap guard. Only the cockpit's clock-row control is new.
- The tutorial keeps only the gamepad controls sheet (`?` / pad START). The spotlight tour is dropped.
- Desktop width first. Small screens later.

## D9 — The cockpit HUD always animates (2026-10-11)
The motion is part of the approved look; the owner's own Mac has Reduce Motion on and the HUD went still.

## D10 — The idle HUD is still (2026-10-14)
Looping animations are removed to stop idle GPU and CPU heat. One-shot transitions stay (pane fan-in, time console, chips, gear flare and glow, edge arcs).
Supersedes D9's "always animates" for looping motion. The Reduce Motion override (D9) stays moot.
- Waveform bars are fixed. Colour (cyan to amber) shows active or compiling.
- Reticle, object scan and pad-live dot do not move.
- The return-to-present button has a static amber ring.

## D11 — DSOs are shown by their own ephemeris window, not hidden in the past (2026-10-16)
A deep-space object (Artemis II) is drawn only when the sim time is inside its own ephemeris window, whatever the view is (live, a past day, or the planetarium). Outside the window it is not visible, including before its first sample.
- `interpolateDsoPosition` (`packages/frontend/src/data/dso-interpolator.ts`) returns null before the first sample, as it already did after `validTo` plus grace.
- A catalog swap never hides DSOs and the planetarium keeps the DSO selection. Each swap re-encodes the DSO pick IDs against the new TLE count (0 in the planetarium) through `DsoLayer.resyncForCatalog`.
- Replaces the old rule that hid every DSO while the view was in the past.

## D12 — The orbit card is the original spike drawing, held still (2026-10-16)
The orbit card in the object scan pane goes back to the spike's drawing (Earth upright, radial web in the equatorial plane, white orbit arc, the part hidden by the Earth dimmed), with the spin removed. The camera is fixed 7 degrees above the equatorial plane. This replaces the orbit-plane camera with dashed far half (35 degrees) built earlier on this branch; the owner rejected it as less clear.

## D13 — Only the orbit arc turns, at 10 fps (2026-10-17)
One exception to D10: on the orbit card the arc and its dot turn slowly about the pole so the tilt reads from every side. Earth, web rings and spokes stay fixed. One 100 ms timer, no animation-frame loop, paused while the tab is hidden, arc paths written through refs (no React re-render), scale fitted once over a full turn. `still-hud.test.ts` fails if a frame loop appears or the step drops under 100 ms. Revert if it adds more than about 1 point of idle CPU in the owner's Chrome.

## D14 — 5 Space-Track attempts a day, an alert on the 5th failure; CelesTrak is an overlay fallback only (2026-10-17)
- Space-Track gets at most 5 logins per UTC day (every attempt counts, success or failure). When the 5th fails with no success that day, one alert goes out (log line `ALERT`, optional webhook, optional Resend email). The cap never blocks the 02:00 cron of a new day.
- CelesTrak has no group that is the full catalog, and `last-30-days` is only recent launches. So its `GROUP=active` JSON is laid over the cached catalog (newer epoch wins, new ids added, nothing removed). It is never a replacement.
- CelesTrak is asked at most once per 2 hours per group, and a 3xx/4xx answer is never retried, because repeating can get the IP blocked.
- History stays Space-Track-only: an overlay result is not ingested into the history database or the raw archive.

## D15 — Deep-space objects cost nothing outside their data window (2026-10-18)
`DsoLayer.update` asks the DSO worker for positions only while some mission's ephemeris window covers the sim time (`anyDsoActiveAt`, `packages/frontend/src/engine/dso/dso-window.ts`); leaving the last window sends one forced tick so nothing stays drawn. The per-frame screen-label projection and the `dsoLabelPositions` store key (nothing read it) are removed. Measured in the browser: 0 worker ticks outside Artemis II's dates, 60 a second inside.

## D16 — Space-Track retries, daily alerts, overlay that keeps metadata, write and volume alerts (2026-10-18)
Corrects and extends D14. A senior review found that the code did not do what the owner expects.
- Space-Track gets at most 5 logins per UTC day. The wait between attempts is computed from that day's failures: 15 min, 30 min, 1 h, 2 h, so the 5th is about 3 h 45 min after the 1st. The backoff resets each UTC day (before, a multi-day streak reached the 6 h cap and only the first day of an outage could use 5 attempts). After the 5th the gate stays shut until 00:00 UTC.
- A CelesTrak write does not stop the Space-Track retries. After every cycle in which Space-Track failed, was refused or was held back, one retry timer is armed for the next time the gate allows a login (00:00 UTC when the day's 5 are used). Only a Space-Track success cancels it. The retry never skips because the cache is fresh, and it asks CelesTrak only as far as CelesTrak's own 2 hour gate allows. After a restart the timer is armed again from the attempt log.
- One alert per UTC day when that day's 5th attempt fails and none succeeded, and the same again on every day the outage lasts. The text says how many days in a row, whether CelesTrak kept the catalog fresh, and how old the catalog is. A refused catalog (size guard) counts as a failed attempt for the cap and the alert.
- The CelesTrak overlay keeps cached metadata. CelesTrak's GP JSON has only the 17 OMM keys (no type, country, launch date, size, period or apsides). A newer CelesTrak record updates only the orbit (omm, epoch, inclination) and what derives from it (period, apogee and perigee from mean motion and eccentricity, with Space-Track's definition: km above the surface; regime from the period). Older or equal epochs never replace. New ids are added with the pipeline's unknown defaults. The catalog never shrinks. Decayed objects are dropped when the data says so (it does not today).
- Write failure: if writing the catalog throws, the attempt counts as failed, the cycle logs ERROR, removes only its own temp files, keeps serving the old cache, arms the retry and sends an alert titled as a disk or write problem (with the disk usage), at most once per UTC day. On the day's 5th attempt that one alert also stands in for the daily alert.
- Volume alerts: when the data volume is at 75% (warn) or 90% (error) used, an alert goes out through the same path, at most once per UTC day per level and at once when the level gets worse. It is checked at boot, after each raw archive write and after the 02:00 cycle. The markers are in `alert-state.json`.
- Unverified: the overlay has never run against the real CelesTrak, and the alert delivery (ntfy) has not been seen end to end in production.

Addendum (2026-10-18): when the CelesTrak overlay is saved, one ntfy alert goes out per UTC day ("CelesTrak was used as the fallback"). It says why Space-Track did not supply the catalog, how many satellites got newer orbits, and that history is untouched. The day is remembered in `alert-state.json` (`celestrakFallbackDay`), so retries and restarts do not repeat it. No alert if CelesTrak failed too or the save failed (the write-failure alert covers that).

## D17 — DSO is fully isolated: a dead worker is restarted alone with backoff, the API never depends on it, the frontend fails soft (2026-10-18)
Owner rule: the deep-space feature is parallel and async. If it fails, hangs, is slow or has no data, nothing else changes.
- `packages/backend/src/supervisor.ts`: the `api` child is critical (it dies: stop everything, exit non-zero). The `dso-worker` child has `critical: false`: any exit (also code 0) or failed spawn restarts only that child, after 5 s, 10 s, 20 s ... capped at 5 min; the delay resets after 10 min of uptime; each restart is logged at ERROR with the exit code and the next delay. Shutdown cancels any pending restart. The backoff also keeps a crash loop from hammering NASA Horizons.
- API (`packages/backend/src/routes/dso.ts`, `packages/backend/src/app.ts`): every DSO read has a 2 s limit; a missing, corrupt or unreadable DSO directory gives a fast 503 JSON on `/api/dso/*` (never an unhandled rejection) and `/health` stays 200 with zero DSO counts and `dsoError: true`. Nothing in the API, cron, history or analytic code imports the DSO worker or the Horizons client.
- Frontend: the DSO layer is non-critical, its store subscriptions and camera hook are wrapped, the catalog poll backs off to 5 min while the DSO API has no data (`packages/frontend/src/data/dso-client.ts`), and the DSO worker restarts with the same backoff (`packages/frontend/src/engine/dso/restart-backoff.ts`).

Addendum 2 (2026-10-18): every real CelesTrak call for the fallback group (`packages/backend/src/services/celestrak.ts`) sends one ntfy alert with the outcome ("CelesTrak was called" with the record count, or "called and failed" with the reason). A call skipped by the 2 hour gate sends nothing, and the separate visual-list fetch never alerts. This is on top of the once-a-day "used as the fallback" alert, so the first fallback of a day sends two messages.
