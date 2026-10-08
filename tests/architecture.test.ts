// ============================================================
// Architecture test — the monorepo's import rules, enforced.
//
// Every rule below is a boundary the codebase already relies on (see CLAUDE.md
// "Dependency rule" / "Module / layer boundary rules" and
// PROJECT_MAP/14_CLEANUP_AND_REFACTOR_PLAN.md). Known violations are listed in
// KNOWN_VIOLATIONS with the refactor step that removes them. The list is a
// ratchet: a violation not on it fails the test, and an entry that no longer
// matches a real import ALSO fails ("stale"), so the list can only shrink.
//
// Scope: production source (packages/*/src, *.test.ts excluded). Imports are
// read with the TypeScript scanner (ts.preProcessFile), so comments, strings
// and type-only imports are handled correctly — type-only imports count: they
// couple modules just the same.
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['contracts', 'orbital-core', 'analytic', 'backend', 'frontend'] as const;
type Pkg = (typeof PACKAGES)[number];

// ── Zones ─────────────────────────────────────────────────────────────────────
// A zone is the unit rules talk about: a top-level folder under src/ (frontend
// engine/ is split into its tiers). Package imports are zoned as `pkg:<name>`.

function zoneOf(pkg: Pkg, absFile: string): string {
  const rel = path.relative(path.join(REPO, 'packages', pkg, 'src'), absFile).split(path.sep);
  if (rel.length === 1) return '(root)';
  if (pkg === 'frontend' && rel[0] === 'engine') {
    if (rel[1] === 'world' && rel[2] === 'layers') return 'engine/world/layers';
    if (rel.length > 2 && ['render', 'world', 'tle', 'dso'].includes(rel[1])) return `engine/${rel[1]}`;
    return 'engine';
  }
  return rel[0];
}

interface Edge {
  pkg: Pkg;
  from: string;      // repo-relative source file
  fromZone: string;
  to: string;        // repo-relative target (no extension) or `pkg:<name>`
  toZone: string;    // zone within the same package, `pkg:<name>`, or `outside`
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function collectEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const pkg of PACKAGES) {
    const srcRoot = path.join(REPO, 'packages', pkg, 'src');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
      });
    for (const file of walk(srcRoot)) {
      const info = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
      for (const { fileName } of info.importedFiles) {
        const spec = fileName.replace(/\?.*$/, ''); // Vite suffixes (?raw, ?worker)
        const edge: Edge = {
          pkg,
          from: path.relative(REPO, file),
          fromZone: zoneOf(pkg, file),
          to: '',
          toZone: '',
        };
        if (spec.startsWith('.')) {
          const abs = path.resolve(path.dirname(file), spec).replace(/\.(js|ts|tsx)$/, '');
          edge.to = path.relative(REPO, abs);
          edge.toZone = abs.startsWith(srcRoot + path.sep) ? zoneOf(pkg, abs) : 'outside';
        } else {
          edge.to = edge.toZone = `pkg:${packageName(spec)}`;
        }
        edges.push(edge);
      }
    }
  }
  return edges;
}

// ── Rules ─────────────────────────────────────────────────────────────────────

interface Rule {
  id: string;
  why: string;
  applies: (e: Edge) => boolean;
  forbidden: (e: Edge) => boolean;
}

const isEngine = (z: string) => z === 'engine' || z.startsWith('engine/');
const only = (...zones: string[]) => (e: Edge) => !e.toZone.startsWith('pkg:') && !zones.includes(e.toZone);
const from = (pkg: Pkg, ...zones: string[]) => (e: Edge) => e.pkg === pkg && zones.includes(e.fromZone);

