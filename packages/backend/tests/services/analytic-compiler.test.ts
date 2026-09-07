// P2/S2 — compiler service tests (my_plans/marvin/perceptor_p2_plan.md S2).
// The LLM is faked; nothing touches the network or disk (persist:false).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAnalyticCompiler,
  type LlmCall,
  type LlmMessage,
  type LlmToolCall,
} from '../../src/services/analytic-compiler.js';

const VALID_PROGRAM = {
  v: 1,
  universe: 'live',
  timeBinding: { mode: 'now' },
  interpretation: 'decaying orbits: meanMotionDot above the 1e-5 noise threshold',
  pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'meanMotionDot' }, { lit: 1e-5 }] } }],
  output: { shape: 'ids' },
};

// 'LOW' is not in REGIME_DOMAIN → validator raises V-ENUM.
const INVALID_PROGRAM = {
  ...VALID_PROGRAM,
  pipeline: [{ op: 'filter', where: { op: 'in', field: 'regime', values: ['LOW'] } }],
};

function toolCall(emit: unknown): LlmToolCall {
  return {
    input: emit,
    toolUseId: 'tu_1',
    assistantContent: [{ type: 'tool_use', id: 'tu_1', name: 'emit_program', input: emit }],
    model: 'claude-haiku-4-5',
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function fakeLlm(responses: LlmToolCall[]) {
  const calls: { system: string; messages: LlmMessage[] }[] = [];
  let i = 0;
  const fn: LlmCall = async (p) => {
    calls.push(p);
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
  return { fn, calls, count: () => i };
}

describe('createAnalyticCompiler', () => {
  it('compiles a valid program on first try and caches it', async () => {
    const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
    const c = createAnalyticCompiler({ llmCall: llm.fn, persist: false });

    const a = await c.compile('Which satellites are slowing down?');
    assert.ok(a.ok && !a.cached);
    assert.equal(a.ok && a.interpretation.includes('1e-5'), true);

    const b = await c.compile('Which satellites are slowing down?');
    assert.ok(b.ok && b.cached);
    assert.equal(llm.count(), 1, 'second identical question must be a cache hit');
  });

  it('repairs once when the first program is invalid', async () => {
    const llm = fakeLlm([toolCall({ program: INVALID_PROGRAM }), toolCall({ program: VALID_PROGRAM })]);
    const c = createAnalyticCompiler({ llmCall: llm.fn, persist: false });

    const res = await c.compile('slowing down');
    assert.ok(res.ok, 'repair should yield a valid program');
    assert.equal(llm.count(), 2);

    // The repair round must feed the V-code back to the model.
    const repairTurn = llm.calls[1].messages.at(-1);
    const content = JSON.stringify(repairTurn?.content);
    assert.ok(content.includes('V-ENUM'), 'repair message must carry the validation code');
    assert.ok(content.includes('tu_1'), 'repair must reference the tool_use id');
  });

  it('returns kind:invalid (uncached) when both attempts fail', async () => {
    const llm = fakeLlm([toolCall({ program: INVALID_PROGRAM })]); // repeats → both invalid
    const c = createAnalyticCompiler({ llmCall: llm.fn, persist: false });

    const res = await c.compile('bad one');
    assert.ok(!res.ok && res.kind === 'invalid');
    assert.equal(llm.count(), 2);

    // Not cached: a repeat hits the LLM again (2 more calls).
    await c.compile('bad one');
    assert.equal(llm.count(), 4);
  });

  it('caches refusals', async () => {
    const llm = fakeLlm([toolCall({ refuse: { code: 'OFF_DOMAIN', reason: 'not derivable' } })]);
    const c = createAnalyticCompiler({ llmCall: llm.fn, persist: false });

    const a = await c.compile('which satellite is prettiest?');
    assert.ok(!a.ok && a.kind === 'refused' && a.code === 'OFF_DOMAIN' && !a.cached);

    const b = await c.compile('which satellite is prettiest?');
    assert.ok(!b.ok && b.kind === 'refused' && b.cached);
    assert.equal(llm.count(), 1);
  });

  it('is unavailable with no key and no injected llmCall', async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedGemini = process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const c = createAnalyticCompiler({ persist: false });
      const res = await c.compile('anything');
      assert.ok(!res.ok && res.kind === 'unavailable');
    } finally {
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
      if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
    }
  });

  it('normalizes questions so casing/whitespace/punctuation share a cache entry', async () => {
    const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
    const c = createAnalyticCompiler({ llmCall: llm.fn, persist: false });

    await c.compile('Which satellites are slowing down?');
    const second = await c.compile('  which   satellites are slowing down ');
    assert.ok(second.ok && second.cached);
    assert.equal(llm.count(), 1);
  });
});
