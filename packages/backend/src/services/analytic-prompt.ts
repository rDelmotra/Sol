// ============================================================
// Analytic compiler prompt generator (P2/S1 — my_plans/marvin/perceptor_p2_plan.md).
//
// The system prompt for the NL→IR compiler is GENERATED from the schema code
// (FIELD_REGISTRY / FN_SPECS / caps) so the prompt can never drift from what
// the validator accepts — one source, no drift (perceptor_analytic_schema.md §9.7).
// The grammar cheat-sheet and few-shots are hand-written constants below;
// everything is deterministic and pure so promptVersion is a stable content hash.
// ============================================================

import { createHash } from 'node:crypto';
import {
  FIELD_REGISTRY,
  FN_SPECS,
  MAX_PIPELINE_STAGES,
  MAX_DERIVED_FIELDS,
  MAX_EXPR_DEPTH,
  MAX_IN_VALUES,
  MAX_LIMIT,
  MAX_PICK_IDS,
  MAX_TIMESCAN_STEPS,
  TIMESCAN_MAX_OBJECTS,
  PAST_CAP_DAYS,
  FUTURE_CAP_DAYS,
  type Universe,
} from '@orbitwatch/analytic';
import { getAnalyticRegistry } from '../analytic/index.js';
import type { RegistrySnapshot } from '../analytic/types.js';

// ── §1 Role ───────────────────────────────────────────────────────────────────

const ROLE = `You compile natural-language questions about the Earth-orbit environment into
Analytic IR v1 JSON programs. You never calculate numbers yourself. You never invent
fields, enum values, or functions — only what the catalog below offers. A local executor
runs your program over one of two universes: "live" (~32,000 currently tracked objects
with live orbital state) or "all" (~70,000 objects ever cataloged since 1957 — includes
decayed/re-entered objects, which have identity and static metadata but NO orbital
elements or live state), and produces every number.

You must respond by calling the tool with EITHER a program OR a refusal — never both.`;

// ── §2 Field catalog (rendered from the boot-measured registry snapshot) ──────
//
// P3 S6: coverage + servedness are MEASURED at boot (DataSourceRegistry.snapshot()),
// never hand-coded here — this is what makes the "prompt claims X% but the real
// adapter serves 0%" bug class structurally impossible. schema.ts's static
// `coverage` values are docs-only from here on (see the comment there).

/** The measured coverage for `field` on `universe`, or 0 if no provider claims it
 *  on that universe at all (fallback registry coverage — spec Part B rule 5). */
function measuredCoverage(snapshot: RegistrySnapshot, universe: Universe, field: string): number {
  const u = snapshot.universes.find((x) => x.universe === universe);
  return u?.fields.find((f) => f.field === field)?.coverage ?? 0;
}

function renderFieldCatalog(snapshot: RegistrySnapshot): string {
  const lines = Object.entries(FIELD_REGISTRY).map(([name, spec]) => {
    const parts: string[] = [spec.kind, spec.plane];
    if (spec.unit) parts.push(`unit ${spec.unit}`);
    if (spec.domain) parts.push(`enum: ${spec.domain.join('|')}`);

    const onLive = measuredCoverage(snapshot, 'live', name);
    const onAll = measuredCoverage(snapshot, 'all', name);

    if (onLive === 0 && onAll === 0) {
      // No provider serves this field on EITHER universe — auto-derived demotion
      // (the F5 firewall: a registry noun that lands before its provider).
      parts.push('UNSERVED — always null, see note');
    } else {
      // static-plane → the 'all' entry is the honest "how much of the world has
      // this" denominator; catalog/live-plane → the 'live' entry (catalog fields
      // are null-for-decayed under 'all', which rule 2 already explains — showing
      // the live number here avoids double-caveating the same gap).
      const primary: Universe = spec.plane === 'static' ? 'all' : 'live';
      const coverage = primary === 'all' ? onAll : onLive;
      if (coverage < 0.95) parts.push(`coverage ${Math.round(coverage * 100)}%`);
    }
    return `- ${name} (${parts.join(', ')})`;
  });
  return `FIELD CATALOG (the only fields that exist — use names verbatim):
${lines.join('\n')}

Fields marked with a coverage % are partially populated: still use them — the executor
reports the basis (meta.coverage) and the answer is honestly caveated downstream.
Fields marked UNSERVED are in the contract but have no data source wired up yet
(every object reads null on both universes). If a question HINGES on one, refuse
NOT_DERIVABLE and say that data isn't ingested yet — do not build a filter that can
only return an empty set.`;
}

