// GET /api/tle/all: content-coding negotiation (br > gzip > identity) and ETag/304
// behaviour per encoding. Real app on an ephemeral port, temp CACHE_DIR, raw node:http
// so the compressed bytes are visible (fetch would decode them for us).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { Router } from 'express';
import { createApp } from '../../src/app.ts';
import { brotliSettled } from '../../src/cache/tle-payload-cache.ts';

const VERSION = '2026-02-03T04:05:06.789Z';
const GZIP_TAG = `"${VERSION}"`;
const BR_TAG = `"${VERSION}-br"`;
const ID_TAG = `"${VERSION}-identity"`;

interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

function get(base: string, headers: Record<string, string>): Promise<Res> {
  return new Promise((resolve, reject) => {
    http.get(`${base}/api/tle/all`, { headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('GET /api/tle/all encodings', () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  const saved = { cache: process.env.CACHE_DIR, brotli: process.env.TLE_BROTLI, q: process.env.TLE_BROTLI_QUALITY };
  const objects = Array.from({ length: 400 }, (_, i) => ({ noradId: 1000 + i, name: `OBJ ${i}`, inclination: 51.6 }));

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tle-all-'));
    fs.writeFileSync(path.join(dir, 'tle-cache.json'), JSON.stringify(objects));
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: VERSION, count: objects.length, byteSize: 0 }));
    process.env.CACHE_DIR = dir;
    delete process.env.TLE_BROTLI;
    process.env.TLE_BROTLI_QUALITY = '4';
    const app = createApp({ queryRouter: Router() });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, val] of [['CACHE_DIR', saved.cache], ['TLE_BROTLI', saved.brotli], ['TLE_BROTLI_QUALITY', saved.q]] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves gzip until the brotli copy is ready, even to a client that allows br', async () => {
    const res = await get(base, { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers.etag, GZIP_TAG);
    assert.equal(JSON.parse(zlib.gunzipSync(res.body).toString('utf8')).count, objects.length);
    await brotliSettled();
  });

  it('prefers brotli over gzip once ready, with correct headers and body', async () => {
    const res = await get(base, { 'accept-encoding': 'gzip, deflate, br, zstd' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'br');
    assert.equal(res.headers.etag, BR_TAG);
    assert.match(String(res.headers.vary), /Accept-Encoding/i);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(Number(res.headers['content-length']), res.body.length);
    // One brotli layer only: compression() must not have encoded it again.
    const decoded = JSON.parse(zlib.brotliDecompressSync(res.body).toString('utf8'));
    assert.equal(decoded.version, VERSION);
    assert.equal(decoded.count, objects.length);
    assert.deepEqual(decoded.data, objects);
  });

  it('brotli and gzip bodies decode to identical JSON', async () => {
    const br = await get(base, { 'accept-encoding': 'br' });
    const gz = await get(base, { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.etag, GZIP_TAG);
    assert.ok(zlib.brotliDecompressSync(br.body).equals(zlib.gunzipSync(gz.body)));
  });

  it('serves gzip when the client has no br, and honours br;q=0', async () => {
    for (const ae of ['gzip', 'gzip, deflate', 'br;q=0, gzip']) {
      const res = await get(base, { 'accept-encoding': ae });
      assert.equal(res.headers['content-encoding'], 'gzip', ae);
      assert.equal(res.headers.etag, GZIP_TAG, ae);
    }
  });

  it('falls back to plain JSON when the client sends no usable encoding', async () => {
    const cases: Array<Record<string, string>> = [{}, { 'accept-encoding': 'identity' }];
    for (const headers of cases) {
      const res = await get(base, headers);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], undefined);
      assert.equal(res.headers.etag, ID_TAG);
      const decoded = JSON.parse(res.body.toString('utf8'));
      assert.equal(decoded.version, VERSION);
      assert.equal(decoded.count, objects.length);
      assert.deepEqual(decoded.data, objects);
    }
  });

  it('answers 304 per encoding, with validators and no body', async () => {
    const br = await get(base, { 'accept-encoding': 'br', 'if-none-match': BR_TAG });
    assert.equal(br.status, 304);
    assert.equal(br.body.length, 0);
    assert.equal(br.headers.etag, BR_TAG);
    assert.match(String(br.headers.vary), /Accept-Encoding/i);
    assert.match(String(br.headers['cache-control']), /max-age=3600/);

    const gz = await get(base, { 'accept-encoding': 'gzip', 'if-none-match': GZIP_TAG });
    assert.equal(gz.status, 304);
    assert.equal(gz.headers.etag, GZIP_TAG);

    const id = await get(base, { 'if-none-match': ID_TAG });
    assert.equal(id.status, 304);
    assert.equal(id.headers.etag, ID_TAG);
  });

  it('never lets one encoding\'s tag confirm another encoding\'s body', async () => {
    // Client holds the gzip copy but now asks for br: it must get the br body, not a 304.
    const wantsBr = await get(base, { 'accept-encoding': 'br', 'if-none-match': GZIP_TAG });
    assert.equal(wantsBr.status, 200);
    assert.equal(wantsBr.headers['content-encoding'], 'br');
    assert.equal(wantsBr.headers.etag, BR_TAG);

    // Client holds the br copy but only accepts gzip: full gzip body.
    const wantsGzip = await get(base, { 'accept-encoding': 'gzip', 'if-none-match': BR_TAG });
    assert.equal(wantsGzip.status, 200);
    assert.equal(wantsGzip.headers['content-encoding'], 'gzip');
    assert.equal(wantsGzip.headers.etag, GZIP_TAG);
  });

  it('accepts weak and list forms of If-None-Match', async () => {
    const res = await get(base, { 'accept-encoding': 'br', 'if-none-match': `"other", W/${BR_TAG}` });
    assert.equal(res.status, 304);
  });
});