const RULES: Rule[] = [
  // ── cross-package ──
  {
    id: 'no-cross-package-relative',
    why: 'Packages share code through package imports (@orbitwatch/*), never by reaching into another package\'s files.',
    applies: () => true,
    forbidden: (e) => e.toZone === 'outside',
  },
  {
    id: 'orbital-core-is-pure',
    why: 'packages/orbital-core is the one home for physics: zero imports (no three.js, no satellite.js, no node:*, no other @orbitwatch package) — a leaf every runtime can load.',
    applies: (e) => e.pkg === 'orbital-core',
    forbidden: (e) => e.toZone.startsWith('pkg:'),
  },
  {
    id: 'contracts-is-leaf',
    why: 'packages/contracts is the one home for shared domain/wire types: no @orbitwatch package imports, and satellite.js only as a type-only re-export (OMMJsonObject) — never a second runtime dependency.',
    applies: (e) => e.pkg === 'contracts',
    forbidden: (e) => e.toZone.startsWith('pkg:') && e.toZone !== 'pkg:satellite.js',
  },
  {
    id: 'analytic-is-pure',
    why: 'packages/analytic is the pure IR core: no I/O and no runtime dependencies beyond the shared leaf packages.',
    applies: (e) => e.pkg === 'analytic',
    forbidden: (e) =>
      e.toZone.startsWith('pkg:') &&
      e.toZone !== 'pkg:@orbitwatch/orbital-core' &&
      e.toZone !== 'pkg:@orbitwatch/contracts',
  },

  // ── frontend tiers: core ← render ← data ← layers ← world ← controllers ← Engine ──
  {
    id: 'fe-orbital-is-core',
    why: 'orbital/ is the pure physics tier: no app, render or UI imports (three.js is being removed in Phase 2.3).',
    applies: from('frontend', 'orbital'),
    forbidden: (e) => only('orbital')(e) || ['pkg:three', 'pkg:react', 'pkg:zustand'].includes(e.toZone),
  },
  {
    id: 'fe-time-is-leaf',
    why: 'time/ is the lowest frontend tier (the simulation clock singleton): it imports nothing from the app.',
    applies: from('frontend', 'time'),
    forbidden: only('time'),
  },
  {
    id: 'fe-query-no-app',
    why: 'query/ is logic over data + orbital: it must not reach into the engine, store or UI.',
    applies: from('frontend', 'query'),
    forbidden: (e) => isEngine(e.toZone) || ['store', 'ui', 'workers', 'pkg:three'].includes(e.toZone),
  },
  {
    id: 'fe-data-no-app',
    why: 'data/ fetches and shapes data; it never imports the engine, UI or query tiers, and returns data instead of writing the store.',
    applies: from('frontend', 'data'),
    forbidden: (e) => isEngine(e.toZone) || ['ui', 'query', 'workers', 'store'].includes(e.toZone),
  },
  {
    id: 'fe-store-no-engine',
    why: 'The store sits below the engine and the UI; it must not import either.',
    applies: from('frontend', 'store'),
    forbidden: (e) => isEngine(e.toZone) || e.toZone === 'ui',
  },
  {
    id: 'fe-workers-isolated',
    why: 'Web workers run in their own bundle: no engine, store, UI or query imports.',
    applies: from('frontend', 'workers'),
    forbidden: (e) => isEngine(e.toZone) || ['store', 'ui', 'query'].includes(e.toZone),
  },
  {
    id: 'fe-ui-no-engine',
    why: 'UI talks to the engine only through the store (EngineCommands), never by import.',
    applies: from('frontend', 'ui'),
    forbidden: (e) => isEngine(e.toZone) || e.toZone === 'workers',
  },
  {
    id: 'fe-layers-never-import-layers',
    why: 'Layers never import other layers; cross-layer wiring goes through Engine callbacks.',
    applies: from('frontend', 'engine/world/layers'),
    forbidden: (e) => e.toZone === 'engine/world/layers',
  },
  {
    id: 'fe-layers-no-query-ui',
    why: 'Layers render; they do not own query execution or UI.',
    applies: from('frontend', 'engine/world/layers'),
    forbidden: (e) => ['query', 'ui'].includes(e.toZone),
  },
  {
    id: 'fe-worker-clients-no-store',
    why: 'Worker clients (engine/tle, engine/dso) sit below the layers; state reaches them through their owning layer.',
    applies: from('frontend', 'engine/tle', 'engine/dso'),
    forbidden: (e) => ['store', 'ui'].includes(e.toZone),
  },
  {
    id: 'fe-render-world-are-infrastructure',
    why: 'engine/render and engine/world (World.ts) are generic infrastructure: they know no renderers, layers or app state.',
    applies: from('frontend', 'engine/render', 'engine/world'),
    forbidden: (e) => (isEngine(e.toZone) && e.toZone !== 'engine/render') || ['store', 'data', 'query', 'ui'].includes(e.toZone),
  },

  // ── backend ──
  {
    id: 'be-dso-isolated',
    why: 'dso/ is a self-contained namespace (own worker process): only dso/ and utils/.',
    applies: from('backend', 'dso'),
    forbidden: only('dso', 'utils'),
  },
  {
    id: 'be-history-isolated',
    why: 'history/ is optional and fail-soft: only history/, types/ and utils/.',
    applies: from('backend', 'history'),
    forbidden: only('history', 'types', 'utils'),
  },
  {
    id: 'be-enrichment-isolated',
    why: 'enrichment/ is the static metadata plane: only enrichment/ and utils/.',
    applies: from('backend', 'enrichment'),
    forbidden: only('enrichment', 'utils'),
  },
  {
    id: 'be-routes-cron-are-top',
    why: 'routes/ and cron/ are entry points: only the composition root (index.ts) wires them.',
    applies: (e) => e.pkg === 'backend' && e.fromZone !== '(root)',
    forbidden: (e) => e.toZone === 'cron' || (e.toZone === 'routes' && e.fromZone !== 'routes'),
  },
  {
    id: 'be-low-tiers-stay-low',
    why: 'cache/, utils/ and types/ are the bottom tier: they import no feature modules.',
    applies: from('backend', 'cache', 'utils', 'types'),
    forbidden: (e) => ['services', 'analytic', 'routes', 'cron', 'history', 'dso', 'eval', 'enrichment'].includes(e.toZone),
  },
  {
    id: 'be-services-no-analytic',
    why: 'services/ are fetchers + the compiler; the analytic registry depends on them, not the reverse (inject what they need).',
    applies: from('backend', 'services'),
    forbidden: (e) => e.toZone === 'analytic',
  },
];

