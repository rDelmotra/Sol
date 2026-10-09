// ============================================================
// State-file drift test — keeps state/*.md true.
//
// Every repo path written in backticks (packages/…, tests/…, state/…) must
// exist, and every npm workspace must be named in MAP.md. Globs (*) and
// untracked-by-design paths are skipped. Stale state files fail `npm run test`.
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(REPO, 'state');
const PATH_TOKEN = /`((?:packages|tests|state)\/[^\s`*]+)`/g;
// Paths that are real but not tracked, so they may be absent in a fresh clone.
const UNTRACKED_OK = new Set(['packages/backend/.env']);

const stateFiles = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.md'));

describe('state files', () => {
  it('have the expected set', () => {
    for (const f of ['README.md', 'STATE.md', 'MAP.md', 'DECISIONS.md', 'OPEN.md']) {
      assert.ok(stateFiles.includes(f), `missing state/${f}`);
    }
  });

  for (const file of stateFiles) {
    it(`${file}: every backticked repo path exists`, () => {
      const text = fs.readFileSync(path.join(STATE_DIR, file), 'utf8');
      const missing: string[] = [];
      for (const m of text.matchAll(PATH_TOKEN)) {
        const rel = m[1].replace(/[.,:;)]+$/, '');
        if (UNTRACKED_OK.has(rel)) continue;
        if (!fs.existsSync(path.join(REPO, rel))) missing.push(rel);
      }
      assert.deepEqual(missing, [], `stale paths in state/${file}`);
    });
  }

  it('MAP.md names every npm workspace', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { workspaces: string[] };
    const map = fs.readFileSync(path.join(STATE_DIR, 'MAP.md'), 'utf8');
    for (const ws of pkg.workspaces) assert.ok(map.includes(`\`${ws}\``), `MAP.md does not name ${ws}`);
  });
});
