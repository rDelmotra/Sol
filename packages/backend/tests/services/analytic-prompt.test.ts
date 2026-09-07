// P2/S1 + P3/S6 — prompt generator tests.
// Spec: my_plans/marvin/perceptor_p2_plan.md S1, my_plans/marvin/p3/S6_prompt_truthing.md.
//
// S6 replaced hand-coded field servedness/coverage with numbers MEASURED at
// boot (DataSourceRegistry.snapshot()) — these tests use a FIXTURE snapshot
// throughout (deterministic, no data/tle-cache.json needed) rather than the
// real registry singleton, per the spec's explicit portability requirement.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { FIELD_REGISTRY, FN_SPECS, validateProgram, type Universe } from '@orbitwatch/analytic';
import { buildCompilerSystemPrompt, getPromptVersion } from '../../src/services/analytic-prompt.js';
import type { RegistrySnapshot, FieldCapability } from '../../src/analytic/types.js';

// ── Fixture snapshot builder ──────────────────────────────────────────────────
//
// Defaults every field to full (1.0) coverage on the universe(s) it can
// naturally appear on (live-plane fields never appear on 'all' — the real
// validator forbids referencing them under universe 'all'). `overrides` sets
// specific fields' measured coverage; `omit` drops a field from BOTH universes
// entirely (the "no provider claims it" case); `degradedLive` zeroes every
// live-universe entry (simulates an empty spine at boot).

function makeSnapshot(opts: {
  overrides?: Record<string, { live?: number; all?: number }>;
  omit?: string[];
  degradedLive?: boolean;
  liveSpineSize?: number;
} = {}): RegistrySnapshot {
  const omit = new Set(opts.omit ?? []);
  const overrides = opts.overrides ?? {};
  const liveFields: FieldCapability[] = [];
  const allFields: FieldCapability[] = [];

  for (const [name, spec] of Object.entries(FIELD_REGISTRY)) {
    if (omit.has(name)) continue;
    const ov = overrides[name];
    liveFields.push({ field: name, servedBy: 'fixture', coverage: ov?.live ?? 1 });
    if (spec.plane !== 'live') {
      allFields.push({ field: name, servedBy: 'fixture', coverage: ov?.all ?? 1 });
    }
  }

  if (opts.degradedLive) {
    for (const f of liveFields) f.coverage = 0;
  }

  return {
    measuredAt: new Date(0).toISOString(),
    universes: [
      { universe: 'live' as Universe, spineSize: opts.liveSpineSize ?? 32000, fields: liveFields, fns: [] },
      { universe: 'all' as Universe, spineSize: 70000, fields: allFields, fns: [] },
    ],
  };
}

const FIXTURE = makeSnapshot();

describe('buildCompilerSystemPrompt', () => {
  const prompt = buildCompilerSystemPrompt(FIXTURE);

  it('contains every FIELD_REGISTRY key', () => {
    for (const name of Object.keys(FIELD_REGISTRY)) {
      assert.ok(prompt.includes(`- ${name} (`), `field '${name}' missing from prompt`);
    }
  });

  it('contains every physics function', () => {
    for (const name of Object.keys(FN_SPECS)) {
      assert.ok(prompt.includes(name), `fn '${name}' missing from prompt`);
    }
  });

  it('states the P1 noise-threshold lesson and the actively-taught refusal codes', () => {
    assert.ok(prompt.includes('1e-5'));
    for (const code of ['NEEDS_HISTORY', 'OFF_DOMAIN', 'NOT_DERIVABLE']) {
      assert.ok(prompt.includes(code), `refusal code ${code} missing`);
    }
  });

  it("P3 S6: NEEDS_ALL_UNIVERSE is no longer taught (universe 'all' is now a first-class emit, not a refusal) — the code itself stays valid contract, just rare/unreachable via this prompt", () => {
    assert.ok(!prompt.includes('NEEDS_ALL_UNIVERSE'));
  });

  it('is deterministic (two calls with the same snapshot are identical)', () => {
    assert.equal(buildCompilerSystemPrompt(FIXTURE), prompt);
  });

  it('every few-shot program in the prompt validates against the frozen validator', () => {
    // Extract the example tool-call JSON blocks and re-validate any embedded program —
    // the prompt must never teach the model an invalid program.
    const blocks = prompt.split('Tool call input:\n').slice(1);
    assert.ok(blocks.length >= 8, 'expected at least 8 few-shot examples');
    let programs = 0;
    let refusals = 0;
    for (const block of blocks) {
      const json = block.split('\n\nExample')[0].trim();
      const emit = JSON.parse(json) as { program?: unknown; refuse?: { code: string; reason: string } };
      if (emit.program) {
        const res = validateProgram(emit.program);
        assert.ok(res.ok, `few-shot program invalid: ${JSON.stringify(!res.ok && res.issues)}`);
        programs += 1;
      } else {
        assert.ok(emit.refuse?.code && emit.refuse.reason, 'refusal example missing code/reason');
        refusals += 1;
      }
    }
    assert.ok(programs >= 6, 'expected ≥6 program examples');
    assert.equal(refusals, 2, 'expected exactly 2 refusal examples');
  });
});

