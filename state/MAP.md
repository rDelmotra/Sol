# MAP — how the code is laid out

Every repo path in backticks here must exist. `tests/state.test.ts` enforces it.

## Packages and build order

npm workspaces. Builds are chained by hand in the root `package.json` (`build:libs`), because workspaces are not built in dependency order.

| Order | Package | Role | Depends on |
|---|---|---|---|
| 1 | `packages/contracts` | Shared wire types, enums, label tables. Zero imports. | nothing |
| 1 | `packages/orbital-core` | The one home of orbital physics. Zero dependencies. | nothing |
| 2 | `packages/analytic` | Analytic IR: types, schema, validator, interpreter. Pure, no I/O. | contracts, orbital-core |
| 3 | `packages/backend` | Express API, caches, cron, enrichment, history DB, server-side query execution. | all above |
| 3 | `packages/frontend` | React + three.js app. | all above |
| – | `packages/wasm-sgp4` | Rust SGP4 compiled to WASM. Not an npm workspace. Built output `pkg/` is committed. | – |

Import rules between and inside packages live in `tests/architecture.test.ts`. Read the rules there, not here.

## Physics: `packages/orbital-core/src`

| File | Owns |
|---|---|
| `packages/orbital-core/src/units.ts` | `ER_KM` and unit constants |
| `packages/orbital-core/src/earth.ts` | WGS84 shape, geodetic conversions, umbra radius |
| `packages/orbital-core/src/live-plane.ts` | Derived quantities (altitude, speed, sub-point, eclipse, elevation, azimuth, range). Used by frontend and backend alike. |
| `packages/orbital-core/src/elements.ts` | Mean-element quantities: semi-major axis, two-body orbit shape for diagrams |
| `packages/orbital-core/src/visibility.ts` | Naked-eye visibility gate and sky brightness policy |
| `packages/orbital-core/src/illumination.ts` | Eclipse and observer darkness |
| `packages/orbital-core/src/observer.ts` | Observer position in ECEF and TEME |
| `packages/orbital-core/src/propagation-window.ts` | Allowed propagation time range |

## Analytic IR: `packages/analytic/src`

| File | Owns |
|---|---|
| `packages/analytic/src/schema.ts` | Field registry and function specs |
| `packages/analytic/src/validate.ts` | Validator with typed error codes |
| `packages/analytic/src/execute.ts` | Interpreter and sweep prefilter |
| `packages/analytic/src/capability.ts` | Hand-kept list deciding client or server execution |
| `packages/analytic/src/wire.ts` | JSON round-trip for results |

## Backend: `packages/backend`

| Area | Where |
|---|---|
| App and routes table | `packages/backend/src/app.ts` |
| Boot tasks | `packages/backend/src/boot.ts` |
| Entry point | `packages/backend/src/index.ts` |
| Env access | `packages/backend/src/utils/config.ts` |
| All filesystem paths | `packages/backend/src/utils/paths.ts` |
| HTTP routes | `packages/backend/src/routes/` |
| Data fetchers, NL compiler, prompt builder | `packages/backend/src/services/` |
| Server-side query execution | `packages/backend/src/analytic/` |
| Deep-space objects (isolated namespace) | `packages/backend/src/dso/` |
| Optional Postgres history (isolated namespace) | `packages/backend/src/history/` |
| Runtime metadata store (isolated namespace) | `packages/backend/src/enrichment/` |
| Build-only enrichment pipeline | `packages/backend/tools/enrichment/` |
| Backend tests, grouped by area | `packages/backend/tests/` |

Run the enrichment build with `npm run enrichment:build -w packages/backend`.

## Frontend: `packages/frontend/src`