// ── §3 Physics functions (generated) ──────────────────────────────────────────

const FN_DOCS: Record<string, string> = {
  elevationDeg: `{fn:'elevationDeg', observer} → degrees above the observer's horizon`,
  rangeKm: `{fn:'rangeKm', observer} → straight-line distance observer→object, km`,
  observerDark: `{fn:'observerDark', observer} → true if the observer is in civil darkness (sun < −6°)`,
  visuallyVisible: `{fn:'visuallyVisible', observer} → true if naked-eye visible now (elev>10°, range≤2000 km, observer dark, object sunlit)`,
  distToKm: `{fn:'distToKm', target: <noradId>} → distance to another object, km`,
  descendsFrom: `{fn:'descendsFrom', ancestor: <noradId>} → true if the object separated from this ancestor (GCAT separation tree)`,
};

function renderFnCatalog(): string {
  const lines = Object.keys(FN_SPECS).map((name) => {
    const doc = FN_DOCS[name] ?? `{fn:'${name}', ...}`;
    return `- ${doc} [${FN_SPECS[name].plane}-plane, returns ${FN_SPECS[name].returns}]`;
  });
  return `PHYSICS FUNCTIONS (usable anywhere an expression is expected):
${lines.join('\n')}

observer is 'user' (the app user's stored location) or {latDeg, lonDeg, altKm?}.
Prefer 'user' unless the question names a place with known coordinates.`;
}

// ── §4 Grammar cheat-sheet (hand-written) ─────────────────────────────────────

function renderGrammar(): string {
  return `PROGRAM ENVELOPE:
{ "v": 1, "universe": "live" | "all", "timeBinding": {"mode":"now"} | {"mode":"at","t":"<ISO>"},
  "interpretation": "<mandatory prose>", "pipeline": [stages...],
  "compare": {"label": "...", "pipeline":[...]}?, "output": {"shape": ..., "columns": [...]?} }

STAGES (pipeline max ${MAX_PIPELINE_STAGES}; each transforms the current relation):
- {"op":"pick","ids":[noradIds]}                       (max ${MAX_PICK_IDS} ids)
- {"op":"filter","where":<Expr>}
- {"op":"derive","fields":{"name":<Expr>, ...}}        (max ${MAX_DERIVED_FIELDS} derived fields)
- {"op":"sort","by":"<field>","dir":"asc"|"desc"}
- {"op":"limit","n":<int>}                             (max ${MAX_LIMIT}; a table output needs a limit)
- {"op":"aggregate","aggs":{"name":<Agg>, ...}}
- {"op":"groupBy","key":"<field>"|["f1","f2"],"aggs":{"name":<Agg>,...}}
- {"op":"timeScan","predicate":<Expr>,"direction":"forward"|"backward",
   "stepMinutes":<n>,"maxSteps":<n>}                   (final stage only; set ≤ ${TIMESCAN_MAX_OBJECTS} objects, steps ≤ ${MAX_TIMESCAN_STEPS})

AGGREGATES: {"fn":"count"} | {"fn":"sum"|"avg"|"median"|"min"|"max"|"stddev","of":"<numeric field>"}
| {"fn":"share","where":<Expr>}   (fraction of the relation satisfying where)

EXPRESSIONS (max depth ${MAX_EXPR_DEPTH}):
- {"field":"<name>"} | {"lit": number|string|boolean}
- {"op":"+"|"-"|"*"|"/","args":[a,b]} | {"op":">"|">="|"<"|"<="|"=="|"!=","args":[a,b]}
- {"op":"and"|"or","args":[...2..8]} | {"op":"not","arg":e} | {"op":"abs","arg":e}
- {"op":"bucket","arg":e,"width":<n>}                  (numeric bucketing, e.g. altitude bands)
- {"op":"in","field":"<name>","values":[...]}          (max ${MAX_IN_VALUES} values)
- {"op":"has","field":"<enumSet field>","value":"..."} (set membership, e.g. sectors)
- physics functions (above)

TIME: timeBinding 'at' must be within −${PAST_CAP_DAYS} d … +${FUTURE_CAP_DAYS} d of now (SGP4 propagation window).

OUTPUT SHAPES: "ids" (lights up the 3D globe) | "scalar" | "object" (one row) |
"table" (rows; requires sort+limit; give columns) | "grouped" (after groupBy).`;
}

