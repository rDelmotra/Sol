// ============================================================
// Tokenizer — shared by the parser (input) and the alias table (keys).
//
// Extracted so both sides normalize IDENTICALLY: a dynamic alias key like
// "Ministry of Defence, London" must reduce to the same token stream the parser
// produces for that typed text, or it could never match. Lives in its own
// module to keep aliases.ts and parser.ts free of an import cycle.
// ============================================================

export interface Token {
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
export function tokenize(raw: string): Token[] {
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