| Area | Where |
|---|---|
| Thin orchestrator, rAF loop | `packages/frontend/src/engine/Engine.ts` |
| Scene layers (one per visual system) | `packages/frontend/src/engine/world/layers/` |
| Layer registry and failure isolation | `packages/frontend/src/engine/world/World.ts` |
| Layer contract | `packages/frontend/src/engine/render/Layer.ts` |
| Camera, timeline, tracking controllers | `packages/frontend/src/engine/controllers/` |
| Free flight, camera only; hands HUD and time buttons to the two below | `packages/frontend/src/engine/controllers/FlyController.ts` |
| Flight physics (gears, inertia, surface clamp), pure | `packages/frontend/src/engine/controllers/flight-model.ts` |
| Every key, pad button and chord declared once (id, keys, pad trigger, label, hint glyph, which side handles it). Leaf zone: engine and UI both read it. Also the shared "typing or modified" key guard | `packages/frontend/src/bindings/` (`bindings.ts`, `key-guards.ts`) |
| Keyboard and gamepad to named flight actions (derived from the bindings table) | `packages/frontend/src/engine/input/flight-input.ts` |
| Gamepad HUD buttons (lock, START, L3/R3, SELECT) to store calls, pure | `packages/frontend/src/engine/input/pad-commands.ts` |
| D-pad: panes, land, time-scrub field focus and step/hold, pure | `packages/frontend/src/engine/input/gamepad-scrub.ts` |
| Gamepad time-scrub auto-repeat, pure | `packages/frontend/src/engine/input/scrub-repeat.ts` |
| Reticle area-pick circle test and ranking, pure | `packages/frontend/src/engine/input/reticle-pick.ts` |
| Live altitude and speed of the locked object (~4 Hz) | `packages/frontend/src/engine/controllers/LiveKinematics.ts` |
| Land where you look: view ray to WGS84 lat/lon | `packages/frontend/src/engine/scene/ground-pick.ts` |
| Selected object's next pass drawn across the sky | `packages/frontend/src/engine/world/layers/PassArcLayer.ts` |
| Analytic runtime in the engine | `packages/frontend/src/engine/analytic/AnalyticRuntime.ts` |
| Typed command surface | `packages/frontend/src/engine/command/EngineCommands.ts` |
| Scene-axis adapter (TEME to Y-up) | `packages/frontend/src/engine/scene/frames.ts` |
| Satellite point cloud | `packages/frontend/src/engine/SatelliteRenderer.ts` |
| Earth globe | `packages/frontend/src/engine/EarthRenderer.ts` |
| Workers and their message types | `packages/frontend/src/workers/` |
| Store (12 slices, one composed hook) | `packages/frontend/src/store/` |
| Vantage + sky lens, observer place name, pass plan | `packages/frontend/src/store/observerSlice.ts` |
| Numbers the engine, store and UI must agree on: reticle box and ring radius, flight gear table and default. Leaf zone: imports nothing from the app | `packages/frontend/src/constants/` (`reticle.ts`, `flight-gears.ts`) |
| Cockpit flight state (speed gears, gamepad, reticle candidates) | `packages/frontend/src/store/flightSlice.ts` |
| Cockpit HUD open/closed state (panels, ask bar, controls sheet) | `packages/frontend/src/store/hudSlice.ts` |
| Data clients (pure fetch, no store) | `packages/frontend/src/data/` |
| Live query data source | `packages/frontend/src/query/analytic/live-source.ts` |
| Older keyword query engine | `packages/frontend/src/query/` |
| Simulation clock | `packages/frontend/src/time/SimClock.ts` |
| Calendar time fields (gamepad time scrub) | `packages/frontend/src/time/time-fields.ts` |
| Observer-sky logic (no engine, store or UI) | `packages/frontend/src/sky/` |
| Pass prediction (rise, peak, set, bearings) | `packages/frontend/src/sky/passes.ts` |
| Pass arc sampling, Earth-fixed | `packages/frontend/src/sky/pass-arc.ts` |
| Pass plan for the selected object (hook, mounted in App) | `packages/frontend/src/ui/hooks/useNextPasses.ts` |
| OMM to orbit-diagram elements | `packages/frontend/src/sky/orbit-elements.ts` |
| Overlay UI | `packages/frontend/src/ui/` |
| Cockpit HUD root: shell, layout numbers, formatters, keyboard map, tokens (shared surface, mounted by App) | `packages/frontend/src/ui/cockpit/` (`CockpitHud.tsx`, `layout.ts`, `format.ts`, `keys.ts`, `useCockpitKeys.ts`, `cockpit.css`) |
| Cockpit primitives: the shared building blocks every other cockpit folder uses (glass pane, key/value rows, pane header, empty state, action row, error boundary, title, vignette and scan, native-button reset style). Nothing here imports a feature folder | `packages/frontend/src/ui/cockpit/primitives/` |
| Cockpit side panes: object scan (identity, telemetry, actions, analysis) and the 3D orbit diagram | `packages/frontend/src/ui/cockpit/panes/` |
| Cockpit dock: mode controls, lens and location controls, location popover, round icon button, dock styles | `packages/frontend/src/ui/cockpit/dock/` |
| Cockpit time console: clock row that unfolds into the scrubber, digits, field chips, momentum wheel, return button, mouse stepping | `packages/frontend/src/ui/cockpit/time/` |
| Cockpit ground view: compass strip and pass readout, with their pure helpers | `packages/frontend/src/ui/cockpit/ground/` |
| Cockpit controls sheet: keyboard / gamepad diagram / mouse bindings | `packages/frontend/src/ui/cockpit/controls/` |
| Cockpit on-screen layers: reticle, object disc, edge arcs, gear readout and sweep, corner telemetry, ask bar and waveform | `packages/frontend/src/ui/cockpit/hud/` |
| UI hooks: GPS fix, pass plan, analytic ask, element size (ResizeObserver) | `packages/frontend/src/ui/hooks/` |
| Observer location acquisition and cache policy | `packages/frontend/src/sky/observer-location.ts` |
| GLSL shaders | `packages/frontend/src/shaders/` |

