import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  brotliSettled,
  buildTlePayload,
  compressBrotli,
  getTlePayload,
  tleEtag,
} from '../../src/cache/tle-payload-cache.ts';

describe('buildTlePayload', () => {
  const version = '2026-06-19T20:17:56.660Z';
  const objects = [
    { noradId: 25544, name: 'ISS (ZARYA)' },
    { noradId: 20580, name: 'HST' },
  ];
  const rawArray = JSON.stringify(objects);

  it('gzips an envelope that decompresses to {version,count,data}', () => {
    const { gzip } = buildTlePayload(rawArray, version, objects.length);
    const decoded = JSON.parse(zlib.gunzipSync(gzip).toString('utf8'));

    assert.equal(decoded.version, version);
    assert.equal(decoded.count, objects.length);
    assert.deepEqual(decoded.data, objects);
  });

  it('produces a quoted-version ETag', () => {
    const { etag } = buildTlePayload(rawArray, version, objects.length);
    assert.equal(etag, `"${version}"`);
  });

  it('emits valid JSON for an empty array', () => {
    const { gzip } = buildTlePayload('[]', version, 0);
    const decoded = JSON.parse(zlib.gunzipSync(gzip).toString('utf8'));
    assert.deepEqual(decoded, { version, count: 0, data: [] });
  });
});

describe('tleEtag', () => {
  it('keeps the plain quoted version for gzip and tags the other encodings', () => {
    assert.equal(tleEtag('v1', 'gzip'), '"v1"');
    assert.equal(tleEtag('v1', 'br'), '"v1-br"');
    assert.equal(tleEtag('v1', 'identity'), '"v1-identity"');
  });
});

describe('compressBrotli', () => {
  it('round-trips to the same bytes', async () => {
    const input = Buffer.from(JSON.stringify({ a: Array.from({ length: 500 }, (_, i) => ({ i, s: 'abc' })) }));
    const br = await compressBrotli(input, 4);
    assert.ok(br.length < input.length);
    assert.ok(zlib.brotliDecompressSync(br).equals(input));
  });
});

describe('getTlePayload brotli copy', () => {
  let dir: string;
  const savedCacheDir = process.env.CACHE_DIR;
  const savedBrotli = process.env.TLE_BROTLI;
  const savedQuality = process.env.TLE_BROTLI_QUALITY;

  function writeData(version: string, objects: unknown[]): void {
    fs.writeFileSync(path.join(dir, 'tle-cache.json'), JSON.stringify(objects));
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, count: objects.length, byteSize: 0 }));
  }
  const objs = (n: number) => Array.from({ length: n }, (_, i) => ({ noradId: i, name: `SAT ${i}` }));

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tle-payload-'));
    process.env.CACHE_DIR = dir;
    process.env.TLE_BROTLI_QUALITY = '4'; // fast; the quality itself is not under test
  });

  afterEach(() => {
    if (savedBrotli === undefined) delete process.env.TLE_BROTLI;
    else process.env.TLE_BROTLI = savedBrotli;
  });

  after(() => {
    if (savedCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = savedCacheDir;
    if (savedQuality === undefined) delete process.env.TLE_BROTLI_QUALITY;
    else process.env.TLE_BROTLI_QUALITY = savedQuality;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('has gzip at once and adds a brotli copy that decompresses to the same JSON', async () => {
    writeData('2026-01-01T00:00:00.000Z', objs(300));
    delete process.env.TLE_BROTLI;
    const payload = getTlePayload();
    assert.ok(payload);
    assert.ok(payload.gzip.length > 0, 'gzip is available immediately');
    assert.equal(payload.br, null, 'brotli is built in the background, not inline');

    await brotliSettled();
    assert.ok(payload.br, 'brotli copy attached once the job ends');
    const fromGzip = zlib.gunzipSync(payload.gzip);
    const fromBr = zlib.brotliDecompressSync(payload.br);
    assert.ok(fromBr.equals(fromGzip), 'same bytes after decompression');
    assert.equal(JSON.parse(fromBr.toString('utf8')).count, 300);

    assert.equal(getTlePayload(), payload, 'same version returns the cached payload');
  });

  it('builds no brotli copy when TLE_BROTLI=0', async () => {
    writeData('2026-01-02T00:00:00.000Z', objs(20));
    process.env.TLE_BROTLI = '0';
    const payload = getTlePayload();
    assert.ok(payload);
    await brotliSettled();
    assert.equal(payload.br, null);
    assert.ok(payload.gzip.length > 0);
  });

  it('drops a brotli result whose version was replaced while it ran', async () => {
    delete process.env.TLE_BROTLI;
    writeData('2026-01-03T00:00:00.000Z', objs(50));
    const first = getTlePayload();
    // Same tick: the first job cannot have finished, so the data version moves on under it.
    writeData('2026-01-04T00:00:00.000Z', objs(60));
    const second = getTlePayload();
    assert.ok(first && second);
    assert.notEqual(first, second);
    await brotliSettled();
    assert.equal(first.br, null, 'stale result is discarded');
    assert.ok(second.br, 'live version gets its brotli copy');
    assert.equal(JSON.parse(zlib.brotliDecompressSync(second.br).toString('utf8')).count, 60);
  });
});
