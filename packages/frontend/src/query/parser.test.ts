import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { parseQuery } from './parser';
import { installQueryVocab, resetQueryVocabForTests } from './vocab';
import { resetAliasTableForTests } from './aliases';
import type { QueryMatch } from './types';

function groups(matches: QueryMatch[]): Array<[string, string]> {
  return matches.map((m) => [m.group, m.value]);
}

describe('parseQuery', () => {
  it('compiles the flagship query fully with empty residual', () => {
    const ir = parseQuery('chinese military satellites in leo');
    assert.deepEqual(groups(ir.matches), [
      ['country', 'PRC'],
      ['sector', 'military'],
      ['type', 'satellite'],
      ['regime', 'LEO'],
    ]);
    assert.equal(ir.text, '');
    // Spans reproduce the exact source tokens.
    const raw = 'chinese military satellites in leo';
    for (const m of ir.matches) {
      assert.equal(raw.slice(m.start, m.end), m.token);
    }
    assert.equal(ir.matches[0].token, 'chinese');
    assert.equal(ir.matches[3].token, 'leo');
  });

  it('compiles a bare program', () => {
    const ir = parseQuery('starlink');
    assert.deepEqual(groups(ir.matches), [['program', 'starlink']]);
    assert.equal(ir.text, '');
    assert.equal(ir.matches[0].label, 'Starlink');
  });

  it('compiles country + type combos', () => {
    const ir = parseQuery('russian debris');
    assert.deepEqual(groups(ir.matches), [
      ['country', 'CIS'],
      ['type', 'debris'],
    ]);
  });

  it('maps purpose synonyms (weather → meteorological)', () => {
    const ir = parseQuery('weather satellites');
    assert.deepEqual(groups(ir.matches), [
      ['purpose', 'meteorological'],
      ['type', 'satellite'],
    ]);
  });

  it('program beats purpose: gps is the program, not navigation', () => {
    const ir = parseQuery('gps');
    assert.deepEqual(groups(ir.matches), [['program', 'gps']]);
  });

  it('country beats the DoD program slug: usa is the country', () => {
    const ir = parseQuery('usa');
    assert.deepEqual(groups(ir.matches), [['country', 'US']]);
  });

  it('never prefix-matches: "me" is a stopword, "med" rides as residual', () => {
    assert.deepEqual(parseQuery('me'), { matches: [], text: '' }); // stopword
    assert.deepEqual(parseQuery('med'), { matches: [], text: 'med' });
    const ir = parseQuery('medium earth orbit');
    assert.deepEqual(groups(ir.matches), [['regime', 'MEO']]);
    assert.equal(ir.matches[0].token, 'medium earth orbit');
  });

  it('consumes stopwords silently — absent from matches AND residual', () => {
    const ir = parseQuery('show me all the junk');
    assert.deepEqual(groups(ir.matches), [['type', 'debris']]);
    assert.equal(ir.text, '');
  });

  it('matches multi-word aliases as single spans', () => {
    const eo = parseQuery('earth observation');
    assert.deepEqual(groups(eo.matches), [['purpose', 'earth_observation']]);
    assert.equal(eo.matches[0].start, 0);
    assert.equal(eo.matches[0].end, 'earth observation'.length);

    const rb = parseQuery('rocket bodies');
    assert.deepEqual(groups(rb.matches), [['type', 'rocket_body']]);
  });

  it('chip removal = span splice + re-parse', () => {
    const ir = parseQuery('chinese military');
    const military = ir.matches.find((m) => m.value === 'military')!;
    const spliced = ('chinese military'.slice(0, military.start) +
      'chinese military'.slice(military.end))
      .replace(/\s{2,}/g, ' ')
      .trim();
    const next = parseQuery(spliced);
    assert.deepEqual(groups(next.matches), [['country', 'PRC']]);
  });

  it('passes unknown text through as residual with original casing', () => {
    const ir = parseQuery('ISS Zarya');
    assert.deepEqual(ir.matches, []);
    assert.equal(ir.text, 'ISS Zarya');
  });

  it('normalizes dots and edge punctuation (u.s. → US country)', () => {
    const ir = parseQuery('u.s. satellites,');
    assert.deepEqual(groups(ir.matches), [
      ['country', 'US'],
      ['type', 'satellite'],
    ]);
  });
});