describe('buildCompilerSystemPrompt — universe rewrite (P3 S6 Part C)', () => {
  const prompt = buildCompilerSystemPrompt(FIXTURE);

  it('the ROLE paragraph documents both universes', () => {
    assert.ok(prompt.includes('one of two universes'));
    assert.ok(prompt.includes('~32,000 currently tracked objects'));
    assert.ok(prompt.includes('~70,000 objects ever cataloged since 1957'));
  });

  it("hard rule 2 teaches choosing 'all' rather than refusing NEEDS_ALL_UNIVERSE", () => {
    assert.ok(prompt.includes('Choose the universe: "live" (the default)'));
    assert.ok(prompt.includes('since 1957'));
  });

  it('the grammar envelope allows both universe values', () => {
    assert.ok(prompt.includes('"universe": "live" | "all"'));
  });

  it("rule 14's growth-count addendum documents the 'all'-universe survivorship fix", () => {
    assert.ok(prompt.includes('the survivorship caveat disappears'));
  });
});

describe("buildCompilerSystemPrompt — few-shots (P3 S6 Part D)", () => {
  const prompt = buildCompilerSystemPrompt(FIXTURE);

  it("includes the flagship 'all'-universe launched-per-year unlock", () => {
    assert.ok(prompt.includes('How many objects were launched per year since 1957?'));
  });

  it("the debris-growth-since-2000 example now compiles (universe 'all'), not a refusal", () => {
    const idx = prompt.indexOf('How has the amount of debris grown since 2000?');
    assert.ok(idx >= 0);
    const exampleBlock = prompt.slice(idx, idx + 800);
    assert.ok(exampleBlock.includes('"universe": "all"'));
    assert.ok(!exampleBlock.includes('"refuse"'));
  });

  it('keeps exactly one NEEDS_HISTORY refusal few-shot (the replacement "raised their orbit" example)', () => {
    assert.ok(prompt.includes('Which satellites raised their orbit last week?'));
    const examplesSection = prompt.slice(prompt.indexOf('EXAMPLES ('));
    const matches = examplesSection.match(/NEEDS_HISTORY/g) ?? [];
    assert.equal(matches.length, 1, 'expected exactly one NEEDS_HISTORY few-shot refusal');
  });
});

