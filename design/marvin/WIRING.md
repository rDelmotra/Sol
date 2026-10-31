# Wiring the star-map outputs into the app (plan, 2026-10-30)

Inputs, frozen on `spike/starmap`: the S6 36 h screener with Pc (`scripts/starmap/screen-forward.ts --mode s6`),
derived events (T2), star-map coverage lists (T1), the uncertainty model (U5) and the browser pack (P5). Findings
in `STARMAP.md`; integration map below is from reading the code (file:line refs as of commit 01dea98).

## Principles

- **Scope and tone (owner, 2026-10-31):** an orbital intelligence and physical-realism platform, not a defence
  console. Conjunctions are presented neutrally as **encounters / flybys**: no threat board, no alarm tiers, no
  red/amber badges, no sirens. Numbers (miss, relative speed, Pc) are shown as plain values.
- **Production stays off limits until the owner says so** (FABRIC D6, `state/DECISIONS.md`). Everything below is
  built and tested locally against plain Postgres 16 in Docker (no TimescaleDB, no PostGIS), behind
  `DATABASE_URL`, and ships only on the owner's go.
- **One new backend zone, isolated like `history/`:** `packages/backend/src/ssa/` with an architecture rule
  `be-ssa-isolated` (imports only `ssa/`, `types/`, `utils/`, `@orbitwatch/orbital-core`, `@orbitwatch/contracts`).
  Its tables are shaped as FABRIC situations (`close` with Pc, superseding B7's "no Pc" note) and events (B7
  kinds), so they fold into `fabric_log` (B6) later without a rewrite.
- **The server is the source of truth for conjunction numbers.** The globe draws with WASM SGP4 (WGS84); the
  screener uses satellite.js (WGS72); they differ by tens of metres to ~0.6 km (`sgp4-wasm-parity.test.ts`). The
  client never recomputes miss or Pc; it draws positions and labels them with the server's numbers.
- **Frozen spike code is ported, not edited:** copy the S6 screener, Pc and event derivation into `src/ssa/`,
  keep `scripts/starmap/` as the reference, and add a parity test (same inputs, same events).

## W1 — Backend data and the nightly job

- **Migrations** (append to `history/db/migrations/index.ts`, TypeScript modules, never edit applied ones):
  - `0002_ssa`: `ssa_run(id, batch_time, element_cutoff, objects, events, duration_s, code_version)`,
    `conjunction(id, pair, tca, miss_km, vrel_kms, ric, vol, pc_balanced, pc_max, manoeuvrable, label,
    first_run, last_run, n_updates)`, `conjunction_update(conjunction_id, run_id, tca, miss_km, pc_balanced, ...)`,
    `ssa_event(id, day, kind, subjects int[], t_start, t_end, payload jsonb)` with the T2 indexes
    (kind+day, GIN subjects, t_start).
  - `0003_omm_updates`: keep every element-set update (`norad_id, epoch` unique), not one per object per day
    (`omm_daily` keeps the later epoch only, `db/queries.ts:109`). U5 and causal replay need it.
- **Job:** a third supervisor child `ssa-worker` (non-critical, like `dso-worker`, `supervisor.ts:278`). It runs
  after the daily ingest (`cron/tle-updater.ts:826-836` writes history at 02:00 UTC): screen the next 36 h from
  the element sets valid at run time, derive the day's events, write one `ssa_run`, upsert conjunctions with
  update history. Weekly: refit the uncertainty model from `omm_updates`. Worker threads in production run
  compiled JS, so the `*-worker-boot.mjs` tsx shims are not needed there.
- **Resources:** S6 peaks at ~2.2 GB RAM (S5 mode 0.9 GB) and ~3.5 min on 3 cores. Storage: conjunctions with
  update history ~35 GB/year; events ~1.5 GB per 5 years. No TimescaleDB or PostGIS needed for these tables.
- **Tests:** parity with the spike on one replayed day (identical events); migration up on a clean DB; job is
  idempotent per run.

## W2 — Contracts and API

