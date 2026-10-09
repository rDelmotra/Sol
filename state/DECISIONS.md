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
