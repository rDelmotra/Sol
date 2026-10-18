# FABRIC — the ground floor of Marvin

> Design only. Branch `marvin/fabric`, written 2026-10-19. Nothing here is built yet.
>
> **Built from:**
> - `design/marvin/research/01-code-inventory.md`: what the code knows today, with file:line.
> - `design/marvin/research/02-ontology-research.md`: standards and prior art, with citations.
> - The earlier architecture notes: the god loop, fusion, references and the space grid. These are untracked notes on the owner's machine.
>
> **Part A** is plain words. **Part B** is the engineering spec.
>
> **Owner rules this design must obey (`state/DECISIONS.md`):**
> - **D3:** the browser is just a client; routing is implicit, with no hand list and no routing manifest; answers are pushed; many entity types are coming.
> - **D4 / D5:** WGS84 only, and `ER_KM` is a unit.
> - **D6:** no production database or Railway changes without the owner.

---

# PART A — Plain words

## What the fabric is

The god needs a world to live in. The fabric is that world.

It says:
- what kinds of things exist;
- how each thing is named;
- where each thing is;
- when facts were true;
- how things connect.

It also keeps a diary of everything that comes in and everything that happens.

The heartbeat, the voice and the mind all sit on top of it. That is why it comes first.

## What is wrong today

These come from the new code report.

- **Every layer assumes a "thing" is a satellite number.** 61 of the 64 question fields describe one satellite.
- **Most other kinds of thing are just text labels on a satellite.** Launches and owners have records, but you can only reach them through a satellite. Programs, rockets, launch sites and countries are only labels. You can't ask about any of them directly.
- **Deep-space craft like Artemis II live in a separate world.**
- **Nothing keeps a diary.** Every update overwrites the last one. Re-entries, new objects and orbit jumps are never noticed.
- **Nothing is pushed.** Every screen has to ask.
- **When two sources disagree, the first one in a hidden list wins.** Nobody chose that on purpose.
- **Time is written more than eight different ways.**

## The fabric in nine rules

1. **Every thing gets one name that says what kind of thing it is.**
   - The ISS is `obj:25544`.
   - A launch is `launch:1998-067`.
   - SpaceX is `org:SPXS`.
   - Artemis II is an `obj` too.
   - Other names point to the same thing: COSPAR, the GCAT id, "ISS".

2. **Every kind of thing has a card.**
   - The card lists the facts that kind has and the links it can make.
   - Kinds can share badges. For example, anything with a position wears the "has a position" badge.
   - So one question can cover many kinds at once.

3. **Nothing is overwritten. Everything goes in the diary.**
   - Each entry says who said it, about which thing, and what.
   - Each entry also has three times: when it was true, when it was made, and when we learned it.
   - "Now" is worked out from the diary.

4. **A fact holds until the next report replaces it.**
   - Some facts are formulas. A satellite's position comes from its orbit numbers plus the clock.
   - Formula facts have a shelf life: about 60 days either side for an orbit.
   - Their error grows the further you go from the orbit's date.

5. **Links are real things too.**
   - Examples: "launched on", "broke off from", "owned by", "part of Starlink".
   - Each link has a start, an end, a source, and how sure we are.
   - Today these are hidden text fields. Because of that, 1,808 satellites lose their second owner.

6. **Happenings are first-class.**
   - An **event** is a moment: a launch, an object vanishing (a likely re-entry), a new object appearing, a storm starting.
   - A **situation** holds for a while: the ISS is over India; two objects are close; a storm is active.
   - Watchers notice them and write them into the diary.
   - When a situation opens, changes or closes, that change is what gets pushed to screens.

7. **Every position says which frame it is in.**
   - Star-fixed, Earth-fixed, or map coordinates.
   - Conversion happens at the moment it's needed, inside the one physics package we have.
   - The space cells from the grid design are an address that sits on top.

8. **Every fact says where it came from, and a written rule decides who wins.** No more silent "first in the list wins."

9. **Changes go through named actions.** "Watch this question" and "mark mission ended" are examples. Each action is logged.

## What we keep

- **The physics package** (`orbital-core`): the WGS84 Earth and the one Earth-spin function.
- **The honesty rules.** The AI never makes numbers. Refusals are honest. Answers say what data is missing.
- **The data feeds:** Space-Track, CelesTrak, GCAT, UCS, JPL Horizons, NOAA, Natural Earth. They become "sources" that write to the diary.
- **The history database and time-scrub.** They keep working. Later, history becomes one view of the diary.
- **Today's Ask.** It keeps working through an adapter until the voice floor replaces it.

