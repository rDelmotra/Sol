// ============================================================
// Dump the REAL compiler system prompt to data/compiler-prompt.txt.
//
// Why this exists: the prompt is GENERATED at boot from a measured
// RegistrySnapshot (coverage + string vocabularies), so it cannot be read off
// any source file — `analytic-prompt.ts` is the template, not the artifact.
// Anything that needs the actual bytes the model sees (offline evals, a
// subagent standing in for the compiler LLM, diffing a prompt change) has to
// build it the same way production does.
//
// Companion to scripts/eval-compile.ts. That harness needs a live LLM key;
// this one needs none, so it also works when the model quota is exhausted.
//
// Run from packages/backend:
//   npx tsx scripts/dump-prompt.ts
//
// NOTE for any offline replay: the system prompt is only half of what the
// model receives. Production also sends a USER turn shaped
//   `${question}\n(current UTC time: ${ISO})`
// (see services/analytic-compiler.ts). A replay that sends the bare question
// makes every relative-time question unanswerable and the failure looks like a
// compiler defect — this cost a full misdiagnosis once already.
// ============================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { buildCompilerSystemPrompt } from '../src/services/analytic-prompt.js';
import { getAnalyticRegistry, type RegistrySnapshot } from '../src/analytic/index.js';

const outPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'compiler-prompt.txt',
);

const registry = getAnalyticRegistry();
// snapshot() is the boot-time capability+coverage measurement. Fall back to the
// default (unmeasured) prompt rather than failing, so this stays runnable in a
// bare checkout with no catalog cached — but SAY which one you got, because a
// default-snapshot prompt renders no measured vocabularies and is NOT what
// production sends.
const snapshot: RegistrySnapshot | undefined =
  typeof (registry as { snapshot?: () => RegistrySnapshot }).snapshot === 'function'
    ? (registry as { snapshot: () => RegistrySnapshot }).snapshot()
    : undefined;

const prompt = buildCompilerSystemPrompt(snapshot);
fs.writeFileSync(outPath, prompt);

console.log(
  `[dump-prompt] ${prompt.length} bytes → ${outPath}\n` +
    `[dump-prompt] snapshot: ${snapshot ? 'MEASURED (matches production)' : 'DEFAULT (no measured vocabularies — NOT production-equivalent)'}`,
);
