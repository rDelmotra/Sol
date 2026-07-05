// ============================================================
// Local query parser — raw search text → QueryIR.
//
// Greedy longest-match n-gram scan over the alias table. Pure and
// deterministic; O(tokens × MAX_NGRAM) map lookups — trivial at keystroke
// rate. Whole-word matching is STRUCTURAL: lookups are exact-key only (no
// prefix matching), so a mid-typed "me" can never hit "meo"; a final
// incomplete token that exactly equals an alias ("leo") does match.
// ============================================================

import { ALIAS_TABLE, MAX_NGRAM, STOPWORDS } from './aliases';
import type { QueryIR, QueryMatch } from './types';

interface Token {
  raw: string;   // original text, original casing
  norm: string;  // lowercase, dots stripped, edge punctuation trimmed
  start: number; // char span in the raw input
  end: number;
}

/**
 * Maximal non-whitespace runs with char spans. Normalization: lowercase,
 * dots stripped ('u.s.' → 'us'), leading/trailing punctuation trimmed —
 * but '/' and '-' preserved inside tokens ('r/b', 'sitro-ais').
 */
function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const norm = m[0]
      .toLowerCase()
      .replace(/\./g, '')
      .replace(/^[,;:!?"'()]+|[,;:!?"'()]+$/g, '');
    if (norm) tokens.push({ raw: m[0], norm, start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

export function parseQuery(raw: string): QueryIR {
  const tokens = tokenize(raw);
  const matches: QueryMatch[] = [];
  const residual: string[] = [];

  let i = 0;
  outer: while (i < tokens.length) {
    // Longest n-gram first so "low earth orbit" beats stopword 'orbit'.
    const maxN = Math.min(MAX_NGRAM, tokens.length - i);
    for (let n = maxN; n >= 1; n--) {
      const key = tokens
        .slice(i, i + n)
        .map((t) => t.norm)
        .join(' ');
      const entry = ALIAS_TABLE.get(key);
      if (entry) {
        matches.push({
          ...entry,
          token: raw.slice(tokens[i].start, tokens[i + n - 1].end),
          start: tokens[i].start,
          end: tokens[i + n - 1].end,
        });
        i += n;
        continue outer;
      }
    }
    if (!STOPWORDS.has(tokens[i].norm)) residual.push(tokens[i].raw);
    i += 1;
  }

  return { matches, text: residual.join(' ') };
}