// ── G3: single-token pattern rules (launch tag + year) ────────────────────────

describe('parseQuery — launch-tag pattern rule', () => {
  it('matches a bare launch tag with an exact single-token span', () => {
    const ir = parseQuery('2019-074');
    assert.deepEqual(groups(ir.matches), [['launch', '2019-074']]);
    assert.equal(ir.matches[0].label, 'Launch 2019-074');
    assert.equal(ir.matches[0].token, '2019-074');
    assert.equal(ir.matches[0].start, 0);
    assert.equal(ir.matches[0].end, '2019-074'.length);
    assert.equal(ir.text, '');
  });

  it('strips a pasted COSPAR piece letter to the tag', () => {
    assert.deepEqual(groups(parseQuery('1998-067A').matches), [['launch', '1998-067']]);
    assert.deepEqual(groups(parseQuery('1998-067abc').matches), [['launch', '1998-067']]);
  });

  it('rejects malformed tags → residual (not a launch match)', () => {
    assert.deepEqual(parseQuery('2019-0745'), { matches: [], text: '2019-0745' });
    assert.deepEqual(parseQuery('20190-74'), { matches: [], text: '20190-74' });
    assert.deepEqual(parseQuery('1899-074'), { matches: [], text: '1899-074' });
  });

  it('works with no vocab loaded (offline / pre-fetch pivot)', () => {
    resetQueryVocabForTests();
    assert.deepEqual(groups(parseQuery('2019-074').matches), [['launch', '2019-074']]);
  });
});

describe('parseQuery — year pattern rule (vocab-gated)', () => {
  afterEach(() => {
    resetQueryVocabForTests();
    resetAliasTableForTests();
  });

  it('a 4-digit year is residual until the vocab loads', () => {
    resetQueryVocabForTests();
    assert.deepEqual(parseQuery('2021'), { matches: [], text: '2021' });
  });

  it('after installQueryVocab a plausible year compiles to launch_year', () => {
    installQueryVocab({ launches: { '2021-001': ['Falcon9', 'Canaveral'] }, orgs: {} });
    const ir = parseQuery('2021');
    assert.deepEqual(groups(ir.matches), [['launch_year', '2021']]);
    assert.equal(ir.matches[0].label, 'Launched 2021');
  });

  it('rejects out-of-range years even with vocab loaded', () => {
    installQueryVocab({ launches: { '2021-001': ['Falcon9', 'Canaveral'] }, orgs: {} });
    assert.deepEqual(parseQuery('1949'), { matches: [], text: '1949' });
    assert.deepEqual(parseQuery('2199'), { matches: [], text: '2199' });
  });

  it('flagship vehicle + site + year with stopword "from" consumed', () => {
    installQueryVocab({
      launches: { '2021-005': ['Falcon9', 'Vandenberg'] },
      orgs: {},
    });
    const ir = parseQuery('falcon 9 from vandenberg 2021');
    assert.deepEqual(groups(ir.matches), [
      ['vehicle', 'Falcon9'],
      ['site', 'Vandenberg'],
      ['launch_year', '2021'],
    ]);
    assert.equal(ir.text, '');
  });

  it('chip splice + re-parse works across a pattern match', () => {
    installQueryVocab({ launches: { '2021-001': ['Falcon9', 'Canaveral'] }, orgs: {} });
    const ir = parseQuery('starlink 2021');
    const year = ir.matches.find((m) => m.group === 'launch_year')!;
    const spliced = ('starlink 2021'.slice(0, year.start) + 'starlink 2021'.slice(year.end))
      .replace(/\s{2,}/g, ' ')
      .trim();
    assert.deepEqual(groups(parseQuery(spliced).matches), [['program', 'starlink']]);
  });
});
