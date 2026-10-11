# STATE — what is true now

As of commit `e3914f8` on branch `spike/god1`, 2026-10-10.

## What Orbitwatch is

A browser app that shows every tracked object in Earth orbit in 3D, live.
It also shows deep-space objects (Artemis II) and answers plain-English questions about the sky.
Backend: Express. Frontend: React, three.js, Zustand, Vite. Physics: SGP4.

## Health

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run test` | 968 pass, 0 fail |
| Linter | none exists |
| CI | none exists |

Test counts by package: contracts 12, orbital-core 119, analytic 201, backend 346, frontend 279, repo-level tests 11 (architecture 4, state files 7).

## Recent milestones (newest first)

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
