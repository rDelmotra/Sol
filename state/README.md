# state/ — read this first

These files let a person or an agent understand Orbitwatch in a few minutes.
They replace a full recon of the repo.
They are tool-neutral. Any human or any AI agent can use them.

## Read order

1. `STATE.md` — what is true right now. Changes often.
2. `MAP.md` — how the code is laid out and where to change things. Changes rarely.
3. `DECISIONS.md` — choices the owner made, and why. Append only.
4. `OPEN.md` — known problems and deferred work. Items leave when fixed.

Read 1 and 2 for any task. Read 3 and 4 when a task touches a decision or a known problem.

## Rules for keeping them true

- Update `STATE.md` in the same commit as any change that alters it.
  That means a new commit milestone, a new test count, a finished or newly opened item.
- Update `MAP.md` when a file or folder moves, appears or disappears.
- Add to `DECISIONS.md` when the owner decides something that code alone can't show.
  Never rewrite an old entry. Add a new one that supersedes it.
- Remove an item from `OPEN.md` when it is fixed. Git history keeps the record.
- Facts only. No plans in `STATE.md` or `MAP.md`. Plans live in `OPEN.md`.
- Every repo path written in backticks in `MAP.md` must exist.
  `tests/state.test.ts` checks this, so stale paths fail `npm run test`.

## What is deliberately not here

- Per-file API docs. Read the source. Each file has a header comment.
- Import rules. `tests/architecture.test.ts` holds them as data. It is the source of truth.
- Secrets. Never write keys, tokens or `.env` contents in any file here.