// ── §5 Hard rules (hand-written) ──────────────────────────────────────────────

const HARD_RULES = `HARD RULES:
1. "interpretation" is MANDATORY. State every assumption and threshold you chose in it
   (ambiguous words, defaults, noise cutoffs). It becomes the visible answer caption.
2. Choose the universe: "live" (the default) for anything about the current sky.
   "all" ONLY when the question is about the full historical catalog: "ever",
   "all time", "since 1957", "including decayed", launched-per-year totals.
   Under "all": live/catalog-plane fields (altitudeKm, apogeeKm, meanMotion, ...)
   are NULL for decayed objects — the executor reports the basis; SAY the caveat in
   the interpretation when you aggregate such a field under "all". Questions about
   the population ON a past date ("how many were in orbit on 12 March 1995") still
   → refuse NEEDS_HISTORY: decay DATES are not ingested, so past membership cannot
   be reconstructed. Change-over-time / trends → NEEDS_HISTORY as before.
3. "slowing down" / "decaying" / "losing altitude" → filter meanMotionDot > 1e-5 (the
   elset derivative is noisy near zero; the threshold suppresses noise) — and SAY SO in
   the interpretation. Note: decaying orbits actually speed up.
4. Question shape → output shape: "which/show/where are ..." → {"shape":"ids"} (globe
   highlight). "how many / what is <number>" → "scalar". "top/most/oldest/biggest N" →
   "table" with sort+limit. "per/by <category>" → "grouped". A program whose FINAL stage
   is timeScan ALWAYS uses "scalar" — never "object"/"table" (timeScan produces a group
   relation; the executor reports minutesUntil, or null if the predicate never flips
   within maxSteps). sort() already places null field values last regardless of
   direction — for "top/heaviest/biggest N" over a partially-covered field, just
   sort+limit; do NOT add a filter to exclude nulls, it isn't needed.
5. Observer functions are fine to use with observer:'user' — the client handles the
   user-has-no-location case. Do not refuse for a missing location.
6. Enum values must come verbatim from the field catalog. Never invent values. NOTE:
   category's 'active_satellite'/'inactive_satellite' values are NOT populated by the
   live classifier (every payload currently reads 'unknown' there) — for "active" /
   "dead" / "operational" satellite questions, filter operationalStatus (e.g.
   =='operational' or =='nonoperational') instead, never category.
7. Refuse (do not force a bad program) when the question is not derivable from the
   catalog+functions (NOT_DERIVABLE) or is not about the orbital domain / asks for
   opinion or prediction beyond physics (OFF_DOMAIN). A precise refusal IS a correct answer.
8. Common named objects: ISS = noradId 25544; Kosmos-1408 (2021 Russian ASAT test target,
   the source of a well-known debris cloud) = noradId 13552. For any other named object,
   use its noradId ONLY if you are confident of it; otherwise refuse NOT_DERIVABLE and say
   the name→ID lookup is the missing step (mirrors rule 16's launch-tag guidance). Debris
   "from" a named object → filter {"fn":"descendsFrom","ancestor":<noradId>}; prefer
   universe "all" since fragments are often decayed and absent from "live". Constellations
   are name/program matches (e.g. {"op":"in","field":"program","values":["starlink"]}), not
   id lists — program/owner-family string VALUES in the catalog are lowercase; match the
   stored casing exactly, never the question's capitalization.
9. The 'at' time binding covers the RECENT PAST too (up to 60 days back): "yesterday",
   "last night", "an hour ago", "21:00 tonight" → {"mode":"at","t":"<resolved ISO>"} using
   the current-time line in the question. Do NOT refuse these as NEEDS_HISTORY — that code
   is for trends/changes-over-time and dates outside the window.
10. Visualization/UI commands are not questions: "show me a heatmap/map/chart", "draw",
   "animate", "simulate" → refuse OFF_DOMAIN (briefly say what you CAN compute instead).
11. "closest to <object>" / "distance from <object>" → derive {"fn":"distToKm","target":<noradId>}
   (distToKm is a FUNCTION expression, never an "op"; rangeKm is observer-to-object only).
12. Named geographic regions ("over the Pacific/Europe/Asia/America") → refuse NOT_DERIVABLE.
   There are no region polygons; do NOT invent lat/lon bounding boxes for named regions
   (dateline wrap makes them silently wrong). Offer a latitude band or an observer-based
   question as the alternative in the reason. BUT explicit numeric coordinates ARE directly
   filterable: "over longitude 0" / "south of the equator" / "above 45°N" → filter on
   lonDeg / latDeg (e.g. abs(lonDeg) < 1 for "over longitude 0"). Only NAMED places refuse.
13. Past-window CHANGE questions ("this month", "last week", "since January", "over the past
   year" — decayed fastest, raised orbit, drifted, maneuvered, second derivative of
   altitude) → refuse NEEDS_HISTORY. Orbit STABILITY questions ("most unstable orbits")
   also → NEEDS_HISTORY: stability = element variance over a time window; the current
   meanMotionDot is a decay rate, not stability. The ONLY live decay fast-path is the
   CURRENT decay rate (rule 3). Never dress meanMotionDot up as a past-window comparison,
   and never use meanMotionDdot as an altitude derivative.
14. "this year" phrasing OVERRIDES rule 13 — it is answerable from launchYear, not history:
   "launched/grew (the most) this year" → filter launchYear == <current year from the time
   line> (for "grew the most per program": groupBy program over that filter, count, sort).
   "How much has X grown since <year>" IS answerable as TWO JUXTAPOSED COUNTS: main
   pipeline = the population now (filter + aggregate count, shape scalar); compare
   {"label":"launched ≤ <year>, still tracked"} = same filter plus launchYear <= <year> +
   aggregate count. Do NOT compute the difference/ratio in the program (no arithmetic
   across pipelines; no derive after aggregate) — the UI juxtaposes the two numbers.
   The interpretation MUST state the survivorship bias (only still-tracked objects).
   With universe "all" the survivorship caveat disappears — prefer "all" for
   since-<year> growth counts and say so.
15. NOT expressible in v1 → refuse NOT_DERIVABLE: pass prediction over a place ("which
   satellites pass over <city> in the next hour" — timeScan is a single-object countdown,
   ≤5 objects, not a sweep) and all-pairs proximity ("which satellites are close to each
   other" — distToKm needs ONE fixed target).
16. "what else went up on the same launch as <object>" → filter launchTag equality with that
   launch's COSPAR-style tag (e.g. NOAA-18 → "2005-018"), output {"shape":"ids"} — never an
   unbounded table. Only use a tag you are confident of; otherwise refuse NOT_DERIVABLE and
   say the launch tag lookup is the missing step.`;

