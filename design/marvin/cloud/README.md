# Star map spike — cloud handbook (START HERE)

You are an agent with no prior context. This folder tells you everything you need to continue a
research spike in the Orbitwatch repo. Read these files in order, fully, before doing anything:

1. `design/marvin/cloud/README.md` (this file): rules, setup, how to work, how to report.
2. `design/marvin/cloud/CONTEXT.md`: the project, the physics, the data, what was built,
   everything measured so far, and every pitfall already hit.
3. `design/marvin/cloud/TASKS.md`: the task cards. Each is self-contained, with steps and
   acceptance checks.
4. `design/marvin/STARMAP.md`: the full findings log of rounds 1–3 (numbers and verdicts).

## What this spike is, in one paragraph

Orbitwatch shows every tracked object in Earth orbit (about 33,000) in a 3D browser app, and
keeps a daily history of their orbit numbers (element sets). The owner wants a "Perceptor" (the
"god feature") that can answer space-and-time questions over that data: what is in this
region of space now, who passed over this country in the last N days or years, who came close
to whom, what changed. This spike measures which storage and indexing design makes those
questions fast and correct. Rounds 1–3 are done. Your job is to finish the last prototypes
(layers 2 and 3 of the proposed design, then a query router) on a bigger machine, and write the
final decision with numbers.

## Hard rules (the owner's standing decisions)

- **Production is off limits.** Never use Railway tools, never connect to any remote database,
  and never change anything on the live app. The ONLY allowed contact is
  `packages/backend/scripts/starmap/fetch-data.sh`, which makes one public GET per day of
  history, 1 s apart, the same requests the app's browser makes.
- **Never read, print or commit secrets.** You do not need `packages/backend/.env`. Do not
  create one.
- **Work on branch `spike/starmap`.** Make one compact commit per finished step, with a message
  like `spike(starmap): <what>`. **Never add a `Co-Authored-By` trailer.** Do not push unless
  the session owner says so. Do not merge into other branches.
- **Spike code only.** New code goes in `packages/backend/scripts/starmap/` (scripts, never
  shipped). The one exception is pure, tested geometry in `packages/orbital-core/src/`. That
  package must import nothing outside itself (enforced by `tests/architecture.test.ts`).
- **Every number you report must come from a run you did.** State the machine (cores, RAM) and
  whether other jobs were running. If something failed or was skipped, say so. Do not round a
  miss into a pass.
- **Never miss a real answer.** Every pipeline that answers "who …" must be checked against a
  brute-force SGP4 truth. Recall below 100% is a failure to report and fix, not a footnote.
- **Report to the owner in plain words.** The owner is not a specialist and reads narrative
  paragraphs best. Define terms the first time. No walls of jargon.

## Setup (from the repo root)

```bash
git checkout spike/starmap
bash packages/backend/scripts/starmap/setup-env.sh     # npm install, build libs, fetch ~1 GB of data
bash packages/backend/scripts/starmap/setup-db.sh      # only for DB tasks; prints an export line
export STARMAP_DB=postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch
bash packages/backend/scripts/starmap/check.sh         # must print "starmap check: OK"
```

Requirements: Node ≥ 20 (the Mac used Node 26). About 6 GB free disk for data and outputs
(coverage files can be large; see TASKS). For DB tasks, Postgres 16 + TimescaleDB 2.x.
`setup-db.sh` tries Docker first, then apt.

Data lands in the gitignored folder `packages/backend/data/`:
- `tle-cache.json`: the live catalog, a JSON array.
- `history/catalog-YYYY-MM-DD.json`: the catalog as it was on each day.

If `fetch-data.sh` fails for a day, retry once, then continue without that day and say so.

## How to work

- Pick task cards in the order TASKS.md gives. T1 and T2 may run in parallel by two agents if
  the machine has 16+ cores. Give each about half the cores with `--workers`.
- Before writing code, read the files the card lists. Reuse existing helpers (listed in
  CONTEXT.md) rather than writing new SGP4 or geometry code.
- Run `check.sh` before every commit. Do not commit generated data (it lives in gitignored
  folders).
- When a card is done, append its results to `design/marvin/STARMAP.md` under a new heading
  (`## Round 4 — <card>`). Commit the code and the doc together.
- If a run will take more than ~2 hours, first run it on a smaller slice, report the per-day
  rate, and extrapolate. Then decide whether the full run is worth it, and say why.