- `packages/contracts/src/ssa.ts` (leaf, added to the barrel): `EncounterSummary`, `EncounterDetail`
  (with update history), `SsaEvent`, `SsaRunInfo`. No tier field.
- `GET /api/ssa/run`: latest run (time, element cutoff, counts).
- `GET /api/ssa/conjunctions?norad=&from=&to=&minPc=&maxMissKm=&sort=tca|pc|miss&limit=`: newest run.
- `GET /api/ssa/conjunctions/:id`: one event with its update history.
- `GET /api/ssa/objects/:norad`: that object's conjunctions and recent events.
- `GET /api/ssa/events?kind=&since=&norad=`: event feed (appeared, disappeared, jump, formation).
- Conventions: `{error}` envelopes, 503 when history is off; `public, max-age=300` with an ETag keyed by run id
  (data changes once per run). Mounted in the route table at `app.ts:86-100`.
- Pc is the balanced model with covariance floor; `pc_max` is carried beside it for audit. A neutral
  `manoeuvrable` flag marks pairs with a manoeuvring object (Starlink class), whose forecasts churn most.
- No tier column; `manoeuvrable` replaces the first draft's `low_confidence`.

## W3 — Frontend: encounters on the globe

- `data/ssa-client.ts` (fetch, cached per run id); `store/ssaSlice.ts` (run, encounters for the focused object,
  selected encounter) plus `types.ts` and the shape test.
- **Encounters tab** in the satellite focus pane (`ui/cockpit/panes/EncountersPane.tsx` in `FocusPanes`): the
  focused object's encounters in the next 36 h, each row with the other object's name, countdown to TCA, miss
  distance, relative speed and Pc as plain numbers. Click a row to watch it.
- **Flyby camera** (engine command `showEncounter(id)` in `EngineCommands.ts`): highlight the pair (filter via
  `setAnalyticFilter`), jump the clock to TCA − 2 min (`jumpToSimTime`), frame both objects, show a countdown
  to TCA.
- **Globe layer** `engine/world/layers/EncounterLayer.ts` (reads the store like `PassArcLayer.ts`, positions
  from `SatellitesLayer.getInterpolatedPosition`): a separation line between the pair, the relative-approach
  vector at the primary, and a small TCA marker; labels use the server's miss and Pc.
- Rules respected: UI talks to the engine only through store command slots; layers never import layers.
- Dropped from the first draft: threat board HUD, red/amber badge, event feed pane (events stay in the API and
  Perceptor).

## W4 — Perceptor

- **Per-object fields** (cheap, fits the current IR): a server field provider in `backend/src/analytic/providers/`
  with `conjCount36h`, `maxPc36h`, `nextTca`, `lastJumpAt`, registered in `FIELD_REGISTRY`; then "which Starlinks
  have an encounter under 1 km tomorrow" compiles to an ordinary filter (`programNeedsServer` routes it).
- **Relational / event questions** ("close approaches between X and Y", "manoeuvres last week"): a small
  pre-compiler route (shape of the spike's `ask-plan.ts`) that answers from `/api/ssa/*`, and the prompt stops
  refusing these as `NEEDS_HISTORY`.
- Long-window region questions (star-map lists + refine) wait for W5.

## W5 — Later

- Coverage lists (T1) built nightly in production and the long-window "who passed over X" path.
- Offline pack (P5): OPFS + dedicated worker, order-3 lists only (~32 MB + ~4 MB/day); the app's `sw.js`
  deliberately leaves `/api/*` alone, so the pack gets its own fetch path.
- Push: `after(seq)` and SSE per FABRIC B11, once events live in `fabric_log`.

## Owner decisions needed

1. ~~Approve building W1–W3 on `spike/starmap`~~ — approved 2026-10-31.
2. Production, later: a volume of ≥ 50 GB (500 GB is plenty), ≥ 4 GB RAM for the app service (or run the
   screener in S5 mode at 0.9 GB), and applying migrations 0002/0003. Plain Postgres is enough.
3. The 36 h horizon is a setting.