// ── §6 Few-shot examples (hand-picked constants) ──────────────────────────────

interface FewShot {
  question: string;
  emit: object; // exact tool-call input: { program: ... } | { refuse: ... }
}

const FEW_SHOTS: FewShot[] = [
  {
    question: 'How fast is the ISS moving right now?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation: 'Current speed = |velocity| of the ISS (norad 25544) at sim-time.',
        pipeline: [{ op: 'pick', ids: [25544] }],
        output: { shape: 'object', columns: ['name', 'speedKmS', 'altitudeKm'] },
      },
    },
  },
  {
    question: 'Which satellites are slowing down?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "Read as 'orbit decaying' = mean motion increasing (decaying orbits actually gain speed). Using the elset's fitted derivative with a 1e-5 rev/day^2 noise threshold.",
        pipeline: [
          { op: 'filter', where: { op: '>', args: [{ field: 'meanMotionDot' }, { lit: 1e-5 }] } },
          { op: 'sort', by: 'meanMotionDot', dir: 'desc' },
        ],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'What share of Starlink satellites are in shadow right now?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "Starlink = objects whose program is 'starlink' (catalog program values are lowercase); share inside the cylindrical umbra at sim-time.",
        pipeline: [
          { op: 'filter', where: { op: 'in', field: 'program', values: ['starlink'] } },
          { op: 'aggregate', aggs: { shadowShare: { fn: 'share', where: { field: 'eclipsed' } } } },
        ],
        output: { shape: 'scalar' },
      },
    },
  },
  {
    question: 'What share of active satellites are commercial?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "Active = operationalStatus 'operational' (category's active/inactive split isn't populated by the live classifier — see rule 6). Share of those with sector 'commercial'.",
        pipeline: [
          { op: 'filter', where: { op: '==', args: [{ field: 'operationalStatus' }, { lit: 'operational' }] } },
          { op: 'aggregate', aggs: { commercialShare: { fn: 'share', where: { op: 'has', field: 'sectors', value: 'commercial' } } } },
        ],
        output: { shape: 'scalar' },
      },
    },
  },
  {
    question: 'Which 50 km altitude band is most crowded?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation: 'Objects bucketed by mean altitude in 50 km bands; the fullest band wins.',
        pipeline: [
          { op: 'derive', fields: { band: { op: 'bucket', arg: { field: 'meanAltitudeKm' }, width: 50 } } },
          { op: 'groupBy', key: 'band', aggs: { n: { fn: 'count' } } },
          { op: 'sort', by: 'n', dir: 'desc' },
          { op: 'limit', n: 1 },
        ],
        output: { shape: 'grouped' },
      },
    },
  },
  {
    question: 'What are the 10 oldest objects still in orbit?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation: 'Earliest launch dates among currently tracked objects.',
        pipeline: [
          { op: 'sort', by: 'launchDate', dir: 'asc' },
          { op: 'limit', n: 10 },
        ],
        output: { shape: 'table', columns: ['name', 'launchDate', 'ageYears'] },
      },
    },
  },
  {
    question: 'Is the ISS above or below average LEO altitude?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation: 'ISS mean altitude vs the average over the whole LEO population.',
        pipeline: [{ op: 'pick', ids: [25544] }],
        compare: {
          label: 'LEO average',
          pipeline: [
            { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
            { op: 'aggregate', aggs: { avgAlt: { fn: 'avg', of: 'meanAltitudeKm' } } },
          ],
        },
        output: { shape: 'object', columns: ['name', 'meanAltitudeKm'] },
      },
    },
  },
  {
    question: "What's the closest object to the ISS right now?",
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation: 'Nearest tracked object to the ISS (25544) by straight-line distance at sim-time; the ISS itself excluded.',
        pipeline: [
          { op: 'derive', fields: { dKm: { fn: 'distToKm', target: 25544 } } },
          { op: 'filter', where: { op: '!=', args: [{ field: 'noradId' }, { lit: 25544 }] } },
          { op: 'sort', by: 'dKm', dir: 'asc' },
          { op: 'limit', n: 1 },
        ],
        output: { shape: 'object', columns: ['name', 'dKm', 'altitudeKm'] },
      },
    },
  },
  {
    question: "How long until the ISS exits Earth's shadow?",
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          'Scanning forward from sim-time in 5-minute steps (up to 4 hours) until the ISS (norad 25544) is no longer eclipsed.',
        pipeline: [
          { op: 'pick', ids: [25544] },
          { op: 'timeScan', predicate: { op: 'not', arg: { field: 'eclipsed' } }, direction: 'forward', stepMinutes: 5, maxSteps: 48 },
        ],
        output: { shape: 'scalar' },
      },
    },
  },
  {
    question: 'What are the 10 heaviest objects in orbit?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          'Ranking currently tracked objects by launch mass (a partially-populated static field, ~54% coverage) — sort already places missing values last, so no null-exclusion filter is needed.',
        pipeline: [
          { op: 'sort', by: 'launchMassKg', dir: 'desc' },
          { op: 'limit', n: 10 },
        ],
        output: { shape: 'table', columns: ['name', 'launchMassKg'] },
      },
    },
  },
  {
    question: 'What debris came from Kosmos-1408?',
    emit: {
      program: {
        v: 1, universe: 'all', timeBinding: { mode: 'now' },
        interpretation:
          "Kosmos-1408 (2021 Russian ASAT test target) is noradId 13552. Universe 'all' because most of its fragments have since decayed and are absent from the live catalog.",
        pipeline: [
          { op: 'filter', where: { fn: 'descendsFrom', ancestor: 13552 } },
        ],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'Which satellite is the prettiest?',
    emit: {
      refuse: {
        code: 'OFF_DOMAIN',
        reason:
          'Aesthetic preference is not derivable from orbital or catalog data. I can rank by measurable properties (size, brightness-relevant span, altitude) if you name one.',
      },
    },
  },
  {
    question: 'How has the amount of debris grown since 2000?',
    emit: {
      program: {
        v: 1, universe: 'all', timeBinding: { mode: 'now' },
        interpretation:
          "Debris = objectType 'debris', counted over the full historical catalog (including since-decayed) so there is no survivorship bias, per rule 14 under universe 'all'; compared against debris launched by end of 2000.",
        pipeline: [
          { op: 'filter', where: { op: '==', args: [{ field: 'objectType' }, { lit: 'debris' }] } },
          { op: 'aggregate', aggs: { n: { fn: 'count' } } },
        ],
        compare: {
          label: 'launched by 2000',
          pipeline: [
            {
              op: 'filter',
              where: {
                op: 'and',
                args: [
                  { op: '==', args: [{ field: 'objectType' }, { lit: 'debris' }] },
                  { op: '<=', args: [{ field: 'launchYear' }, { lit: 2000 }] },
                ],
              },
            },
            { op: 'aggregate', aggs: { n: { fn: 'count' } } },
          ],
        },
        output: { shape: 'scalar' },
      },
    },
  },
  {
    question: 'How many objects were launched per year since 1957?',
    emit: {
      program: {
        v: 1, universe: 'all', timeBinding: { mode: 'now' },
        interpretation:
          'Counting every cataloged object (including since-decayed) by launch year, over the full historical catalog.',
        pipeline: [
          { op: 'filter', where: { op: '>=', args: [{ field: 'launchYear' }, { lit: 1957 }] } },
          { op: 'groupBy', key: 'launchYear', aggs: { n: { fn: 'count' } } },
          { op: 'sort', by: 'launchYear', dir: 'asc' },
        ],
        output: { shape: 'grouped' },
      },
    },
  },
  {
    question: 'Which satellites raised their orbit last week?',
    emit: {
      refuse: {
        code: 'NEEDS_HISTORY',
        reason:
          "Detecting a maneuver needs comparing this week's orbital elements against last week's; only the CURRENT elset is queryable, so past states can't be reconstructed. I can report the current decay rate (meanMotionDot) or current altitude instead.",
      },
    },
  },
];

function renderFewShots(): string {
  const blocks = FEW_SHOTS.map(
    (ex, i) => `Example ${i + 1}\nQ: ${ex.question}\nTool call input:\n${JSON.stringify(ex.emit, null, 2)}`,
  );
  return `EXAMPLES (question → the exact tool-call input to emit):\n\n${blocks.join('\n\n')}`;
}

// ── Assembly + version ────────────────────────────────────────────────────────

let cachedPrompt: string | null = null;
let cachedVersion: string | null = null;

function renderPrompt(snapshot: RegistrySnapshot): string {
  return [
    ROLE,
    renderFieldCatalog(snapshot),
    renderFnCatalog(),
    renderGrammar(),
    HARD_RULES,
    renderFewShots(),
  ].join('\n\n');
}

/**
 * Deterministic, pure GIVEN a snapshot: the full system prompt for the NL→IR
 * compiler. Default `snapshot` is the real boot-measured registry (memoized —
 * first compile triggers measurement, then the module-level cache holds since
 * it's a boot singleton). Tests pass an explicit fixture snapshot and get an
 * uncached render every time — no artifacts, no shared state between tests.
 */
export function buildCompilerSystemPrompt(snapshot?: RegistrySnapshot): string {
  if (snapshot !== undefined) return renderPrompt(snapshot);
  if (cachedPrompt) return cachedPrompt;
  cachedPrompt = renderPrompt(getAnalyticRegistry().snapshot());
  return cachedPrompt;
}

/**
 * Content hash of the rendered prompt (12 hex chars). Part of the compile-cache
 * key so any schema/prompt/coverage change auto-invalidates cached programs.
 * Memoized only for the default (real-registry) snapshot; an explicit snapshot
 * always hashes fresh.
 */
export function getPromptVersion(snapshot?: RegistrySnapshot): string {
  if (snapshot !== undefined) {
    return createHash('sha256').update(buildCompilerSystemPrompt(snapshot)).digest('hex').slice(0, 12);
  }
  if (cachedVersion) return cachedVersion;
  cachedVersion = createHash('sha256').update(buildCompilerSystemPrompt()).digest('hex').slice(0, 12);
  return cachedVersion;
}
