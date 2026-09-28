// P3 S1 — EnrichmentProvider tests.
// Spec: my_plans/marvin/p3/S1_enrichment_provider.md "Tests" #1-7.
// Values probed at implementation time via npx tsx — do not guess.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execute, validateProgram, type AnalyticProgram } from '@orbitwatch/analytic';
import { createEnrichmentProvider } from '../../src/analytic/providers/enrichment.js';
import { parseGcatDate } from '../../src/analytic/providers/gcat-date.js';
import { DataSourceRegistry } from '../../src/analytic/registry.js';

// Convenience: call getField at t=0 by noradId (provider is noradId-keyed, not index-keyed).
function field(noradId: number, f: string) {
  return provider.getField(noradId, f, 0);
}

const provider = createEnrichmentProvider();

// ── Test 1 — ISS (25544) ─────────────────────────────────────────────────────
describe('EnrichmentProvider — ISS (25544)', () => {
  it('identity fields', () => {
    assert.equal(field(25544, 'jcat'), 'S25544');
    assert.equal(field(25544, 'launchTag'), '1998-067');
    assert.equal(field(25544, 'cospar'), '1998-067A');
  });

  it('launch record join fields are non-null', () => {
    const lvFamily = field(25544, 'launch.lvFamily');
    const siteName = field(25544, 'launch.siteName');
    const success = field(25544, 'launch.success');
    assert.ok(lvFamily !== null, 'launch.lvFamily must be non-null');
    assert.ok(siteName !== null, 'launch.siteName must be non-null');
    // Probed: 'Proton', 'Baykonur', true
    assert.equal(lvFamily, 'Proton');
    assert.equal(siteName, 'Baykonur');
    assert.equal(success, true);
  });

  it('owner.name is non-null', () => {
    const ownerName = field(25544, 'owner.name');
    assert.ok(ownerName !== null, 'owner.name must be non-null');
    assert.equal(ownerName, 'NASA JSC');
  });
});

// ── Test 2 — Vanguard 1 (5) ──────────────────────────────────────────────────
describe('EnrichmentProvider — Vanguard 1 (5)', () => {
  it('launchYear is 1958', () => {
    assert.equal(field(5, 'launchYear'), 1958);
  });

  it("status is 'in_orbit'", () => {
    assert.equal(field(5, 'status'), 'in_orbit');
  });

  it('null physical fields are null, not skipped', () => {
    // powerW and expectedLifetimeYrs are absent for Vanguard 1 — honest nulls.
    assert.equal(field(5, 'powerW'), null);
    assert.equal(field(5, 'expectedLifetimeYrs'), null);
  });

  it('non-null physical fields are served (launchMassKg = 2)', () => {
    assert.equal(field(5, 'launchMassKg'), 2);
    assert.equal(field(5, 'dryMassKg'), 2);
  });
});

// ── Test 3 — descendsFrom: Kosmos-1408 debris ────────────────────────────────
describe('EnrichmentProvider — descendsFrom (Kosmos-1408 debris)', () => {
  // Debris 42060 has parentJcat === 'S13552' (Kosmos-1408 jcat).
  // Probed: debris norad 42060 is a direct child of 13552.

  it('direct child of Kosmos-1408 → true', () => {
    assert.equal(provider.descendsFrom!(42060, 13552), true);
  });

  it('different satellite → false', () => {
    assert.equal(provider.descendsFrom!(42060, 25544), false);
  });

  it('self is not its own descendant (strict)', () => {
    assert.equal(provider.descendsFrom!(13552, 13552), false);
  });
});