// ── Known violations (the ratchet) ────────────────────────────────────────────
// Each entry: exact file → exact import target, and the plan step that fixes it.

interface KnownViolation { rule: string; from: string; to: string; fix: string }

const FE = 'packages/frontend/src';
const BE = 'packages/backend/src';

const KNOWN_VIOLATIONS: KnownViolation[] = [
  // data clients write the store directly
  { rule: 'fe-data-no-app', from: `${FE}/data/dso-client.ts`, to: `${FE}/store/useStore`, fix: '2.7 data clients return data' },
  { rule: 'fe-data-no-app', from: `${FE}/data/bootstrapCatalog.ts`, to: `${FE}/store/useStore`, fix: '2.7 data clients return data' },
  // store imports engine modules
  { rule: 'fe-store-no-engine', from: `${FE}/store/useStore.ts`, to: `${FE}/engine/DsoRenderer`, fix: '2.6 R3 DsoLabelPosition → data/' },
  // worker imports its protocol from engine/
  { rule: 'fe-workers-isolated', from: `${FE}/workers/dso.worker.ts`, to: `${FE}/engine/dso/dso-worker-types`, fix: '2.6 R3 shared worker protocol file' },
  // UI imports the sim clock from engine/
  // SatellitesLayer builds the analytic live source
  { rule: 'fe-layers-no-query-ui', from: `${FE}/engine/world/layers/SatellitesLayer.ts`, to: `${FE}/query/analytic/live-source`, fix: '2.6 AnalyticRuntime extraction' },
  { rule: 'fe-layers-no-query-ui', from: `${FE}/engine/world/layers/SatellitesLayer.ts`, to: `${FE}/query/vocab`, fix: '2.6 AnalyticRuntime extraction' },
  // DsoWorkerClient reads the store below the layer tier
  { rule: 'fe-worker-clients-no-store', from: `${FE}/engine/dso/DsoWorkerClient.ts`, to: `${FE}/store/useStore`, fix: '2.6 R3-D thread via DsoLayer getter' },
  // backend dependency-direction debt
  { rule: 'be-services-no-analytic', from: `${BE}/services/analytic-prompt.ts`, to: `${BE}/analytic/index`, fix: '2.5 inject the registry snapshot' },
  { rule: 'be-services-no-analytic', from: `${BE}/services/analytic-prompt.ts`, to: `${BE}/analytic/types`, fix: '2.5 inject the registry snapshot' },
];

// ── Test ──────────────────────────────────────────────────────────────────────

describe('architecture — import rules', () => {
  const edges = collectEdges();
  const key = (rule: string, e: { from: string; to: string }) => `${rule} | ${e.from} → ${e.to}`;

  const found = new Map<string, { rule: Rule; edge: Edge }>();
  for (const edge of edges) {
    for (const rule of RULES) {
      if (rule.applies(edge) && rule.forbidden(edge)) found.set(key(rule.id, edge), { rule, edge });
    }
  }
  const known = new Set(KNOWN_VIOLATIONS.map((v) => key(v.rule, v)));

  it('scans a non-trivial number of imports (sanity)', () => {
    assert.ok(edges.length > 500, `only ${edges.length} imports found — is the scanner broken?`);
  });

  it('every rule id in KNOWN_VIOLATIONS exists', () => {
    const ids = new Set(RULES.map((r) => r.id));
    for (const v of KNOWN_VIOLATIONS) assert.ok(ids.has(v.rule), `unknown rule id '${v.rule}'`);
  });

  it('no new boundary violations', () => {
    const fresh = [...found].filter(([k]) => !known.has(k));
    assert.equal(
      fresh.length, 0,
      'New import-boundary violations:\n' +
        fresh.map(([, { rule, edge }]) => `  [${rule.id}] ${edge.from} → ${edge.to}\n      ${rule.why}`).join('\n'),
    );
  });

  it('no stale KNOWN_VIOLATIONS entries (the list only shrinks)', () => {
    const stale = KNOWN_VIOLATIONS.filter((v) => !found.has(key(v.rule, v)));
    assert.equal(
      stale.length, 0,
      'These known violations are fixed — delete their KNOWN_VIOLATIONS entries:\n' +
        stale.map((v) => `  [${v.rule}] ${v.from} → ${v.to}`).join('\n'),
    );
  });
});