## What changes

- A satellite number stops being the only kind of name.
- Overwriting becomes appending.
- The hidden source order becomes written rules.
- Text labels become real things, with real links.
- Asking becomes watching: situations get pushed.

## Where it lives

- **The rules live in code.** That means the cards, badges, link types, frames and sources. They go in a new package with no database, the same way the question language does today.
- **The diary lives in Postgres**, the same database as history. Nothing is added to the live database until you say go.
- **Every screen keeps a copy of what it needs.** It asks the server for "everything after entry N." That is how pushing will work, on any kind of screen.

## Build order for the ground floor

- **F1. Write the rules as code.** One pure package with tests. No database.
- **F2. Fill it from what we already have,** read-only. That means:
  - the catalog, enrichment, launches, owners and programs;
  - Artemis, places and space weather.

  Also add a name lookup, so the AI never has to remember satellite numbers.
- **F3. Start the diary.** The first writer is space weather, because every day we lose is gone for good. Next come catalog changes: new objects, vanished objects and orbit jumps. Use the local database first.
- **F4. First watchers:** a new object, an object gone (a likely re-entry), and a storm starting.
- **F5. "Now" views, plus a reader for "everything after entry N."** That is the hook pushing needs on the next floor.

## Decisions I need from you

1. **Names look like `kind:key`,** for example `obj:25544`. I recommend this.
2. **The diary lives in the same Postgres as history.** I recommend this. It only happens when you say go.
3. **Space weather is the first thing the diary records.** I recommend this.
4. **Today's Ask keeps working through an adapter while the fabric grows.** I recommend this.

## Still unsolved

- **Frames:** one cell ID that means the same place in star-fixed and Earth-fixed frames.
- **Formula facts:** storing them with their shelf life and growing error, in a form you can query.
- **Source conflicts:** which source wins, for every kind of fact. We will write these rules one at a time.
- **Scale:** pushing situation changes to many screens at once.
- **Error bars:** public orbit data has none, so "these two are within 2 km" is noise.
- **Rough dates:** dates like "1967 Oct?" have different precision. The fabric must carry that precision instead of hiding it.

---

# PART B — Engineering spec

## B1. Core vocabulary (14 concepts)

From `research/02-ontology-research.md` §10. Every concept is borrowed. We keep only the pattern, never the OWL files.

| # | Concept | Our shape | Borrowed from |
|---|---|---|---|
| 1 | Entity | `EntityRef` plus an entity row | `sosa:FeatureOfInterest`, BFO `continuant`, Foundry object |
| 2 | EntityType + Interface | `ENTITY_TYPES`, `INTERFACES` registries | Foundry object type + interface |
| 3 | Property | `PropertyDef` per type | `sosa:ObservableProperty`, MF-JSON `temporalProperties` (with `interpolation`) |
| 4 | Value | `Value` with a valid-time interval | Matheus 2003 `PropertyValue` (`startEvent` / `endEvent` / `certainty`); SQL:2011 application time |
| 5 | Link | `LINK_TYPES`, `Link` | Matheus `Relation`; Foundry link type; STIX `Relationship` |
| 6 | Observation | log kind `obs` | `sosa:Observation`, plus our `recordedAt` |
| 7 | Event | log kind `event` | Matheus `EventNotice`; SSAO event names |
| 8 | Situation | log kind `situation` (open / update / close) | Kokar 2009 STO "situations as objects"; CCSDS CDM message shape |
| 9 | Source | `SOURCES` registry | `sosa:Sensor` / `Procedure`; CDM `ORIGINATOR`; JC3IEDM `REPORTING-DATA` |
| 10 | Frame | `FRAMES` registry | CCSDS `REF_FRAME` / `TIME_SYSTEM`; SPICE frame classes |
| 11 | Region | entity type `region` with geometry | `geo:Feature` / `geo:Geometry`; topology names `sfWithin`, `sfIntersects` |
| 12 | Interval | half-open `[from, to)` in ms, open end = still holds | OWL-Time `ProperInterval`; Allen's 13 relations, by their OWL-Time names |
| 13 | LogEntry | the diary envelope | Fowler, event sourcing; STIX versioning (`id` + `modified`, `revoked`) |
| 14 | Action | log kind `action` | Foundry action type + action log |

