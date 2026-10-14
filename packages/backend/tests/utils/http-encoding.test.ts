import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chooseEncoding,
  etagMatches,
  parseAcceptEncoding,
} from '../../src/utils/http-encoding.ts';

const BOTH = { br: true, gzip: true };
const GZIP_ONLY = { br: false, gzip: true };

describe('parseAcceptEncoding', () => {
  it('reads names and q values, lower-cased', () => {
    const m = parseAcceptEncoding('GZip;q=0.5, br, deflate;q=0');
    assert.equal(m.get('gzip'), 0.5);
    assert.equal(m.get('br'), 1);
    assert.equal(m.get('deflate'), 0);
  });

  it('is empty for a missing header', () => {
    assert.equal(parseAcceptEncoding(undefined).size, 0);
    assert.equal(parseAcceptEncoding('').size, 0);
  });
});

describe('chooseEncoding', () => {
  it('prefers brotli over gzip even when gzip comes first in the header', () => {
    assert.equal(chooseEncoding('gzip, deflate, br, zstd', BOTH), 'br');
    assert.equal(chooseEncoding('br, gzip', BOTH), 'br');
  });

  it('falls back to gzip when the client has no br', () => {
    assert.equal(chooseEncoding('gzip, deflate', BOTH), 'gzip');
    assert.equal(chooseEncoding('gzip', BOTH), 'gzip');
  });

  it('falls back to gzip while the brotli copy is not built yet', () => {
    assert.equal(chooseEncoding('gzip, deflate, br', GZIP_ONLY), 'gzip');
  });

  it('serves identity when the client accepts neither, or sends no header', () => {
    assert.equal(chooseEncoding(undefined, BOTH), 'identity');
    assert.equal(chooseEncoding('', BOTH), 'identity');
    assert.equal(chooseEncoding('identity', BOTH), 'identity');
    assert.equal(chooseEncoding('deflate', BOTH), 'identity');
  });

  it('respects q=0 and q ordering', () => {
    assert.equal(chooseEncoding('br;q=0, gzip', BOTH), 'gzip');
    assert.equal(chooseEncoding('gzip;q=0, br;q=0', BOTH), 'identity');
    assert.equal(chooseEncoding('gzip, br;q=0.5', BOTH), 'gzip');
    assert.equal(chooseEncoding('gzip;q=0.5, br', BOTH), 'br');
  });

  it('treats * as "anything", with explicit entries winning', () => {
    assert.equal(chooseEncoding('*', BOTH), 'br');
    assert.equal(chooseEncoding('*', GZIP_ONLY), 'gzip');
    assert.equal(chooseEncoding('br;q=0, *', BOTH), 'gzip');
  });
});

describe('etagMatches', () => {
  it('matches an exact tag, a list entry, a weak tag and *', () => {
    assert.equal(etagMatches('"a"', '"a"'), true);
    assert.equal(etagMatches('"x", "a"', '"a"'), true);
    assert.equal(etagMatches('W/"a"', '"a"'), true);
    assert.equal(etagMatches('*', '"a"'), true);
  });

  it('does not match a different tag or a missing header', () => {
    assert.equal(etagMatches('"b"', '"a"'), false);
    assert.equal(etagMatches('"a-br"', '"a"'), false);
    assert.equal(etagMatches(undefined, '"a"'), false);
  });
});