describe('buildCompilerSystemPrompt — measured coverage rendering (P3 S6 Part B)', () => {
  it('renders the MEASURED snapshot percentage, not schema.ts\'s static coverage value', () => {
    // schema.ts says operationalStatus=39.2%, launchMassKg=53.8% — pick fixture
    // values that round to visibly DIFFERENT whole percents to prove the source.
    const snap = makeSnapshot({ overrides: { operationalStatus: { all: 0.61 }, launchMassKg: { all: 0.20 } } });
    const prompt = buildCompilerSystemPrompt(snap);
    assert.ok(prompt.includes('coverage 61%'), 'should show the fixture-measured 61%, not schema.ts\'s 39%');
    assert.ok(!prompt.includes('coverage 39%'), 'must not render the stale schema.ts static value');
    assert.ok(prompt.includes('coverage 20%'), 'should show the fixture-measured 20%, not schema.ts\'s 54%');
    assert.ok(!prompt.includes('coverage 54%'), 'must not render the stale schema.ts static value');
    // Measured >0 on 'all' (and full on 'live' by fixture default) — not UNSERVED.
    assert.ok(!/- operationalStatus \([^)]*UNSERVED/.test(prompt));
  });

  it('a field with 0 measured coverage on BOTH universes gets the UNSERVED annotation', () => {
    const snap = makeSnapshot({ overrides: { owner: { live: 0, all: 0 } } });
    const prompt = buildCompilerSystemPrompt(snap);
    assert.ok(/- owner \([^)]*UNSERVED — always null, see note\)/.test(prompt));
    assert.ok(prompt.includes('have no data source wired up yet'), 'the genericized UNSERVED note must be present');
  });

  it('a field entirely ABSENT from the snapshot (no provider claims it) also renders UNSERVED — fallback rule', () => {
    const snap = makeSnapshot({ omit: ['cospar'] });
    const prompt = buildCompilerSystemPrompt(snap);
    assert.ok(/- cospar \([^)]*UNSERVED — always null, see note\)/.test(prompt));
  });

  it('a static-plane field measured on \'all\' but with 0 on \'live\' is still shown (not UNSERVED) — plane picks the display universe', () => {
    // launchMassKg is static-plane: its display number comes from 'all'. Zeroing
    // 'live' (which real static fields also don't strictly need) must not flip it
    // to UNSERVED as long as 'all' is nonzero.
    const snap = makeSnapshot({ overrides: { launchMassKg: { live: 0, all: 0.42 } } });
    const prompt = buildCompilerSystemPrompt(snap);
    assert.ok(prompt.includes('coverage 42%'));
    assert.ok(!/- launchMassKg \([^)]*UNSERVED/.test(prompt));
  });

  it('near-full coverage (>=95%) renders with no percentage annotation', () => {
    const snap = makeSnapshot({ overrides: { launchMassKg: { all: 0.97 } } });
    const prompt = buildCompilerSystemPrompt(snap);
    assert.ok(/- launchMassKg \([^)]*\)/.test(prompt));
    assert.ok(!/- launchMassKg \([^)]*coverage/.test(prompt));
  });

  it('an empty-live-spine (boot-degraded) fixture still builds a prompt without throwing', () => {
    const degraded = makeSnapshot({ degradedLive: true, liveSpineSize: 0 });
    assert.doesNotThrow(() => buildCompilerSystemPrompt(degraded));
    const prompt = buildCompilerSystemPrompt(degraded);
    assert.ok(prompt.includes('FIELD CATALOG'));
  });
});

describe('getPromptVersion', () => {
  it('is 12 hex chars derived from the prompt content', () => {
    const v = getPromptVersion(FIXTURE);
    assert.match(v, /^[0-9a-f]{12}$/);
    const expected = createHash('sha256').update(buildCompilerSystemPrompt(FIXTURE)).digest('hex').slice(0, 12);
    assert.equal(v, expected);
  });

  it('is memoized-stable across calls with the default (no-snapshot) signature', () => {
    assert.equal(getPromptVersion(), getPromptVersion());
  });

  it('changes when a rendered coverage percent differs (auto-bump proof)', () => {
    const a = makeSnapshot({ overrides: { launchMassKg: { all: 0.20 } } });
    const b = makeSnapshot({ overrides: { launchMassKg: { all: 0.55 } } });
    assert.notEqual(getPromptVersion(a), getPromptVersion(b));
  });

  it('is stable when two snapshots round to the same whole percent (cache-warmth proof)', () => {
    const a = makeSnapshot({ overrides: { launchMassKg: { all: 0.201 } } });
    const b = makeSnapshot({ overrides: { launchMassKg: { all: 0.204 } } });
    assert.equal(getPromptVersion(a), getPromptVersion(b));
  });
});
