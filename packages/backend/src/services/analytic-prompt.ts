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
  MAX_TIMESCAN_STEP_MINUTES,
  TIMESCAN_MAX_OBJECTS,
  SWEEP_MAX_HORIZON_MINUTES,
  SWEEP_MIN_STEP_SECONDS,
  SWEEP_MAX_STEP_SECONDS,
  PAST_CAP_DAYS,
  FUTURE_CAP_DAYS,
  type Universe,
} from '@orbitwatch/analytic';
import { SSA_PASS_REGION_IDS, SSA_PASS_MAX_WINDOW_DAYS, SSA_PASS_CIRCLE_MAX_KM, SSA_PASS_CIRCLE_MIN_KM } from '@orbitwatch/contracts';
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

/** The measured top-values list for `field` on `universe`, if any (string-kind
 *  fields only — see FieldCapability.topValues). */
function measuredTopValues(snapshot: RegistrySnapshot, universe: Universe, field: string): string[] | undefined {
  const u = snapshot.universes.find((x) => x.universe === universe);
  return u?.fields.find((f) => f.field === field)?.topValues;
}

// Keep the values list token-cheap: individual values are truncated (some
// string fields, e.g. `bus`/`shape`, carry long free-text values) and the
// whole joined list is capped well under the per-field line budget — chosen
// generously enough to fit 40 short values (program/owner/countryCode/...)
// but bail out early for fields whose top values happen to be long strings.
const MAX_VALUE_CHARS = 24;
const MAX_VALUES_JOINED_CHARS = 360;

function renderValueList(values: string[]): string {
  const truncated = values.map((v) => (v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS - 1)}…` : v));
  const out: string[] = [];
  let len = 0;
  for (const v of truncated) {
    const next = len + v.length + 1;
    if (out.length > 0 && next > MAX_VALUES_JOINED_CHARS) break;
    out.push(v);
    len = next;
  }
  return out.join('|');
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
      // Sparse fields use null for "none" — a low fraction is the answer, not a data gap.
      if (coverage < 0.95 && !spec.sparse) parts.push(`coverage ${Math.round(coverage * 100)}%`);

      if (spec.kind === 'string') {
        const values = measuredTopValues(snapshot, primary, name);
        if (values && values.length > 0) parts.push(`values: ${renderValueList(values)}`);
      }
    }
    if (spec.sparse) parts.push('null = none');
    return `- ${name} (${parts.join(', ')})${spec.description ? ` — ${spec.description}` : ''}`;
  });
  return `FIELD CATALOG (the only fields that exist — use names verbatim):
${lines.join('\n')}

Fields marked with a coverage % are partially populated: still use them — the executor
reports the basis (meta.coverage) and the answer is honestly caveated downstream.
Fields marked UNSERVED are in the contract but have no data source wired up yet
(every object reads null on both universes). If a question HINGES on one, refuse
NOT_DERIVABLE and say that data isn't ingested yet — do not build a filter that can
only return an empty set.
Fields with a "values" list are string fields with a MEASURED, closed vocabulary —
those are the ONLY values that exist for that field; a value not on the list matches
NOTHING (silently zero results, not an error). Never invent or guess an unlisted value.
If a question HINGES on a string value that is genuinely absent from the list, refuse
NOT_DERIVABLE. But if it can be answered another way — a different field, a numeric
threshold, a broader grouping — take that route instead of refusing.
This rule constrains string LITERALS only. It is NOT a general reason to refuse, and
it says nothing about questions built on numeric, date, enum or derived fields.
String fields with no "values" list (e.g. name, launchTag) are open text or too
numerous to enumerate; match those directly against what the question names.`;
}

// ── §3 Physics functions (generated) ──────────────────────────────────────────

const FN_DOCS: Record<string, string> = {
  elevationDeg: `{fn:'elevationDeg', observer} → degrees above the observer's horizon`,
  rangeKm: `{fn:'rangeKm', observer} → straight-line distance observer→object, km`,
  observerDark: `{fn:'observerDark', observer} → true if the observer is in civil darkness (sun < −6°)`,
  visuallyVisible: `{fn:'visuallyVisible', observer} → true if naked-eye visible now (elev>10°, range≤2000 km, observer dark, object sunlit)`,
  distToKm: `{fn:'distToKm', target: <noradId>} → distance to another object, km`,
  descendsFrom: `{fn:'descendsFrom', ancestor: <noradId>} → true if the object separated from this ancestor (GCAT separation tree)`,
  passedOver: `{fn:'passedOver', region: <id>|{latDeg,lonDeg,radiusKm}, from:'<ISO>', to:'<ISO>'} → true if the object passed over the region at any time in [from, to] (its sub-satellite point was inside it; PAST windows only, any time in the history 1959-01-11 .. now, at most ${SSA_PASS_MAX_WINDOW_DAYS} days long)`,
};