Rules that hold even without reading the architecture test:
- Layers never import other layers.
- Never subscribe to the store inside the per-frame loop.
- Every class that creates a three.js object has `dispose()`.
- To add a visual system, add one layer file and one `world.register(...)` line. Do not grow `Engine.ts`.

## Where to change common things

| To change | Edit |
|---|---|
| Earth shape | `packages/orbital-core/src/earth.ts` only |
| Naked-eye thresholds | `packages/orbital-core/src/visibility.ts` |
| Add an Analytic IR field | `packages/analytic/src/schema.ts`, then the client and server providers, then `packages/analytic/src/capability.ts` |
| Add an API route | route file in `packages/backend/src/routes/`, mount in `packages/backend/src/app.ts` |
| Add a filter group | many files. See OPEN.md, "Filter fan-out" |
| Add a shared wire type | `packages/contracts/src/` |
| Move an import boundary | `tests/architecture.test.ts` |

## API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/tle/all`, `/api/tle/version`, `/api/tle/visual` | Catalog, version check, naked-eye list |
| `GET /api/metadata/:noradId` | One object's metadata |
| `GET /api/catalog`, `/api/catalog/decayed` | Catalog index, decayed objects |
| `GET /api/launch/:tag`, `/api/org/:code` | Launch and organisation records |
| `GET /api/dso/catalog`, `/manifest`, `/ephemeris/:dsoId` | Deep-space objects |
| `POST /api/query/compile` | Question to program only |
| `POST /api/query/ask` | Question to answer, routed client or server |
| `GET /api/query/vocab` | Entity vocabulary |
| `GET /api/history/coverage`, `/api/history/at` | Historical catalog. 503 when `DATABASE_URL` is unset. |
| `GET /health` | Uptime and counts |

## Data flow in one paragraph each

**Live catalog.** Backend fetches from Space-Track (fallback CelesTrak), classifies, caches to a file and to a pre-gzipped memory payload. Frontend loads it (IndexedDB cached), feeds a WASM worker at about 1 Hz, and the worker writes position and velocity buffers the renderer draws.

**Deep space.** A backend worker fetches JPL Horizons every 6 hours, converts to TEME, and publishes snapshots. The frontend interpolates them in its own worker.

**Ask.** The search bar posts the question to `/api/query/ask`. The backend compiles it to an Analytic IR program with an LLM. If every field is client-servable, the program returns to the browser and runs on the live buffers. Otherwise the server runs it. The browser re-validates any program before trusting it.

**Time scrub.** Past dates load a day's catalog from the history DB if configured, otherwise the sky shows without satellites. Dates up to 14 days ahead reuse the live catalog.
