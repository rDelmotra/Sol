import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROGRAM_IDS } from '@orbitwatch/contracts';
import { PROGRAMS, matchProgram } from '../../src/enrichment/programs.js';
import { UCS_USER_TO_SECTOR } from '../../src/enrichment/types.js';

// Registry sanity + pure matcher behavior. The payload gate is NOT the
// matcher's job (asserted in derive-facets.test.ts) — the matcher happily
// matches debris names.

const VALID_SECTORS = new Set(Object.values(UCS_USER_TO_SECTOR));
const VALID_PURPOSES = new Set([
  'communications', 'earth_observation', 'navigation', 'technology_dev',
  'space_science', 'space_observation', 'surveillance', 'meteorological', 'other',
]);

describe('program registry sanity', () => {
  it('has unique ids', () => {
    const ids = PROGRAMS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('every entry has at least one matcher', () => {
    for (const p of PROGRAMS) {
      assert.ok(p.prefixes.length > 0 || (p.regexes?.length ?? 0) > 0, p.id);
    }
  });

  it('keeps the total regex count small (hot path: 30k names/cron)', () => {
    const total = PROGRAMS.reduce((n, p) => n + (p.regexes?.length ?? 0), 0);
    assert.ok(total < 10, `regex count ${total} >= 10`);
  });

  it('uses only valid Sector/Purpose literals', () => {
    for (const p of PROGRAMS) {
      for (const s of p.sectors ?? []) assert.ok(VALID_SECTORS.has(s), `${p.id}: ${s}`);
      if (p.purpose) assert.ok(VALID_PURPOSES.has(p.purpose), `${p.id}: ${p.purpose}`);
    }
  });

  // C2a: the registry no longer carries its own displayName — labels are
  // looked up from @orbitwatch/contracts's PROGRAM_LABELS by id. This test
  // guards against the two ever drifting apart (a new PROGRAMS entry with no
  // matching contracts label, or vice versa).
  it('ids equal contracts PROGRAM_IDS as sets', () => {
    const registryIds = new Set(PROGRAMS.map((p) => p.id));
    const contractIds = new Set(PROGRAM_IDS);
    assert.deepEqual(registryIds, contractIds);
  });
});

describe('matchProgram', () => {
  it('is case-insensitive across Space-Track and McDowell casings', () => {
    assert.equal(matchProgram('STARLINK-32001')?.id, 'starlink');
    assert.equal(matchProgram('Starlink-1008')?.id, 'starlink');
  });

  it('maps both COSMOS and KOSMOS spellings to the cosmos catch-all', () => {
    assert.equal(matchProgram('COSMOS 2570')?.id, 'cosmos');
    assert.equal(matchProgram('Kosmos-2570')?.id, 'cosmos');
  });

  it('matches Galileo live names without swallowing India\'s GSAT series', () => {
    assert.equal(matchProgram('GSAT0219 (GALILEO 23)')?.id, 'galileo');
    assert.equal(matchProgram('GalileoSat 23')?.id, 'galileo');
    assert.equal(matchProgram('GSAT-19'), null);
    assert.equal(matchProgram('GSAT 7A'), null);
  });

  it('handles multi-word and cross-romanization prefixes', () => {
    assert.equal(matchProgram('FENGYUN 3G')?.id, 'fengyun');
    assert.equal(matchProgram('Feng Yun 2H')?.id, 'fengyun');
    assert.equal(matchProgram('HULIANWANG DIGUI 01')?.id, 'guowang');
    assert.equal(matchProgram('WHDW-1 01')?.id, 'guowang');
    assert.equal(matchProgram('Qianfan Jigui 24')?.id, 'qianfan');
  });

  it('keeps short prefixes token-bounded (no accidental startsWith bleed)', () => {
    assert.equal(matchProgram('SES-17')?.id, 'ses');
    assert.equal(matchProgram('SESAT 1'), null);          // token SESAT ≠ SES
    assert.equal(matchProgram('GLOBALSTAR M097')?.id, 'globalstar');
    assert.equal(matchProgram('GLOBAL-4')?.id, 'blacksky'); // token GLOBAL ≠ GLOBALSTAR
    assert.equal(matchProgram('GPSAT-1'), null);
  });

  it('still matches program-named debris (payload gating is the caller\'s job)', () => {
    assert.equal(matchProgram('FENGYUN 1C DEB')?.id, 'fengyun');
    assert.equal(matchProgram('IRIDIUM 33 DEB')?.id, 'iridium');
  });

  it('resolves overlapping prefixes deterministically by registry order', () => {
    // NAVSTAR and GPS both belong to gps; USA belongs to the usa series.
    assert.equal(matchProgram('NAVSTAR 82 (USA 343)')?.id, 'gps');
    assert.equal(matchProgram('USA 224')?.id, 'usa');
  });

  it('returns null on empty and unknown names', () => {
    assert.equal(matchProgram(''), null);
    assert.equal(matchProgram('ISS (ZARYA)'), null);
  });
});
