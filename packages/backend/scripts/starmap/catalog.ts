// SPIKE — not production. Shared catalog loader + tiny helpers for the starmap scripts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CatObj {
  noradId: number;
  name: string;
  omm: Record<string, unknown>;
  regime: string;
}

const CACHE = fileURLToPath(new URL('../../data/tle-cache.json', import.meta.url));

export function loadCatalog(): CatObj[] {
  return JSON.parse(readFileSync(CACHE, 'utf8')) as CatObj[];
}

/** Tiny `--flag value` parser. */
export function parseArgs(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) m.set(a.slice(2), argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true');
  }
  return m;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
