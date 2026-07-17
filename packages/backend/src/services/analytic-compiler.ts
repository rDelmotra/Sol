// ============================================================
// Analytic compiler service (P2/S2 — my_plans/marvin/perceptor_p2_plan.md).
//
// Turns a natural-language question into a validated Analytic IR program via a
// forced-tool-call LLM, with exactly one validator-driven repair round, a
// promptVersion-keyed cache (memory LRU + JSON file), and a gap log that seeds
// the awareness-model growth loop (perceptor_awareness_architecture.md §5–§6).
//
// The LLM is behind an injected seam (LlmCall) so tests never touch the network;
// createAnthropicLlmCall() is the production adapter over @anthropic-ai/sdk.
// ============================================================

import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateProgram, type AnalyticProgram, type ValidationIssue } from '@orbitwatch/analytic';
import { buildCompilerSystemPrompt, getPromptVersion } from './analytic-prompt.js';
import { logger } from '../utils/logger.js';

// ── Public outcome type ───────────────────────────────────────────────────────

export type CompileOutcome =
  | { ok: true; program: AnalyticProgram; interpretation: string; cached: boolean; tookMs: number }
  | { ok: false; kind: 'refused'; code: string; reason: string; cached: boolean }
  | { ok: false; kind: 'invalid'; issues: ValidationIssue[] }
  | { ok: false; kind: 'unavailable' };

// ── LLM seam ──────────────────────────────────────────────────────────────────
// Conversation blocks are opaque to the compiler; it only threads them back
// verbatim on the repair round. The real adapter maps these to SDK shapes.

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface LlmToolCall {
  /** The emit_program tool input: { program? } | { refuse? }. */
  input: unknown;
  /** tool_use block id — needed to build the tool_result on repair. */
  toolUseId: string;
  /** Raw assistant content, echoed back as an assistant turn on repair. */
  assistantContent: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type LlmCall = (params: { system: string; messages: LlmMessage[] }) => Promise<LlmToolCall>;

// ── Cache entry (only cacheable outcomes are persisted) ───────────────────────

type CachedEntry =
  | { kind: 'ok'; program: AnalyticProgram; interpretation: string }
  | { kind: 'refused'; code: string; reason: string };

interface CompilerDeps {
  /** Injected LLM. If omitted, the Anthropic adapter is used when a key exists. */
  llmCall?: LlmCall;
  /** Clock seam (ms since epoch). Defaults to Date.now. */
  nowMs?: () => number;
  /** Persist cache + gap log to disk. Default true; tests pass false. */
  persist?: boolean;
  /** Override the data directory (tests). */
  dataDir?: string;
}

const LRU_CAP = 500;
/** Read at call time (not import time) so dotenv load order can't swallow the override. */
const model = () => process.env.ANALYTIC_COMPILER_MODEL || 'claude-haiku-4-5';
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');

// ── Normalization + cache key ─────────────────────────────────────────────────

function normalize(question: string): string {
  return question.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[?.!]+$/, '').trim();
}

function cacheKey(normalized: string): string {
  return createHash('sha256').update(`${getPromptVersion()}\n${normalized}`).digest('hex');
}

// ── Tool schema (forced) ──────────────────────────────────────────────────────

export const EMIT_PROGRAM_TOOL = {
  name: 'emit_program',
  description:
    'Emit either a compiled Analytic IR program OR a refusal. Provide exactly one of program/refuse.',
  input_schema: {
    type: 'object' as const,
    properties: {
      program: { type: 'object' as const, description: 'The Analytic IR v1 program.' },
      refuse: {
        type: 'object' as const,
        properties: {
          code: { type: 'string' as const },
          reason: { type: 'string' as const },
        },
        required: ['code', 'reason'],
      },
    },
  },
};

// ── Parse the tool input ──────────────────────────────────────────────────────

