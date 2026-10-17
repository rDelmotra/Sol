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
