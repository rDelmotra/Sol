import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  ALIAS_TABLE,
  normalizeAliasKey,
  extendAliasTable,
  maxNgram,
  resetAliasTableForTests,
} from './aliases';
import { parseQuery } from './parser';

describe('normalizeAliasKey', () => {
  it('matches the tokenizer: lowercase, dots stripped, edge punctuation trimmed', () => {
    assert.equal(normalizeAliasKey('U.S. Space Force'), 'us space force');
    assert.equal(normalizeAliasKey('Ministry of Defence, London'), 'ministry of defence london');
    assert.equal(normalizeAliasKey('  SES / Astra  '), 'ses / astra'); // '/' preserved in-token
    assert.equal(normalizeAliasKey('R-7'), 'r-7');                     // '-' preserved
  });
});

describe('extendAliasTable', () => {
  afterEach(() => resetAliasTableForTests());

  it('static entries win over colliding dynamic keys (first-writer)', () => {
    // 'astra' is the SES program; 'usa' is the country US — both static.
    extendAliasTable([
      ['astra', { group: 'vehicle', value: 'AstraRocket', label: 'Astra' }],
      ['usa', { group: 'owner', value: 'USAORG', label: 'USA Org' }],
    ]);
    assert.deepEqual(parseQuery('astra').matches.map((m) => [m.group, m.value]), [
      ['program', 'ses'],
    ]);
    assert.deepEqual(parseQuery('usa').matches.map((m) => [m.group, m.value]), [
      ['country', 'US'],
    ]);
  });

  it('first dynamic writer wins among dynamics; new keys become matchable', () => {
    extendAliasTable([['zorbital', { group: 'owner', value: 'AAA', label: 'First' }]]);
    extendAliasTable([['zorbital', { group: 'owner', value: 'BBB', label: 'Second' }]]);
    assert.equal(ALIAS_TABLE.get('zorbital')!.value, 'AAA');
  });

  it('grows the n-gram window when a longer key is added', () => {
    const before = maxNgram();
    extendAliasTable([
      ['one two three four five six', { group: 'owner', value: 'LONG', label: 'Long Org' }],
    ]);
    assert.equal(maxNgram(), 6);
    assert.ok(maxNgram() > before);
  });

  it('end-to-end: a multi-word key with a stopword + comma parses', () => {
    extendAliasTable([
      ['Ministry of Defence, London', { group: 'owner', value: 'UKMOD', label: 'UK MoD' }],
    ]);
    // 'of' is a stopword but only consulted AFTER the n-gram scan, so the whole
    // key still matches; the comma is normalized away.
    const ir = parseQuery('ministry of defence london satellites');
    assert.deepEqual(ir.matches.map((m) => [m.group, m.value]), [
      ['owner', 'UKMOD'],
      ['type', 'satellite'],
    ]);
  });

  it('resetAliasTableForTests restores the pristine window', () => {
    extendAliasTable([['a b c d e f g', { group: 'owner', value: 'X', label: 'X' }]]);
    assert.equal(maxNgram(), 7);
    resetAliasTableForTests();
    assert.equal(maxNgram(), 3); // longest static key ("low earth orbit")
  });
});