type ParsedEmit =
  | { kind: 'program'; program: unknown }
  | { kind: 'refuse'; code: string; reason: string }
  | { kind: 'malformed'; message: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parseEmit(input: unknown): ParsedEmit {
  if (!isRecord(input)) return { kind: 'malformed', message: 'tool input was not an object' };
  if (isRecord(input.refuse)) {
    const { code, reason } = input.refuse;
    if (typeof code === 'string' && typeof reason === 'string') return { kind: 'refuse', code, reason };
    return { kind: 'malformed', message: 'refuse must have string code and reason' };
  }
  if ('program' in input && input.program !== undefined) return { kind: 'program', program: input.program };
  return { kind: 'malformed', message: 'tool call had neither program nor refuse' };
}

// ── The compiler ──────────────────────────────────────────────────────────────

export interface AnalyticCompiler {
  compile(question: string): Promise<CompileOutcome>;
}

export function createAnalyticCompiler(deps: CompilerDeps = {}): AnalyticCompiler {
  const nowMs = deps.nowMs ?? Date.now;
  const persist = deps.persist ?? true;
  const dataDir = deps.dataDir ?? DEFAULT_DATA_DIR;
  const cachePath = path.join(dataDir, 'compile-cache.json');
  const gapLogPath = path.join(dataDir, 'gap-log.jsonl');

  const llmCall = deps.llmCall ?? (process.env.ANTHROPIC_API_KEY ? createAnthropicLlmCall() : undefined);

  // LRU: Map preserves insertion order; touch = delete+set to move to newest.
  const cache = new Map<string, CachedEntry>();
  if (persist) loadCache(cachePath, cache);

  function touch(key: string, entry: CachedEntry): void {
    cache.set(key, entry);
    while (cache.size > LRU_CAP) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    if (persist) saveCache(cachePath, cache);
  }

  function fromCache(key: string): CompileOutcome | null {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry); // move to newest
    if (entry.kind === 'ok') {
      return { ok: true, program: entry.program, interpretation: entry.interpretation, cached: true, tookMs: 0 };
    }
    return { ok: false, kind: 'refused', code: entry.code, reason: entry.reason, cached: true };
  }

  function appendGap(question: string, kind: 'refused' | 'invalid', code: string, reason?: string): void {
    if (!persist) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const line = JSON.stringify({ ts: new Date(nowMs()).toISOString(), question, kind, code, reason }) + '\n';
      fs.appendFileSync(gapLogPath, line, 'utf8');
    } catch (err) {
      logger.warn('gap-log append failed (non-fatal):', err);
    }
  }

  async function compile(question: string): Promise<CompileOutcome> {
    const normalized = normalize(question);
    const key = cacheKey(normalized);

    const hit = fromCache(key);
    if (hit) {
      logger.info(`[analytic-compile] hit norm="${normalized}"`);
      return hit;
    }

    if (!llmCall) {
      logger.warn('[analytic-compile] unavailable (no ANTHROPIC_API_KEY and no injected llmCall)');
      return { ok: false, kind: 'unavailable' };
    }

    const started = nowMs();
    const system = buildCompilerSystemPrompt();
    const messages: LlmMessage[] = [{ role: 'user', content: question }];

    // ── LLM call #1 ──
    const call1 = await llmCall({ system, messages });
    const emit1 = parseEmit(call1.input);

    if (emit1.kind === 'refuse') {
      touch(key, { kind: 'refused', code: emit1.code, reason: emit1.reason });
      appendGap(question, 'refused', emit1.code, emit1.reason);
      logCall(normalized, false, false, call1);
      return { ok: false, kind: 'refused', code: emit1.code, reason: emit1.reason, cached: false };
    }

    let issues: ValidationIssue[];
    if (emit1.kind === 'program') {
      const v = validateProgram(emit1.program);
      if (v.ok) {
        touch(key, { kind: 'ok', program: v.program, interpretation: v.program.interpretation });
        logCall(normalized, false, false, call1);
        return { ok: true, program: v.program, interpretation: v.program.interpretation, cached: false, tookMs: nowMs() - started };
      }
      issues = v.issues;
    } else {
      issues = [{ code: 'V-SHAPE', path: '', message: emit1.message }];
    }

    // ── One repair round ──
    const repairText =
      'Validation failed:\n' +
      issues.map((i) => `[${i.code}] ${i.path}: ${i.message}`).join('\n') +
      '\nFix these and call emit_program again.';
    const repairMessages: LlmMessage[] = [
      ...messages,
      { role: 'assistant', content: call1.assistantContent },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call1.toolUseId, content: repairText }] },
    ];

    const call2 = await llmCall({ system, messages: repairMessages });
    const emit2 = parseEmit(call2.input);

    if (emit2.kind === 'refuse') {
      touch(key, { kind: 'refused', code: emit2.code, reason: emit2.reason });
      appendGap(question, 'refused', emit2.code, emit2.reason);
      logCall(normalized, false, true, call2);
      return { ok: false, kind: 'refused', code: emit2.code, reason: emit2.reason, cached: false };
    }

    if (emit2.kind === 'program') {
      const v2 = validateProgram(emit2.program);
      if (v2.ok) {
        touch(key, { kind: 'ok', program: v2.program, interpretation: v2.program.interpretation });
        logCall(normalized, false, true, call2);
        return { ok: true, program: v2.program, interpretation: v2.program.interpretation, cached: false, tookMs: nowMs() - started };
      }
      // Still invalid — NOT cached (a later model/prompt may succeed).
      appendGap(question, 'invalid', v2.issues[0]?.code ?? 'V-SHAPE');
      logCall(normalized, false, true, call2);
      return { ok: false, kind: 'invalid', issues: v2.issues };
    }

    appendGap(question, 'invalid', 'V-SHAPE', emit2.message);
    logCall(normalized, false, true, call2);
    return { ok: false, kind: 'invalid', issues: [{ code: 'V-SHAPE', path: '', message: emit2.message }] };
  }

  return { compile };
}

function logCall(normalized: string, cached: boolean, repaired: boolean, call: LlmToolCall): void {
  logger.info(
    `[analytic-compile] miss norm="${normalized}" model=${call.model} ` +
      `in=${call.usage.inputTokens} out=${call.usage.outputTokens} repaired=${repaired}`,
  );
}

// ── Cache persistence (atomic write, mirrors cache/file-cache.ts pattern) ─────

function loadCache(cachePath: string, into: Map<string, CachedEntry>): void {
  try {
    if (!fs.existsSync(cachePath)) return;
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, CachedEntry>;
    for (const [k, v] of Object.entries(raw)) into.set(k, v);
  } catch (err) {
    logger.warn('compile-cache load failed (starting empty):', err);
  }
}

function saveCache(cachePath: string, cache: Map<string, CachedEntry>): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const obj: Record<string, CachedEntry> = {};
    for (const [k, v] of cache) obj[k] = v;
    const tmp = cachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, cachePath);
  } catch (err) {
    logger.warn('compile-cache save failed (non-fatal):', err);
  }
}

// ── Production Anthropic adapter ──────────────────────────────────────────────

export function createAnthropicLlmCall(): LlmCall {
  // Lazy import so the SDK/key are only needed when actually compiling live.
  return async ({ system, messages }) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: model(),
      max_tokens: 1500,
      temperature: 0,
      system,
      tools: [EMIT_PROGRAM_TOOL],
      tool_choice: { type: 'tool', name: 'emit_program' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
    });
    const toolUse = res.content.find((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!toolUse) throw new Error('model did not emit a tool_use block');
    return {
      input: toolUse.input,
      toolUseId: toolUse.id,
      assistantContent: res.content,
      model: res.model,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  };
}
