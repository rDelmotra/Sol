# Wiring the star-map outputs into the app (plan, 2026-10-30)

Inputs, frozen on `spike/starmap`: the S6 36 h screener with Pc (`scripts/starmap/screen-forward.ts --mode s6`),
derived events (T2), star-map coverage lists (T1), the uncertainty model (U5) and the browser pack (P5). Findings
in `STARMAP.md`; integration map below is from reading the code (file:line refs as of commit 01dea98).

## Principles

- **Production stays off limits until the owner says so** (FABRIC D6, `state/DECISIONS.md`). Everything below is
  built and tested locally (docker-compose Postgres), behind `DATABASE_URL`, and ships only on the owner's go.
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
    `conjunction(id, pair, tca, miss_km, vrel_kms, ric, vol, pc_balanced, pc_max, tier, low_confidence, label,
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

- `packages/contracts/src/ssa.ts` (leaf, added to the barrel): `ConjunctionSummary`, `ConjunctionDetail`
  (with update history), `SsaEvent`, `SsaRunInfo`, `PcTier = 'red' | 'amber' | 'none'`.
- `GET /api/ssa/run`: latest run (time, element cutoff, counts).
- `GET /api/ssa/conjunctions?tier=&norad=&from=&to=&limit=`: sorted by Pc, newest run.
- `GET /api/ssa/conjunctions/:id`: one event with its update history.
- `GET /api/ssa/objects/:norad`: that object's conjunctions and recent events.
- `GET /api/ssa/events?kind=&since=&norad=`: event feed (appeared, disappeared, jump, formation).
- Conventions: `{error}` envelopes, 503 when history is off; `public, max-age=300` with an ETag keyed by run id
  (data changes once per run). Mounted in the route table at `app.ts:86-100`.
- Tiers (lead review, STARMAP round 5): red Pc ≥ 1e-4, amber ≥ 1e-5 on the balanced model with floor;
  `pc_max` shown beside it for audit; "low confidence" when either object is manoeuvrable (Starlink class).

## W3 — Frontend: see it on the globe

- `data/ssa-client.ts` (fetch + IndexedDB cache keyed by run id); `store/ssaSlice.ts` (run, conjunctions,
  selected conjunction, events) plus `types.ts` and the shape test.
- **Object pane:** `ui/cockpit/panes/ConjunctionsPane.tsx` in `FocusPanes` for the selected object: list with
  TCA countdown, miss, relative speed, tier chip, low-confidence tag.
- **Threat board:** a new HUD region in `CockpitHud.tsx` (toggle in `hudSlice`, key in `useCockpitKeys.ts`):
  top red/amber events in the next 36 h; badge with the red/amber count in `hud/TelemetryTR.tsx`.
- **Globe:** `engine/world/layers/ConjunctionLayer.ts` (reads the store like `PassArcLayer.ts`, positions from
  `SatellitesLayer.getInterpolatedPosition`): a line between the pair near TCA and a TCA marker. Engine command
  `showConjunction(id)` in `EngineCommands.ts`: select the primary, filter to the pair (`setAnalyticFilter`),
  jump the clock to TCA − 2 min (`jumpToSimTime`).
- **Event feed:** a pane listing recent jumps / appeared / disappeared, click to select the object.
- Rules respected: UI talks to the engine only through store command slots; layers never import layers.

## W4 — Perceptor

- **Per-object fields** (cheap, fits the current IR): a server field provider in `backend/src/analytic/providers/`
  with `conjCount36h`, `maxPc36h`, `nextTca`, `lastJumpAt`, registered in `FIELD_REGISTRY`; then "which Starlinks
  have a red conjunction tomorrow" compiles to an ordinary filter (`programNeedsServer` routes it).
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

1. Approve building W1–W3 in the production packages on `spike/starmap` (the spike rule limited code to
   `scripts/starmap/`).
2. Production, later: a volume of ≥ 50 GB (500 GB is plenty), ≥ 4 GB RAM for the app service (or run the
   screener in S5 mode at 0.9 GB), and applying migrations 0002/0003. Plain Postgres is enough.
3. Tier thresholds (red 1e-4, amber 1e-5) and the 36 h horizon, both settings.
