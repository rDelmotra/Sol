# STATE — what is true now

As of commit `dd4351a` on branch `cockpit/port`, 2026-10-11.

## What Orbitwatch is

A browser app that shows every tracked object in Earth orbit in 3D, live.
It also shows deep-space objects (Artemis II) and answers plain-English questions about the sky.
Backend: Express. Frontend: React, three.js, Zustand, Vite. Physics: SGP4.

## Health

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run test` | 1202 pass, 0 fail |
| Linter | none exists |
| CI | none exists |

Test counts by package: contracts 12, orbital-core 119, analytic 201, backend 387, frontend 471, repo-level tests 12 (architecture 4, state files 8).

## Recent milestones (newest first)

- Still HUD on `sre/hardening` (decision D10): every looping animation in `packages/frontend/src/ui/cockpit/` is gone (reticle, waveform, object scan sweep, pad-live dot, return-button pulse, orbit marker pulse). One-shot transitions stay. `packages/frontend/src/ui/cockpit/still-hud.test.ts` fails if a looping animation or an animation-frame loop comes back. The orbit diagram in the object scan pane is now a fixed view: the camera is tied to the orbit plane (35 degrees above it, ascending node on the left, every orbit counter-clockwise), near half solid, far half dashed, equatorial ring and north pole shown, AN and PE marked. The object dot moves once a second from a plain timer. Geometry: `packages/frontend/src/ui/cockpit/panes/orbit-diagram.ts`.
- First-load order fix on `sre/hardening`: the Earth textures (about 6 MB) no longer download in parallel with the satellite catalog. `EarthLayer` builds the globe at once with plain placeholder maps and fetches the real textures only after the catalog request settles (done, failed, or read from the local cache), or after 15 s at most. If every texture is already in the service worker cache they load at once. The catalog request itself now starts from `packages/frontend/src/main.tsx` through `packages/frontend/src/data/catalog-prefetch.ts`, before the Engine chunk arrives. Gate: `packages/frontend/src/data/load-gate.ts`; texture side: `packages/frontend/src/engine/textures/texture-gate.ts`. `packages/frontend/public/sw.js` is unchanged.
- SRE hardening on `sre/hardening`: the daily 02:00 cron now always refreshes (it skips only if the cache is under 1 hour old; boot keeps the 24 h rule); `packages/backend/src/supervisor.ts` runs the API and the DSO worker and exits if either dies (Railway start command not changed yet, see OPEN.md); disk usage is logged at boot and after each raw archive write (warn at 75%, error at 90%) and is in `GET /health`; non-breaking security updates for prod dependencies (axios 1.20, express 4.22.3, compression 1.8.2, express-rate-limit 8.7.1). `node-cron` stays at 3.0.3 on purpose: the audit fix would downgrade it to 3.0.1, which needs `uuid` without declaring it. Two moderate advisories remain (`uuid`, `node-cron`); node-cron calls `uuid.v4()` without a buffer, which the advisory does not cover. Findings report: `state/SRE_FINDINGS.md`.
- Engine-side cleanup on `cockpit/port`: pass planning is an Engine-owned `PassPlanner` (no React hook); `NavigationController` delegates to `UnfollowAnimator` and `LandingController`; reticle candidate name is a selector, not stored; per-call buffers reused; gamepad choice is stable.
- Input bindings declared once in `packages/frontend/src/bindings/bindings.ts`: keyboard, gamepad, controls-sheet rows and HUD hints all derive from it. `FlyController` is camera-only; pad HUD buttons and the D-pad scrub moved to `pad-commands.ts` and `gamepad-scrub.ts`, both unit-tested.
- Cockpit HUD frame ported (`cockpit/port`): it replaces the old overlay. Shell, telemetry corners, reticle, edge arcs + speed gauge, side panes, dock, time console, ask bar, object disc, orbit diagram, pass readout + compass, controls sheet. The old `ui/CompassStrip.tsx` is gone.
- Cockpit engine side ported (`cockpit/port`): live altitude/speed, gamepad reticle soft-lock, pass arc, free flight with gears (keyboard + gamepad), land / take off / unfollow.
- Janitor pass: dead store state and a vacuous architecture rule removed, stale comments fixed.
- Stale worker buffers are now extrapolated (position + velocity × time) in `live-source.ts`.
- Earth model is WGS84, in one file: `packages/orbital-core/src/earth.ts`. Done 2026-10-09.
- Sweep prefilter is provably conservative. A 600k-sample brute-force test proves it.
- Frontend engine split into controllers. `Engine.ts` is 640 lines.
- Frontend store split into 10 slices. Backend has `createApp()` and `runBootTasks()`.
- `orbital-core` is the single home of physics. `contracts` is the single home of wire types.

## Facts an agent must know

- `ER_KM = 6371` is the scene and wire length unit. It never changes.
  The Earth's shape is WGS84 and lives only in `earth.ts`. They are different things.
- Latitude and altitude on the ellipsoid need TEME or ECEF vectors.
  Scene vectors are Y-up. Convert with `sceneToSource` in `packages/frontend/src/engine/scene/frames.ts` first.
- Two propagation engines are in use and they differ slightly.
  The Rust/WASM crate uses WGS84 gravity. `satellite.js` is hard-coded WGS72.
  Gap: LEO median 37 m now, about 250 m at +7 days. The owner accepted this.
- The rendered globe is still a unit sphere. Error is under 0.3 percent, under 2 pixels. Takram replaces it later.
- The frontend has two query systems. The Analytic IR is the live one.
  The older keyword engine is `packages/frontend/src/query/` (parser, executor, aliases, vocab). It is still wired in.
- `packages/wasm-sgp4/pkg/` is committed and was not rebuilt after the constant rename. Output is identical.

## Environment hazards

- `packages/backend/.env` holds real Space-Track credentials and a Gemini key. Never read, print or commit it.
- The Gemini key was rejected by Google as leaked. Every Ask returns an error until the owner rotates it.
- Untracked scripts `packages/backend/scripts/bench-*.ts` are local experiments. Never commit them.
- `DELETE/` is a local parking folder for removed files. It is gitignored.
- Railway and the production database: do not touch.

## Branches that matter

- `spike/god1` — current working branch.
- `main` — release branch, behind this one.
- `spike/takram` — earlier Takram (tiled Earth) spike. Not merged.
- `claude/ui-run-spike-c350c8` — cockpit UI spike. Visual reference for `cockpit/port` (see D8). Not merged.
- `cockpit/port` — the cockpit HUD being rebuilt on top of `spike/god1`.
- `experiment/nl-to-ir` — its history contains a leaked key. Do not push or merge it.