## B2. Identity

**Ref format.** `EntityRef = "<type>:<key>"`. Rules:
- The type is a registered lowercase slug.
- The key rule is written per type.
- Refs are never re-used. A ref never changes after it is minted.

**v1 entity types.** All of them exist in today's data (01 §A).

| Type | Key | Example | Notes |
|---|---|---|---|
| `obj` | NORAD id | `obj:25544` | Covers payloads, rocket bodies, debris, components, decayed objects. The kind of object is a Value, not the type. |
| `obj` | `gcat:<jcat>` when there is no NORAD id | `obj:gcat:A01234` | Lets us represent the 596 dropped GCAT rows and the 7,481 parent ids that have no record (01 A3, D1). |
| `obj` | `horizons:<id>` for deep-space craft | `obj:horizons:-1024` | Artemis II. The slug `artemis-ii` becomes an alias. This ends the "DSO island". |
| `launch` | GCAT launch tag | `launch:1998-067` | 6,878 today. |
| `org` | GCAT org code | `org:SPXS` | 2,045 today. |
| `program` | slug | `program:starlink` | 72 today. |
| `vehicle` | normalized GCAT `lvType` | `vehicle:falcon-9` | Today a string with 398 values. |
| `site` | GCAT site code | `site:...` | Today a string with 54 codes. The pad stays a property of the launch for now. |
| `country` | canonical Space-Track-style code | `country:US` | 123 codes in data. |
| `place` | Natural Earth id | `place:ne<id>` | Gazetteer. |
| `body` | slug | `body:sun`, `body:earth`, `body:moon` | Global facts (space weather) live here. |
| `region` | slug | `region:leo` | Orbit shells first. Ground polygons come later. |
| `source` | slug | `source:space-track` | Feeds, catalogs, models, humans. |

**Observers are not entities.** The user's location stays a `Location` value inside a request or a client replica. It is never stored on the server. A future `station` type covers named ground stations.

**Aliases.** A table maps `(namespace, value)` to a ref. Namespaces:
- `norad`, `cospar`, `jcat`
- `name`
- `dso-slug`, `horizons`
- `ne`, `lv`

**Merges.** If a GCAT-only object later gets a NORAD id, an `identity` log entry records `sameAs`. The resolver follows `sameAs` to the oldest ref.

