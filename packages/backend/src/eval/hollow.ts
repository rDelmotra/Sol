// ============================================================
// P3 S7 — hollow-answer detector (pure logic, unit-tested).
// Spec: my_plans/marvin/p3/S7_eval_v2.md Part B.
//
// A program can be VALID and still return 0-basis garbage at runtime (the
// "elon musk failed satellites" class) — this catches an aggregate/list
// built almost entirely from nulls that the corpus row hasn't explicitly
// acknowledged as an expected low basis.
// ============================================================

import type { CoverageEntry } from '@orbitwatch/analytic';

export const LOW_BASIS_THRESHOLD = 0.05;

/** Coverage entries whose present/total ratio is below the low-basis threshold. */
export function computeLowBasisFields(coverage: CoverageEntry[]): string[] {
  return coverage
    .filter((c) => c.total > 0 && c.present / c.total < LOW_BASIS_THRESHOLD)
    .map((c) => c.field);
}

export interface HollowCheckInput {
  matched: number;
  lowBasisFields: string[];
  expectedLowBasis: string[];
  /** true for output.shape === 'scalar'. */
  isScalar: boolean;
  scalarValue: number | string | boolean | undefined | null;
}

/**
 * true ⇢ the row is a hollow answer: an unacknowledged low-basis field fed
 * the result, or a scalar aggregate silently skipped everything (matched
 * rows exist but the aggregate value is null/undefined). Never widen this
 * check ad hoc — S7 Part D: fix the provider, acknowledge the basis in the
 * corpus (`expectedLowBasis`), or fix the prompt.
 */
export function isHollow(input: HollowCheckInput): boolean {
  if (input.matched <= 0) return false;
  const unacknowledged = input.lowBasisFields.some((f) => !input.expectedLowBasis.includes(f));
  if (unacknowledged) return true;
  if (input.isScalar && (input.scalarValue === undefined || input.scalarValue === null)) return true;
  return false;
}
