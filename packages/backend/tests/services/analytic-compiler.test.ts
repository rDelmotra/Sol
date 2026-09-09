// P2/S2 — compiler service tests (my_plans/marvin/perceptor_p2_plan.md S2).
// The LLM is faked; nothing touches the network or disk (persist:false).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createAnalyticCompiler,
  type LlmCall,
  type LlmMessage,
  type LlmToolCall,
} from '../../src/services/analytic-compiler.js';
import type { Gazetteer, GazetteerHit } from '../../src/services/gazetteer.js';

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

describe('AnalyticCompiler.logGap (reused writer, P3 hollow-answer defect fix)', () => {
  it('appends a hollow entry to the same gap-log.jsonl the compile path writes to', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-gaplog-'));
    try {
      const c = createAnalyticCompiler({ dataDir, persist: true });
      c.logGap?.({
        question: 'satellites owned by amazon',
        kind: 'hollow',
        code: 'E-ZERO-MATCH',
        fields: [],
        matched: 0,
        scanned: 12345,
      });
      const gapLogPath = path.join(dataDir, 'gap-log.jsonl');
      const lines = fs.readFileSync(gapLogPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.kind, 'hollow');
      assert.equal(entry.code, 'E-ZERO-MATCH');
      assert.equal(entry.matched, 0);
      assert.equal(entry.scanned, 12345);
      assert.equal(entry.question, 'satellites owned by amazon');
      assert.ok(typeof entry.ts === 'string' && !Number.isNaN(Date.parse(entry.ts)));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('is best-effort: a write failure (unwritable dataDir) never throws', async () => {
    // Point dataDir at a path that can't be created (a file, not a directory,
    // as an intermediate segment) so fs.mkdirSync/appendFileSync fail.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-gaplog-fail-'));
    const blockerFile = path.join(tmp, 'blocker');
    fs.writeFileSync(blockerFile, 'x');
    const unwritableDataDir = path.join(blockerFile, 'nested', 'data'); // 'blocker' is a file, not a dir
    try {
      const c = createAnalyticCompiler({ dataDir: unwritableDataDir, persist: true });
      assert.doesNotThrow(() => {
        c.logGap?.({ question: 'q', kind: 'hollow', code: 'E-ZERO-MATCH', matched: 0, scanned: 0 });
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('persist:false never writes to disk', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-gaplog-nopersist-'));
    try {
      const c = createAnalyticCompiler({ dataDir, persist: false });
      c.logGap?.({ question: 'q', kind: 'hollow', code: 'E-ZERO-MATCH', matched: 0, scanned: 0 });
      assert.equal(fs.existsSync(path.join(dataDir, 'gap-log.jsonl')), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Place-name grounding (gazetteer defect fix). The LLM is faked exactly as
// above; the gazetteer is ALSO faked (an injected `Gazetteer`) so these tests
// never touch the network either — see services/gazetteer.ts for the real
// implementation and tests/services/gazetteer.test.ts for its own coverage.
// ============================================================

const SYDNEY_HIT: GazetteerHit = {
  name: 'Sydney',
  latDeg: -33.8714,
  lonDeg: 151.2125,
  countryName: 'Australia',
  admin1: 'New South Wales',
  population: 4630000,
  sourceId: 'ne:syd-au',
  ambiguousWith: {
    name: 'Sydney',
    countryName: 'Canada',
    admin1: 'Nova Scotia',
    population: 37538,
  },
};

function fakeGazetteer(hits: Record<string, GazetteerHit>, opts: { version?: string } = {}): Gazetteer {
  return {
    async ensureReady() {},
    resolvePlace: (name: string) => hits[name] ?? null,
    getVersion: () => opts.version ?? 'fixture-v1',
  };
}

describe('place-name grounding (gazetteer)', () => {
  it('DEMONSTRATION: "visible from Sydney" produces a user turn containing the Natural Earth coordinates (151.2125), not a model guess', async () => {
    const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
    const c = createAnalyticCompiler({
      llmCall: llm.fn,
      persist: false,
      gazetteer: fakeGazetteer({ Sydney: SYDNEY_HIT }),
    });

    await c.compile('Which satellites are visible from Sydney right now?');

    const sentContent = llm.calls[0].messages[0].content as string;
    assert.ok(sentContent.includes('(resolved places:'), 'expected a resolved-places line in the user turn');
    assert.ok(sentContent.includes('151.2125'), 'expected the Natural Earth longitude verbatim');
    assert.ok(sentContent.includes('33.8714'), 'expected the Natural Earth latitude verbatim');
    assert.ok(sentContent.includes('Natural Earth'), 'expected the source to be named');
    assert.ok(sentContent.includes('pop 4630000'), 'expected the measured population');
    assert.ok(sentContent.includes('also matches'), 'expected the Nova Scotia ambiguity to be disclosed, not silently dropped');
    assert.ok(sentContent.includes('37538'), 'expected the runner-up population');
  });

  it('produces a BYTE-IDENTICAL user turn to the pre-grounding format when the question has no place candidates', async () => {
    const fixedNow = new Date('2026-09-09T12:00:00.000Z').getTime();
    const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
    const gaz: Gazetteer = {
      async ensureReady() {
        throw new Error('must not be called for a place-free question');
      },
      resolvePlace: () => {
        throw new Error('must not be called for a place-free question');
      },
      getVersion: () => 'should-not-matter',
    };
    const c = createAnalyticCompiler({ llmCall: llm.fn, persist: false, gazetteer: gaz, nowMs: () => fixedNow });

    const question = 'Which satellites are slowing down?';
    await c.compile(question);

    const sentContent = llm.calls[0].messages[0].content;
    assert.equal(sentContent, `${question}\n(current UTC time: ${new Date(fixedNow).toISOString()})`);
  });

  it('CRITICAL: a grounded and an ungrounded compile of the SAME place-mentioning question never share a cache entry', async () => {
    const llm = fakeLlm([toolCall({ program: VALID_PROGRAM }), toolCall({ program: VALID_PROGRAM })]);
    let version = 'unloaded';
    const gaz: Gazetteer = {
      async ensureReady() {},
      resolvePlace: () => null, // resolution result is irrelevant here; only the version marker changes
      getVersion: () => version,
    };
    const c = createAnalyticCompiler({ llmCall: llm.fn, persist: false, gazetteer: gaz });

    const q = 'Which satellites are visible from Sydney right now?';
    const a = await c.compile(q);
    assert.ok(a.ok && !a.cached);

    version = '2026-09-08T00:00:00.000Z'; // simulates the gazetteer finishing its first real load
    const b = await c.compile(q);
    assert.ok(b.ok && !b.cached, 'a gazetteer state change must bust the cache, never silently reuse the differently-grounded compile');
    assert.equal(llm.count(), 2, 'both compiles must hit the LLM — they must not share a cache key');
  });

  it('a PLACE-FREE question stays cached across a gazetteer version change (the common case keeps full cache efficiency)', async () => {
    const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
    let version = 'v-a';
    const gaz: Gazetteer = { async ensureReady() {}, resolvePlace: () => null, getVersion: () => version };
    const c = createAnalyticCompiler({ llmCall: llm.fn, persist: false, gazetteer: gaz });

    const q = 'Which satellites are slowing down?';
    await c.compile(q);
    version = 'v-b'; // this question never looks at the gazetteer at all
    const second = await c.compile(q);
    assert.ok(second.ok && second.cached);
    assert.equal(llm.count(), 1, 'a place-free question must not be invalidated by gazetteer version churn');
  });

  it('logs an unresolved place candidate to gap-log.jsonl with kind "unresolved-place" (measures the real miss rate)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-gaplog-place-'));
    try {
      const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
      const gaz = fakeGazetteer({}); // resolves nothing
      const c = createAnalyticCompiler({ llmCall: llm.fn, persist: true, dataDir, gazetteer: gaz });

      await c.compile('Which satellites are visible from Nowhereville right now?');

      const gapLogPath = path.join(dataDir, 'gap-log.jsonl');
      const entries = fs
        .readFileSync(gapLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; code: string; reason?: string; question: string });
      const placeEntry = entries.find((e) => e.kind === 'unresolved-place');
      assert.ok(placeEntry, 'expected an unresolved-place gap entry');
      assert.equal(placeEntry!.code, 'GAZETTEER_MISS');
      assert.equal(placeEntry!.reason, 'Nowhereville');
      assert.equal(placeEntry!.question, 'Which satellites are visible from Nowhereville right now?');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('a cache HIT does not re-resolve places or re-log gaps (mirrors the refused/invalid gap-log discipline)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-gaplog-place-hit-'));
    try {
      let resolveCalls = 0;
      const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
      const gaz: Gazetteer = {
        async ensureReady() {},
        resolvePlace: () => {
          resolveCalls += 1;
          return null;
        },
        getVersion: () => 'v1',
      };
      const c = createAnalyticCompiler({ llmCall: llm.fn, persist: true, dataDir, gazetteer: gaz });

      const q = 'Which satellites are visible from Nowhereville right now?';
      await c.compile(q);
      const afterFirst = resolveCalls;
      assert.ok(afterFirst > 0);

      await c.compile(q); // cache hit
      assert.equal(resolveCalls, afterFirst, 'resolvePlace must not be called again on a cache hit');
      assert.equal(llm.count(), 1);

      const gapLogPath = path.join(dataDir, 'gap-log.jsonl');
      const placeEntries = fs
        .readFileSync(gapLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string })
        .filter((e) => e.kind === 'unresolved-place');
      assert.equal(placeEntries.length, 1, 'the gap must be logged exactly once, not once per repeat ask');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does NOT gap-log n-gram fragments that overlap a candidate which DID resolve', async () => {
    // extractPlaceCandidates grows every 1–3 word n-gram from one anchor, so
    // "anything over New York City" yields ["New", "New York", "New York City"]
    // and only the middle one is in Natural Earth (verified against the real
    // 7,342-feature file). Filing GAZETTEER_MISS for the other two would make
    // the log measure the tokenizer rather than the gazetteer — and this log's
    // whole purpose is to supply the real miss rate that decides whether rule
    // 17 later becomes a refusal. A fabricated number there is worse than none.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-gaplog-ngram-'));
    try {
      const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
      const gaz = fakeGazetteer({ 'New York': SYDNEY_HIT }); // only the middle n-gram resolves
      const c = createAnalyticCompiler({ llmCall: llm.fn, persist: true, dataDir, gazetteer: gaz });

      await c.compile('Which satellites are over New York City right now?');

      const gapLogPath = path.join(dataDir, 'gap-log.jsonl');
      const placeEntries = fs.existsSync(gapLogPath)
        ? fs
            .readFileSync(gapLogPath, 'utf8')
            .trim()
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { kind: string; reason?: string })
            .filter((e) => e.kind === 'unresolved-place')
        : [];

      assert.deepEqual(
        placeEntries.map((e) => e.reason),
        [],
        'neither "New" nor "New York City" is a real miss — "New York" resolved',
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('still gap-logs every candidate when NOTHING resolves (the suppression is overlap-scoped, not blanket)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-gaplog-allmiss-'));
    try {
      const llm = fakeLlm([toolCall({ program: VALID_PROGRAM })]);
      const c = createAnalyticCompiler({
        llmCall: llm.fn,
        persist: true,
        dataDir,
        gazetteer: fakeGazetteer({}), // resolves nothing
      });

      await c.compile('Which satellites are over New York City right now?');

      const reasons = fs
        .readFileSync(path.join(dataDir, 'gap-log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; reason?: string })
        .filter((e) => e.kind === 'unresolved-place')
        .map((e) => e.reason);

      assert.ok(reasons.includes('New York City'), 'a genuine total miss must still be recorded');
      assert.ok(reasons.length > 1, 'with no hit to overlap, every candidate is a real miss');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