function renderFnCatalog(): string {
  const lines = Object.keys(FN_SPECS).map((name) => {
    const doc = FN_DOCS[name] ?? `{fn:'${name}', ...}`;
    return `- ${doc} [${FN_SPECS[name].plane}-plane, returns ${FN_SPECS[name].returns}]`;
  });
  return `PHYSICS FUNCTIONS (usable anywhere an expression is expected):
${lines.join('\n')}

observer is 'user' (the app user's stored location) or {latDeg, lonDeg, altKm?}.
Prefer 'user' unless the question names a place with known coordinates.

passedOver regions: a named region id — ${SSA_PASS_REGION_IDS.map((r) => `"${r}"`).join(', ')} (only "india" has a careful outline; the others are rough polygons: say so in "interpretation") — or a circle {latDeg, lonDeg, radiusKm} (radiusKm ${SSA_PASS_CIRCLE_MIN_KM}..${SSA_PASS_CIRCLE_MAX_KM}, centre not within 5° of a pole). Any other place or country (Paris, Germany, the Pacific): use a circle around its coordinates with a radius that fits the question ("around Paris, 500 km" = radiusKm 500; a city with no radius given = 100 km, and say so). from/to are ISO-8601 instants computed from the current-time line of the question (or the stated past date), to ≤ now.`;
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
   "stepMinutes":<n>,"maxSteps":<n>}                   (final stage only; set ≤ ${TIMESCAN_MAX_OBJECTS} objects, steps ≤ ${MAX_TIMESCAN_STEPS}, stepMinutes ≤ ${MAX_TIMESCAN_STEP_MINUTES})
