import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseQuery } from './parser';
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