**Resolver.** It maps a name or alias to candidate refs, with a reason for each. This removes the current rule that asks the language model to recall NORAD ids from memory (01 §C.5 #13, E.1).

## B3. Types, interfaces, properties

**Interfaces** (the badges):

| Interface | Meaning |
|---|---|
| `Named` | `name`, `aliases` |
| `Locatable` | `location(t)` in a declared frame |
| `Orbiting` | has element sets and can be propagated |
| `Operated` | links to an operator org and a country |
| `Launched` | links to a launch |
| `Dated` | existence interval |

**Property definition:**

```ts
interface PropertyDef {
  name: string;
  type: 'number' | 'string' | 'bool' | 'time' | 'enum' | 'ref' | 'vector';
  unit?: string;
  frame?: FrameId;                 // for positions and vectors
  variability: 'static' | 'stepwise' | 'modelled' | 'series';
  precision?: 'exact' | 'day' | 'month' | 'year' | 'vague';   // for times
  sources: SourceId[];             // in precedence order (B9)
  model?: { from: string; fn: ModelId; validityMs: number };   // for 'modelled'
}
```

**Today's planes map onto `variability`:**
- `catalog` becomes `stepwise`: replaced at each refresh, now recorded as Values.
- `static` becomes `static` or `stepwise`, with source GCAT or UCS and the snapshot date stamped on each value.
- `live` becomes `modelled`: computed from the `elementSet` by SGP4, valid for ±60 days (`orbital-core/propagation-window.ts`).

**Global values get a real subject.** F10.7 is a property of `body:sun`. Kp and Ap are properties of `body:earth`, measured in `series` (three-hourly or daily). This solves the "no plane fits" problem written into `packages/analytic/src/schema.ts` without inventing a fake plane.

## B4. Values and time

```ts
interface Value {
  ref: EntityRef; property: string; value: unknown;
  validFrom: number; validTo: number | null;     // valid time, ms UTC, [from, to)
  resultTime?: number;                           // when the source made it
  recordedAt: number;                            // when the fabric learned it
  source: SourceId;
  provenance: 'sourced' | 'inferred' | 'inherited' | 'derived';
  certainty?: number; precision?: Precision;
}
```

**Three times.**
- Valid time is `phenomenonTime`.
- `resultTime` is when the source produced the value.
- `recordedAt` is transaction time.

Bitemporal queries ("what did we believe at r about t") use valid time and `recordedAt` together (02 §8).

**One time encoding inside the fabric:** int ms UTC, plus a precision tag. ISO strings appear only at the edges. This ends the 8+ representations listed in 01 E.6.

**Vague dates.** A GCAT date like "1967 Oct?" becomes a valid interval covering October 1967, with precision `month` and a `vague` flag. Comparisons then become honest. Today mixed precisions are compared as strings (01 E.6 #6).

**Modelled values.** We store only what generates the value, never the output:
- the element-set Value;
- the model id, for example `sgp4/satellite.js` or `sgp4/rust` (D4 notes these two differ);
- the validity window.

Evaluation at time t happens in `orbital-core` or the worker. Uncertainty growth is **not available**, because public GP data carries no covariance. Answers must say so (02 §11 #2).

## B5. Links

```ts
interface LinkType { name: string; from: TypeOrInterface; to: TypeOrInterface;
  cardinality: '1:1' | 'n:1' | 'n:m'; timeBounded: boolean; sources: SourceId[]; }
interface Link { from: EntityRef; type: string; to: EntityRef;
  validFrom?: number; validTo?: number | null; source: SourceId;
  provenance: 'sourced' | 'inferred' | 'inherited'; confidence?: number; }
```

**v1 link types.** All of these exist in the data today (01 §D).

| Link | From → To | Card. | Source today | Note |
|---|---|---|---|---|
| `launchedOn` | obj → launch | n:1 | GCAT `launchTag` | 69,130 objects |
| `separatedFrom` | obj → obj | n:1 | GCAT `parentJcat` | 69,117 edges; parents with no record get minted as `obj:gcat:` stubs |
| `ownedBy` | obj → org | n:m | GCAT owner cell | keeps multi-owner cells (1,808 lose owners today) |
| `manufacturedBy` | obj → org | n:m | GCAT manufacturer | 45,514 objects |
| `memberOf` | obj → program | n:1 | program slug | provenance is kept: 32,240 links are inherited |
| `operatedBy` | program → org | n:1 | program registry | free text today; needs a mapping |
| `agency` | launch → org | n:m | GCAT agencies | 106 codes, all resolve |
| `launchedFrom` | launch → site | n:1 | GCAT site | |
| `launchVehicle` | launch → vehicle | n:1 | GCAT `lvType` | |
| `parentOrg` | org → org | n:1 | GCAT parent | 528 edges |
| `registeredIn` | obj → country | n:1 | Space-Track country | |
| `operatorState` | org → country | n:1 | GCAT state code | a different code system; mapped explicitly |
| `sameAs` | any → any | identity | identity log | merges |

**Phase is a Value, not a type.** "In orbit / decayed / on pad" changes over time, so it is stored as a Value with an interval (02 §10, disagreement 6).

## B6. The log (the diary)

```ts
interface LogEntry {
  id: string;              // ULID, time-sortable, unique
  seq: number;             // gap-free cursor assigned by the store ("after N")
  kind: 'obs' | 'event' | 'situation' | 'action' | 'identity' | 'correction';
  recordedAt: number;
  source: SourceId;
  subjects: EntityRef[];
  payload: unknown;        // schema-checked per kind
  supersedes?: string;     // corrections only
}
```

**Payload per kind:**

| Kind | Payload |
|---|---|
| `obs` | `{ ref, property, result, phenomenonTime, resultTime?, procedure? }` |
| `event` | `{ type, at, participants, attrs, derivedFrom: entryId[] }` |
| `situation` | `{ situationId, type, change: 'open' \| 'update' \| 'close', participants, attrs, at }` |
| `action` | `{ type, params, by, outcome }` |
| `identity` | `mint` \| `alias` \| `sameAs` |

**Rules.**
- Append only. No row is ever updated or deleted.
- A correction is a new entry that supersedes an old one.
- "Present" is a projection over the log.
- Replay is deterministic, given the log and the model versions.

**Volume.**
- Element-set observations are written only when an epoch changes. That is at most one per object per fetch, so at most about 33k a day. This is the same order as `omm_daily`, about 12 M a year.
- Space weather is a few entries a day. DSO entries come one per publish.
- One Postgres is enough (see the space-grid notes).

**Storage.**
- Table `fabric_log`. It becomes a Timescale hypertable on `recordedAt` when the extension exists; otherwise a plain table, the same as history today.
- Indexes on `subjects`, `kind` and `seq`.
- The raw GP archive files remain the re-ingest source.

**First senses (writers), all built on existing code:**
1. **SWPC daily indices** → `obs` on `body:sun` (`f107`) and `body:earth` (`kp`, `ap`). This goes first, because only 30 days are kept upstream (01 A15).
2. **Catalog refresh** (`cron/tle-updater.ts`), compared with the previous catalog:
   - `obs` of the element set when the epoch changed;
   - `identity mint` for new NORAD ids;
   - input for the event detectors.
3. **GCAT / UCS snapshot import**, once per enrichment rebuild → `obs` and `Link`s with `phenomenonTime` set to the snapshot date.
4. **DSO publish** → an `obs` ephemeris segment.
5. **Gazetteer load** → `identity mint` for places.

## B7. Events and situations

**Event types (v1).** Names are chosen to be honest about what the data can prove:

| Event | Fires when | Note |
|---|---|---|
| `object.appeared` | a new NORAD id appears in the catalog | today the overlay adds these silently (01 B.3) |
| `object.disappeared` | an id is absent for N consecutive refreshes | a re-entry candidate; called `decayed` only when a source says so |
| `elements.jump` | the epoch-to-epoch change is over a threshold | a maneuver candidate; maneuvers can only be seen epoch to epoch, never from the 1 Hz tick |
| `storm.onset` / `storm.end` | Kp crosses 5 (NOAA G1) | |
| `mission.ended` | the existing DSO ended state | |
| `launch` | from GCAT records | historical events |

**Situation types.** Each is a registry entry: participants, rule (a standing program or a detector), and open/close semantics.

| Situation | Participants | Note |
|---|---|---|
| `storm.active` | `body:earth` | first |
| `over` | obj, region | later |
| `visible` | obj, client location | evaluated client-side; never stored server-side |
| `close` | obj, obj | miss distance only, with no probability of collision (no covariance) |

Situation ids look like `sit:<type>:<ulid>`. Every change to a situation is a log entry, and that entry is the unit that gets pushed.

## B8. Space and frames

**Location.** One of:
- `{ frame, coords, epoch? }`
- `{ region: EntityRef }`
- none

**Frames:**

| Frame | Meaning |
|---|---|
| `TEME` | SGP4 output |
| `ECEF-WGS84` | Earth-fixed |
| `GEODETIC-WGS84` | lat, lon, ellipsoidal height |
| `J2000` | Horizons source |
| `TOPO:<observer>` | az, el, range |

The time system is UTC everywhere. The one exception is the DSO source, which is TDB with the known fixed 69.184 s approximation (01 A5).

**One conversion home.** Only `@orbitwatch/orbital-core` converts between frames, and always at an epoch.

**SpaceCell** (from the space-grid design). It is a computed key `(frame, cell)` for a Locatable at time t.
- Moving objects: never stored.
- Static and region rows: stored.

**Bodies.**
- `body:sun`: direction only today.
- `body:earth`: WGS84.
- `body:moon`: missing. The realism track needs it too, so build it once.

## B9. Sources and precedence

**Source registry:** `{ id, kind: feed | catalog | model | human | derived, cadence, license, trust }`.

**Precedence is data.** It is written per property in the registry. It is not implied by provider order (today's rule is "first non-null wins", 01 §C.3, E.2).

**Initial rules for the conflicts the report found:**

| Property | Rule |
|---|---|
| `objectType` | GCAT 5-way wins over Space-Track 4-way, so `component` can match again (1,379 in-orbit components) |
| `launchDate` | Space-Track's exact day wins over GCAT's vague date |
| `elementSet` | Space-Track wins over the CelesTrak overlay; the newer epoch wins (D16) |
| country | two properties with clear names: `registeredCountry` (Space-Track) and `operatorState` (GCAT) |
| `status` | GCAT snapshot value, stamped with the snapshot date, so staleness is visible |

Resolution is a pure function from (property, candidates) to (winner, reason). The reason travels with the answer.

## B10. Actions

**Action types:** `{ name, params schema, permission, emits }`.

**v1 actions:**
- `watch`: register a standing situation for a client cursor.
- `unwatch`
- `markMissionEnded`: today this is `ended.json`.
- `correct`: a human correction, with a reason.

Every action writes an `action` log entry.

## B11. Reading the fabric (the hooks floors 2 and 3 need)

- `present(ref, property, t, asOf?)`: the Value in effect at valid time t, as known now, or as known at `asOf` (bitemporal).
- `links(ref, type?, t?)` and `inverse(ref, type)`: multi-hop traversal. Today there is only the one-hop dotted joins.
- `entities(typeOrInterface, filter)`: replaces today's `universe: live | all`.
- `after(seq, filter)`: the cursor read. The push transport (for example SSE) is floor 2.

**Client replica.** A client holds a subset of the fabric and a cursor. For example, it holds the element sets it needs for propagation. Anything it doesn't hold is answered by the server. Routing follows from what the replica holds. There is no hand-kept field list (`capability.ts` today) and no manifest (D3).

## B12. Compatibility with today

- **IR v1 keeps working through an adapter.** The adapter maps `noradId ↔ obj:<norad>`, and `getField(noradId, f, t)` becomes `present(ref, f, t)`. The 18 places that assume a noradId (01 §C.5) do not change on the ground floor.
- **`omm_daily` stays as it is.** Later it becomes a projection of element-set observations, so time-scrub is never broken.
- **The raw archive stays.** It is the re-ingest source.

## B13. Package layout (proposed)

- **`packages/fabric`** is pure, with zero runtime dependencies, like `packages/analytic`.
  - Registries: `ENTITY_TYPES`, `INTERFACES`, `PROPERTIES`, `LINK_TYPES`, `EVENT_TYPES`, `SITUATION_TYPES`, `SOURCES`, `FRAMES`.
  - Types, ref parse and format, validators, and the precedence function.
  - It depends only on `@orbitwatch/contracts` and `@orbitwatch/orbital-core`.
- **Backend `src/fabric/`** holds the store, the senses, the projections, the resolver and the cursor route. It is isolated the way `history/` is, with a rule added to `tests/architecture.test.ts`.
- **Frontend** gets its replica and cursor client on floor 2.

## B14. Ground-floor steps and exit test

| Step | What | Touches the live DB? |
|---|---|---|
| F1 | `packages/fabric`: registries, types, ref rules, precedence, tests | no |
| F2 | read-only population from today's stores, plus the alias resolver; tests check counts against 01 (69,242 enrichment, 6,878 launches, 2,045 orgs, 69,117 separation edges) | no |
| F3 | log store and first senses (SWPC first), on local Postgres (`docker-compose.yml`) | no; production only after the owner says go |
| F4 | detectors: `object.appeared`, `object.disappeared`, `elements.jump`, `storm.*` | no |
| F5 | projections and the `after(seq)` read API | no |

**Exit test for the ground floor:**
- Locally, the log holds at least 7 days of real entries.
- `present()` matches today's providers for all 64 fields on the live universe (a parity test).
- A vanished object produces `object.disappeared` within one refresh.

## B15. Open problems

From 02 §11, plus the space-grid notes:
1. Inertial and moving frames in a model you can query.
2. Modelled state with validity and growing uncertainty, when no covariance exists.
3. Precedence for every property; this table will grow.
4. Situation lifecycle and pushed deltas at scale, with exactly-once delivery and replay.
5. A query language an LLM can target, with typed refusals (floor 3).
6. Vague dates and inferred links: precision and provenance must survive every query.
7. Fields such as aurora and density grids as coverages, not points.
8. Licensing: only BFO (CC BY 4.0) and CCO (BSD-3) are open, so we adopt terms and patterns only.

## B16. Decisions to record once approved

These become new entries in `state/DECISIONS.md` only after the owner says yes:
- the ref format `kind:key`;
- the log in the history Postgres;
- SWPC as the first sense;
- IR v1 kept through an adapter.