- {"op":"sweep","predicate":<Expr>,"horizonMinutes":<n>,"stepSeconds":<n>,
   "peakOf":<Expr>?}                                   (final stage only; FORWARD only, from now; must be preceded
                                                          by a filter/pick/limit — a bare whole-catalog sweep is
                                                          rejected; horizonMinutes ≤ ${SWEEP_MAX_HORIZON_MINUTES}, stepSeconds
                                                          ${SWEEP_MIN_STEP_SECONDS}..${SWEEP_MAX_STEP_SECONDS}; returns one row per rise/fall
                                                          interval — {noradId,name,startIso,endIso,durationMinutes,
                                                          peak?,peakIso?,clippedEdge}; output shape "grouped")

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
"table" (rows; requires sort+limit; give columns) | "grouped" (after groupBy OR sweep).`;
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
   There are no region polygons for the CURRENT sky; do NOT invent lat/lon bounding boxes for named regions
   (dateline wrap makes them silently wrong). EXCEPTION: questions about PASSES over a region in a PAST window
   are answered by passedOver (rule 18), which has its own region table. Offer a latitude band or an observer-based
   question as the alternative in the reason. BUT explicit numeric coordinates ARE directly
   filterable: "over longitude 0" / "south of the equator" / "above 45°N" → filter on
   lonDeg / latDeg (e.g. abs(lonDeg) < 1 for "over longitude 0"). Only NAMED places refuse.
13. Past-window CHANGE questions ("this month", "since January", "over the past year" —
   decayed fastest, drifted, second derivative of altitude) → refuse NEEDS_HISTORY, EXCEPT
   the event fields, which are answerable: manoeuvres / orbit changes ("manoeuvred", "raised
   or lowered its orbit", "burned") → lastManoeuvreAt / manoeuvreCount30d /
   lastManoeuvreDeltaAKm (signed km; + raised, - lowered); new objects ("new in the last 7
   days", "just launched", "appeared") → appearedAt; formations → inFormation; upcoming close
   approaches / encounters / conjunctions in the next ~36 h → encounterCount36h /
   closestEncounterKm / maxEncounterPc / nextEncounterAt. These are NOT NEEDS_HISTORY. Date
   comparisons use ISO-8601 string literals computed from the current-time line in the
   question (e.g. "this week" = lastManoeuvreAt >= <now − 7 d>). Event fields are only
   populated for what the detector has seen, and encounters only look ~36 h ahead: say so in
   the interpretation. Do NOT dress these up for other questions: a trend, a rate over
   months, a fuel estimate, "most unstable orbits" (element variance over a window) or the
   decay-rate-as-history trick all stay NEEDS_HISTORY (EXCEPT the breakup fields, below); the ONLY live decay fast-path is the
   CURRENT decay rate (rule 3). Never use meanMotionDdot as an altitude derivative. Ground passes
   over a region in the past (rule 18) are NOT NEEDS_HISTORY either. Encounter
   fields count predicted close approaches (miss <= 5 km); they say nothing about collision
   risk beyond maxEncounterPc, and a high count is not a prediction that anything will collide.
   Fragmentations (history 1959-2026-03, "what broke up in 2009", "debris from the Iridium-Cosmos collision") ARE answerable
   from the breakup fields: breakupAt (start of the fragmentation: first day its debris was catalogued, for the object that broke up
   and for each piece), breakupPieces (pieces catalogued, set ONLY on the object that broke up; select "what broke up" with
   breakupPieces >= 10), breakupParent (NORAD id of the object that broke up, set ONLY on its pieces). A fragmentation is detected
   as >= 10 newly catalogued debris pieces of one launch within 60 days of each other, so: the date is when the debris was
   first catalogued, not the instant of the event (usually the same day to a few days later); a breakup whose pieces carry
   another launch's designator, or fewer than 10 pieces, is missed; launch-time debris of a large launch can look like a breakup;
   the piece count is as far as the data goes. Use universe "all" (the parents are mostly decayed). State this in "interpretation".
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
15. NOT expressible in v1 → refuse NOT_DERIVABLE: all-pairs proximity ("which satellites
   are close to each other" — distToKm needs ONE fixed target). Pass prediction over a
   place ("which satellites pass over <city> in the next hour") IS expressible now — see
   the "sweep" stage and its worked examples below; do NOT refuse it. Passes in the PAST over a
   region use passedOver (rule 18).
16. "what else went up on the same launch as <object>" → filter launchTag equality with that
   launch's COSPAR-style tag (e.g. NOAA-18 → "2005-018"), output {"shape":"ids"} — never an
   unbounded table. Only use a tag you are confident of; otherwise refuse NOT_DERIVABLE and
   say the launch tag lookup is the missing step.
17. If the user turn includes a line starting "(resolved places: ...)", those coordinates are
   MEASURED (a real gazetteer), not memory — use the given {latDeg, lonDeg} VERBATIM as the
   observer argument for that place; never substitute coordinates you recall yourself for a
   place named on that line. If the line notes a name "also matches" another place, briefly
   name the alternative in "interpretation" (the coordinates given ARE the resolved pick —
   already the higher-population match, nothing more to decide).

18. "Who/which satellites passed over <region> in the last <N days/week/month>" / "over <place> yesterday" →
   filter {"fn":"passedOver","region":...,"from":"<ISO>","to":"<ISO>"} (output "ids", or a table with sort+limit when
   the question asks for a count or a ranking). These are NOT NEEDS_HISTORY and NOT NOT_DERIVABLE. Rules:
   - "passed over" = the object's sub-satellite point was inside the region at some instant of the window, at any height
     (low orbit or geostationary alike). It is not "visible from" and not "within radar range": say so in "interpretation".
   - The window is at most ${SSA_PASS_MAX_WINDOW_DAYS} days and lies in the past (to ≤ now). "Last N days" = [now − N d, now];
     "yesterday" = the previous UTC day [00:00, 24:00); "last week" = [now − 7 d, now]. Longer than ${SSA_PASS_MAX_WINDOW_DAYS} days →
     refuse NEEDS_HISTORY and offer the ${SSA_PASS_MAX_WINDOW_DAYS}-day window. The FUTURE ("will pass over ... tomorrow") is a sweep, not passedOver.
   - HISTORY: passedOver also answers for windows in the past decades, from 1959-01-11 (the first full day of the catalog) to
     2026-03-31, plus the recent nightly days; a month named in the question ("in December 1998", "February 2009") is the whole UTC
     month [1st 00:00, next 1st 00:00) if it is ≤ ${SSA_PASS_MAX_WINDOW_DAYS} days (any month is); a longer period → the NEEDS_HISTORY
     offer above. Days between 2026-04-01 and the start of the nightly lists have no data. Use universe "all" for such a window — most
     of what flew then has decayed and is not in "live". The element sets are reconstructed per day: accuracy depends on the era (typical
     position error: 1959-1964 hundreds of km to thousands, 1965-1972 tens to ~100 km, 1973-1979 ~10 km, 1980 on a few km),
     and the sky was sparsely tracked before ~1980. State the era and that quality in "interpretation" for a window before 1980,
     and say that the answer lists objects the catalog tracked then.
   - Region: a named id from the passedOver list, else a circle around the place (use "(resolved places: ...)" coordinates
     verbatim when given). A country or sea that is not a named id → refuse NOT_DERIVABLE and offer a circle, unless a point
     and radius were given or can be taken from the question.
   - Combine with other filters through "and" (constellation: {"op":"in","field":"program","values":["starlink"]}).
   - The answer is exact at the star-map's 10-second resolution; a visit shorter than that is found only by a finer check
     (resolution 1 s). In "interpretation" state the region, the window and that guarantee, and for a named region other than
     "india" that its outline is approximate. Days for which no coverage exists are listed by the server beside the answer.`;


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
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "Detected orbit changes in the last 7 days where the semi-major axis went UP (lastManoeuvreDeltaAKm > 0 on the most recent detected manoeuvre). The detector only sees changes it has flagged, so this is a lower bound. Cutoff = now minus 7 days.",
        pipeline: [
          {
            op: 'filter',
            where: {
              op: 'and',
              args: [
                { op: '>=', args: [{ field: 'lastManoeuvreAt' }, { lit: '2026-10-25T12:00:00.000Z' }] },
                { op: '>', args: [{ field: 'lastManoeuvreDeltaAKm' }, { lit: 0 }] },
              ],
            },
          },
        ],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'Which Starlinks have a close approach under 1 km in the next day?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "Starlink = program 'starlink'. A close approach = a predicted encounter from the current ~36 h screening run; closestEncounterKm <= 1 and the next one falls within 24 h of now (nextEncounterAt <= now + 1 d). Sorted by closest miss distance.",
        pipeline: [
          {
            op: 'filter',
            where: {
              op: 'and',
              args: [
                { op: 'in', field: 'program', values: ['starlink'] },
                { op: '<', args: [{ field: 'closestEncounterKm' }, { lit: 1 }] },
                { op: '<=', args: [{ field: 'nextEncounterAt' }, { lit: '2026-11-02T12:00:00.000Z' }] },
              ],
            },
          },
          { op: 'sort', by: 'closestEncounterKm', dir: 'asc' },
          { op: 'limit', n: 25 },
        ],
        output: { shape: 'table', columns: ['name', 'closestEncounterKm', 'nextEncounterAt', 'maxEncounterPc'] },
      },
    },
  },
  {
    question: 'Which objects have more than 3 encounters?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          'Objects with more than 3 predicted close approaches (miss <= 5 km) in the current ~36 h screening run, most first.',
        pipeline: [
          { op: 'filter', where: { op: '>', args: [{ field: 'encounterCount36h' }, { lit: 3 }] } },
          { op: 'sort', by: 'encounterCount36h', dir: 'desc' },
          { op: 'limit', n: 25 },
        ],
        output: { shape: 'table', columns: ['name', 'encounterCount36h', 'closestEncounterKm'] },
      },
    },
  },
  {
    question: 'Which objects are new in the last 7 days?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          'Objects the detector first saw appear in the last 7 days (new launches, returns, newly cataloged). Cutoff = now minus 7 days.',
        pipeline: [
          { op: 'filter', where: { op: '>=', args: [{ field: 'appearedAt' }, { lit: '2026-10-25T12:00:00.000Z' }] } },
        ],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'Which satellites are flying in formation?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation: 'Objects detected in close formation with another object within the last 2 days.',
        pipeline: [{ op: 'filter', where: { field: 'inFormation' } }],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'Has the number of Starlink manoeuvres been trending up over the past year?',
    emit: {
      refuse: {
        code: 'NEEDS_HISTORY',
        reason:
          "A year-long trend needs the detected-event history aggregated over time; only recent events (manoeuvre count over the last 30 days, last manoeuvre time) are queryable. I can count Starlinks that manoeuvred in the last 30 days (manoeuvreCount30d) instead.",
      },
    },
  },
  {
    question: 'Which satellites passed over India in the last 30 days?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "'Passed over India' = the object's sub-satellite point (latitude/longitude directly beneath it) was inside India's outline at some instant between 2026-10-02T12:00Z and now (30 days), at any altitude, so low-orbit, medium-orbit and geostationary objects all count. This is not visibility from the ground. The answer is exact at the star-map's 10-second resolution; a shorter visit is only found by a finer check (1 s). India is a careful outline.",
        pipeline: [
          { op: 'filter', where: { fn: 'passedOver', region: 'india', from: '2026-10-02T12:00:00.000Z', to: '2026-11-01T12:00:00.000Z' } },
        ],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'Satellites that passed over Japan last week',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "'Passed over Japan' = the sub-satellite point was inside Japan's outline at some instant in the last 7 days (2026-10-25T12:00Z to now), at any altitude. The Japan outline is approximate (a rough polygon, not a border survey). Exact at the 10-second resolution of the stored coverage; a shorter visit is only found by a finer check (1 s).",
        pipeline: [
          { op: 'filter', where: { fn: 'passedOver', region: 'japan', from: '2026-10-25T12:00:00.000Z', to: '2026-11-01T12:00:00.000Z' } },
        ],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'Starlinks over a 500 km circle around Paris yesterday',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "Starlink = program 'starlink'. A circle of 500 km radius around Paris (48.8566, 2.3522). 'Passed over' = the sub-satellite point was inside the circle at some instant of yesterday (UTC, 2026-10-31T00:00Z to 2026-11-01T00:00Z). Exact at the 10-second resolution of the stored coverage; a shorter visit is only found by a finer check (1 s).",
        pipeline: [
          {
            op: 'filter',
            where: {
              op: 'and',
              args: [
                { op: 'in', field: 'program', values: ['starlink'] },
                { fn: 'passedOver', region: { latDeg: 48.8566, lonDeg: 2.3522, radiusKm: 500 }, from: '2026-10-31T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
              ],
            },
          },
        ],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'Who passed over India in December 1998?',
    emit: {
      program: {
        v: 1, universe: 'all', timeBinding: { mode: 'now' },
        interpretation:
          "History question: December 1998 = the UTC month 1998-12-01T00:00Z to 1999-01-01T00:00Z (31 days). Universe 'all' because most of what flew in 1998 has decayed. 'Passed over India' = the object's sub-satellite point was inside India's outline at some instant of the month, at any altitude (not visibility from the ground). The objects are those the catalog tracked on those days (reconstructed from the archived element sets of the time; typical position error a few km, so an object skimming the border may be wrongly in or out). Exact at the star-map's 10-second resolution; a shorter visit is only found by a finer check (1 s). India is a careful outline.",
        pipeline: [
          { op: 'filter', where: { fn: 'passedOver', region: 'india', from: '1998-12-01T00:00:00.000Z', to: '1999-01-01T00:00:00.000Z' } },
        ],
        output: { shape: 'ids' },
      },
    },
  },
  {
    question: 'What broke up in 2009?',
    emit: {
      program: {
        v: 1, universe: 'all', timeBinding: { mode: 'now' },
        interpretation:
          "Objects that fragmented in 2009: a fragmentation is detected as at least 10 newly catalogued debris pieces of one launch within 60 days of each other (breakupPieces is set on the object that broke up, breakupAt is the day its debris was first catalogued, usually the day of the event or shortly after). Universe 'all' because the parents are mostly decayed. Breakups with fewer than 10 pieces, or with pieces filed under another launch, are missed; the piece count is as far as the data goes. Biggest first.",
        pipeline: [
          {
            op: 'filter',
            where: {
              op: 'and',
              args: [
                { op: '>=', args: [{ field: 'breakupAt' }, { lit: '2009-01-01T00:00:00.000Z' }] },
                { op: '<', args: [{ field: 'breakupAt' }, { lit: '2010-01-01T00:00:00.000Z' }] },
                { op: '>=', args: [{ field: 'breakupPieces' }, { lit: 10 }] },
              ],
            },
          },
          { op: 'sort', by: 'breakupPieces', dir: 'desc' },
          { op: 'limit', n: 25 },
        ],
        output: { shape: 'table', columns: ['name', 'breakupAt', 'breakupPieces'] },
      },
    },
  },
  {
    question: 'Which objects launched in 1998 are still in orbit?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "Currently tracked objects (universe 'live' = still in orbit) whose launch year is 1998, by launch date.",
        pipeline: [
          { op: 'filter', where: { op: '==', args: [{ field: 'launchYear' }, { lit: 1998 }] } },
          { op: 'sort', by: 'launchDate', dir: 'asc' },
          { op: 'limit', n: 100 },
        ],
        output: { shape: 'table', columns: ['name', 'launchDate', 'objectType'] },
      },
    },
  },
  {
    question: 'Which satellites pass over Sydney in the next hour?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "'Pass over' = elevation above 10° from Sydney (-33.8714, 151.2125) at some point in the next hour. Narrowed to LEO first — GEO/MEO objects do not produce short rise/set passes from a fixed ground point. sweep returns one row per rise-to-set interval, with the peak elevation and its timestamp.",
        pipeline: [
          { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
          {
            op: 'sweep',
            predicate: { op: '>', args: [{ fn: 'elevationDeg', observer: { latDeg: -33.8714, lonDeg: 151.2125 } }, { lit: 10 }] },
            horizonMinutes: 60,
            stepSeconds: 30,
            peakOf: { fn: 'elevationDeg', observer: { latDeg: -33.8714, lonDeg: 151.2125 } },
          },
        ],
        output: { shape: 'grouped' },
      },
    },
  },
  {
    question: 'Which Starlink satellites will be eclipsed at some point in the next 2 hours?',
    emit: {
      program: {
        v: 1, universe: 'live', timeBinding: { mode: 'now' },
        interpretation:
          "Starlink = objects whose program is 'starlink'. sweep finds every window over the next 2 hours where the satellite is inside Earth's shadow — the same eclipsed field the single-object countdown example above uses, generalized to many objects with interval edges instead of one 'minutes until' scalar.",
        pipeline: [
          { op: 'filter', where: { op: 'in', field: 'program', values: ['starlink'] } },
          { op: 'sweep', predicate: { field: 'eclipsed' }, horizonMinutes: 120, stepSeconds: 60 },
        ],
        output: { shape: 'grouped' },
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
