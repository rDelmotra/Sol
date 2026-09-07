// ============================================================
// Local query parser — raw search text → QueryIR.
//
// Greedy longest-match n-gram scan over the alias table. Pure and
// deterministic; O(tokens × MAX_NGRAM) map lookups — trivial at keystroke
// rate. Whole-word matching is STRUCTURAL: lookups are exact-key only (no
// prefix matching), so a mid-typed "me" can never hit "meo"; a final
// incomplete token that exactly equals an alias ("leo") does match.
// ============================================================

import { ALIAS_TABLE, maxNgram, STOPWORDS } from './aliases';
import { hasQueryVocab } from './vocab';
import { tokenize } from './tokenize';
import type { QueryIR, QueryMatch } from './types';

// ── Single-token pattern rules ────────────────────────────────────────────────
// Run only AFTER the alias n-gram scan fails at a position, so a matched alias
// always wins. Single-token → the chip span is tokens[i], same splice-safe
// invariant as a 1-gram alias match.

// Launch tag ("2019-074") or a pasted COSPAR designator ("1998-067a"); `norm`
// is already lowercased. Trailing piece letters are stripped to the tag.
const LAUNCH_TAG_RE = /^(19|20)\d{2}-\d{3}[a-z]{0,3}$/;
const YEAR_RE = /^\d{4}$/;

function patternMatch(norm: string): Pick<QueryMatch, 'group' | 'value' | 'label'> | null {
  if (LAUNCH_TAG_RE.test(norm)) {
    const tag = norm.replace(/[a-z]+$/, '');
    // Vocab-free: works offline and for the InfoCard "Same launch" pivot.
    return { group: 'launch', value: tag, label: `Launch ${tag}` };
  }
  if (YEAR_RE.test(norm) && hasQueryVocab()) {
    // Vocab-GATED: without the tag→year index a year would compile to an empty
    // set (blank globe). Before the vocab loads it rides to Fuse (finds names
    // like "COSMOS 2021"). Caveat: a 4-digit token inside a name also matches
    // once loaded — the chip is visible and removable.
    const y = parseInt(norm, 10);
    if (y >= 1957 && y <= new Date().getFullYear() + 1) {
      return { group: 'launch_year', value: norm, label: `Launched ${norm}` };
    }
  }
  return null;
}

export function parseQuery(raw: string): QueryIR {
  const tokens = tokenize(raw);
  const matches: QueryMatch[] = [];
  const residual: string[] = [];

  let i = 0;
  outer: while (i < tokens.length) {
    // Longest n-gram first so "low earth orbit" beats stopword 'orbit'.
    const maxN = Math.min(maxNgram(), tokens.length - i);
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
    // No alias matched at this position — try the single-token pattern rules.
    const pat = patternMatch(tokens[i].norm);
    if (pat) {
      matches.push({
        ...pat,
        token: raw.slice(tokens[i].start, tokens[i].end),
        start: tokens[i].start,
        end: tokens[i].end,
      });
      i += 1;
      continue;
    }
    if (!STOPWORDS.has(tokens[i].norm)) residual.push(tokens[i].raw);
    i += 1;
  }

  return { matches, text: residual.join(' ') };
}