// ── Test 4 — operationalStatus honesty ───────────────────────────────────────
describe('EnrichmentProvider — operationalStatus honesty', () => {
  it("'unknown' → null (skip-and-count is honest)", () => {
    // norad 12 (rocket_body, in_orbit) has operationalStatus 'unknown'.
    assert.equal(field(12, 'operationalStatus'), null);
  });

  it("'nonoperational' → the enum value (Vanguard 1, norad 5)", () => {
    assert.equal(field(5, 'operationalStatus'), 'nonoperational');
  });

  // F5-killer: "failed satellites" class is no longer hollow.
  // Spine [33393, 5, 25544]; only 33393 (SpaceX nonop) matches.
  it('F5-killer: ownerFamily==SPX && operationalStatus==nonoperational through real execute()', () => {
    const reg = new DataSourceRegistry();
    // SpineProvider over a tiny fixture — includes the known SpaceX nonop satellite.
    reg.registerSpine('live', { id: 'fixture:tiny', spine: () => [33393, 5, 25544] });
    reg.register('live', provider);

    const program: AnalyticProgram = {
      v: 1 as const,
      universe: 'live' as const,
      timeBinding: { mode: 'now' as const },
      interpretation: 'test',
      pipeline: [
        {
          op: 'filter' as const,
          where: {
            op: 'and' as const,
            args: [
              { op: '==' as const, args: [{ field: 'ownerFamily' }, { lit: 'SPX' }] },
              { op: '==' as const, args: [{ field: 'operationalStatus' }, { lit: 'nonoperational' }] },
            ],
          },
        },
      ],
      output: { shape: 'ids' as const },
    };
    const v = validateProgram(program, { nowMs: Date.now() });
    assert.equal(v.ok, true, v.ok ? '' : JSON.stringify(v.issues));

    const source = reg.buildSource('live')!;
    const outcome = execute(program, { live: source }, { nowMs: Date.now() });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    // ids is a Uint32Array — use .length / Array.from
    assert.ok(outcome.result.ids!.length > 0, 'at least one SpaceX nonop satellite must match');
    assert.ok(Array.from(outcome.result.ids!).includes(33393), 'norad 33393 (SpaceX nonop) must be in the result');
  });
});

// ── Test 5 — parseGcatDate ───────────────────────────────────────────────────
describe('parseGcatDate', () => {
  it('"1998 Nov 20 0649:47" → "1998-11-20"', () => {
    assert.equal(parseGcatDate('1998 Nov 20 0649:47'), '1998-11-20');
  });

  it('"2019 May 24" → "2019-05-24"', () => {
    assert.equal(parseGcatDate('2019 May 24'), '2019-05-24');
  });

  it('"1967 Oct?" → "1967-10"', () => {
    assert.equal(parseGcatDate('1967 Oct?'), '1967-10');
  });

  it('"1975" → "1975"', () => {
    assert.equal(parseGcatDate('1975'), '1975');
  });

  it('garbage input → null', () => {
    assert.equal(parseGcatDate('not a date'), null);
    assert.equal(parseGcatDate(''), null);
    assert.equal(parseGcatDate(null), null);
    assert.equal(parseGcatDate(undefined), null);
  });
});

// ── Test 6 — program.label ───────────────────────────────────────────────────
describe('EnrichmentProvider — program.label', () => {
  it("'starlink' slug → 'Starlink' display name", () => {
    // norad 43215 is a Starlink satellite (probed).
    assert.equal(field(43215, 'program.label'), 'Starlink');
    // Also assert program field matches
    assert.equal(field(43215, 'program'), 'starlink');
  });

  it('unknown/absent slug → null (no program → null, not the slug itself)', () => {
    // norad 999999999 has no record at all.
    assert.equal(field(999999999, 'program.label'), null);
  });
});

// ── Test 7 — missing record ───────────────────────────────────────────────────
describe('EnrichmentProvider — missing record (norad 999999999)', () => {
  const CLAIMED_FIELDS = [
    'cospar', 'jcat', 'objectType', 'status', 'operationalStatus',
    'sectors', 'purpose', 'program', 'program.label',
    'countryCode', 'owner', 'owner.name', 'owner.stateCode', 'owner.cls', 'ownerFamily',
    'launchTag', 'parentJcat', 'launchDate', 'launchYear',
    'launchMassKg', 'dryMassKg', 'totMassKg', 'lengthM', 'diameterM', 'spanM',
    'powerW', 'expectedLifetimeYrs', 'bus', 'shape',
    'launch.date', 'launch.lvType', 'launch.lvFamily', 'launch.siteName',
    'launch.pad', 'launch.success',
  ];

  it('every claimed field returns null for an unknown norad', () => {
    for (const f of CLAIMED_FIELDS) {
      const v = field(999999999, f);
      // sectors returns [] (a valid enumSet), purpose returns 'other' — but with no
      // record, both should be null since we gate on record presence first.
      assert.equal(v, null, `${f} must be null for missing record`);
    }
  });

  it('descendsFrom returns false for unknown norad (no throw)', () => {
    assert.equal(provider.descendsFrom!(999999999, 13552), false);
    assert.equal(provider.descendsFrom!(42060, 999999999), false);
  });
});
