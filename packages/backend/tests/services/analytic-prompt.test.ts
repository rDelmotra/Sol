// P2/S1 — prompt generator tests (my_plans/marvin/perceptor_p2_plan.md S1).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { FIELD_REGISTRY, FN_SPECS, validateProgram } from '@orbitwatch/analytic';
import { buildCompilerSystemPrompt, getPromptVersion } from '../../src/services/analytic-prompt.js';

describe('buildCompilerSystemPrompt', () => {
  const prompt = buildCompilerSystemPrompt();

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

  it('surfaces low-coverage percentages but not near-full ones', () => {
    assert.ok(prompt.includes('coverage 39%'), 'operationalStatus 39% coverage should be shown');
    assert.ok(prompt.includes('coverage 54%'), 'launchMassKg 54% coverage should be shown');
    // 99.8%-coverage fields render without a coverage annotation
    assert.ok(/- launchTag \([^)]*\)/.test(prompt));
    assert.ok(!/- launchTag \([^)]*coverage/.test(prompt));
  });

  it('states the P1 noise-threshold lesson and the refusal codes', () => {
    assert.ok(prompt.includes('1e-5'));
    for (const code of ['NEEDS_ALL_UNIVERSE', 'NEEDS_HISTORY', 'OFF_DOMAIN', 'NOT_DERIVABLE']) {
      assert.ok(prompt.includes(code), `refusal code ${code} missing`);
    }
  });

  it('is deterministic (two calls identical)', () => {
    assert.equal(buildCompilerSystemPrompt(), prompt);
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

describe('getPromptVersion', () => {
  it('is 12 hex chars derived from the prompt content', () => {
    const v = getPromptVersion();
    assert.match(v, /^[0-9a-f]{12}$/);
    const expected = createHash('sha256').update(buildCompilerSystemPrompt()).digest('hex').slice(0, 12);
    assert.equal(v, expected);
  });

  it('is memoized-stable across calls', () => {
    assert.equal(getPromptVersion(), getPromptVersion());
  });
});
