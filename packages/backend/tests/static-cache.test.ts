// Cache-Control for the built frontend. Real app on an ephemeral port serving a temp
// dist directory (never the real frontend build).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Router } from 'express';
import { createApp } from '../src/app.ts';
import { IMMUTABLE_CACHE_CONTROL, isHashedAsset } from '../src/utils/static-cache.ts';

const FOREVER = 'public, max-age=31536000, immutable';

describe('isHashedAsset', () => {
  it('accepts Vite-style name-HASH.ext files under assets/', () => {
    for (const f of [
      'assets/index-DsyFkHlK.js',
      'assets/CockpitHud-b4CsExtE.css',
      'assets/three--jg0PyQw.js', // hash may start with "-"
      'assets/key-guards-Hm8M21mE.js', // name has hyphens too
      'assets/dso.worker-Bea-Hs7n.js', // hash may contain "-"
      'assets/wasm_sgp4_bg-B5h8hpf0.wasm',
      'assets/sub/dir/chunk-A1b2C3d4E5.js',
    ]) {
      assert.equal(isHashedAsset(f), true, f);
    }
  });

  it('rejects files outside assets/', () => {
    for (const f of ['index.html', 'sw.js', 'favicon.svg', 'manifest.webmanifest', 'basis/basis_transcoder.js', 'index-DsyFkHlK.js', 'other/index-DsyFkHlK.js']) {
      assert.equal(isHashedAsset(f), false, f);
    }
  });

  it('rejects names without a clear hash', () => {
    for (const f of ['assets/plain.js', 'assets/logo.png', 'assets/short-abc123.js', 'assets/my-long-image.png', 'assets/index-DsyFkHlK', 'assets/index-DsyFkHlK.js.map']) {
      assert.equal(isHashedAsset(f), false, f);
    }
  });
});

describe('frontend static Cache-Control', () => {
  let server: Server;
  let base: string;
  let dir: string;

  const files: Record<string, string> = {
    'index.html': '<!doctype html><script type="module" src="/assets/index-DsyFkHlK.js"></script>',
    'sw.js': '// sw',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'manifest.webmanifest': '{}',
    'assets/index-DsyFkHlK.js': 'export {};',
    'assets/CockpitHud-b4CsExtE.css': 'a{}',
    'assets/three--jg0PyQw.js': 'export {};',
    'assets/wasm_sgp4_bg-B5h8hpf0.wasm': '\0asm',
    'assets/unhashed.js': 'export {};',
    'assets/my-long-image.png': 'png',
    'textures/earth-day.abcd1234.ktx2': 'ktx',
    'basis/basis_transcoder.js': 'export {};',
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    const app = createApp({ queryRouter: Router(), frontendDist: dir });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cc = async (url: string): Promise<{ status: number; cacheControl: string | null; res: Response }> => {
    const res = await fetch(`${base}${url}`);
    await res.arrayBuffer();
    return { status: res.status, cacheControl: res.headers.get('cache-control'), res };
  };

  it('the constant is the year-long immutable value', () => {
    assert.equal(IMMUTABLE_CACHE_CONTROL, FOREVER);
  });

  it('hashed files under /assets/ are cached for a year, immutable', async () => {
    for (const u of [
      '/assets/index-DsyFkHlK.js',
      '/assets/CockpitHud-b4CsExtE.css',
      '/assets/three--jg0PyQw.js',
      '/assets/wasm_sgp4_bg-B5h8hpf0.wasm',
    ]) {
      const r = await cc(u);
      assert.equal(r.status, 200, u);
      assert.equal(r.cacheControl, FOREVER, u);
    }
  });

  it('index.html (at / and /index.html) is revalidated, not long-cached', async () => {
    for (const u of ['/', '/index.html']) {
      const r = await cc(u);
      assert.equal(r.status, 200, u);
      assert.equal(r.cacheControl, 'public, max-age=0', u);
      assert.ok(r.res.headers.get('etag'), `${u} has an ETag to revalidate against`);
    }
  });

  it('sw.js is never HTTP-cached', async () => {
    const r = await cc('/sw.js');
    assert.equal(r.cacheControl, 'no-cache');
    assert.equal(r.res.headers.get('service-worker-allowed'), '/');
  });

  it('favicon, manifest and unhashed assets keep the default revalidate policy', async () => {
    for (const u of ['/favicon.svg', '/manifest.webmanifest', '/assets/unhashed.js', '/assets/my-long-image.png']) {
      const r = await cc(u);
      assert.equal(r.status, 200, u);
      assert.equal(r.cacheControl, 'public, max-age=0', u);
    }
  });

  it('textures and basis keep their existing policies', async () => {
    assert.equal((await cc('/textures/earth-day.abcd1234.ktx2')).cacheControl, FOREVER);
    assert.equal((await cc('/basis/basis_transcoder.js')).cacheControl, 'public, max-age=604800');
  });

  it('the SPA fallback (client routes and missing assets) is HTML and not long-cached', async () => {
    for (const u of ['/some/client/route', '/assets/index-GONEGONE.js']) {
      const r = await cc(u);
      assert.equal(r.status, 200, u);
      assert.match(r.res.headers.get('content-type') ?? '', /text\/html/, u);
      assert.notEqual(r.cacheControl, FOREVER, u);
      assert.ok(!(r.cacheControl ?? '').includes('immutable'), u);
    }
  });

  it('a conditional request for a hashed file still gets a 304', async () => {
    // Raw http: fetch() adds Cache-Control: no-cache to conditional requests, which makes the server skip the 304.
    const status = (headers: Record<string, string>): Promise<{ code: number; etag: string | undefined }> =>
      new Promise((resolve, reject) => {
        http.get(`${base}/assets/index-DsyFkHlK.js`, { headers, agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve({ code: res.statusCode ?? 0, etag: res.headers.etag }));
        }).on('error', reject);
      });
    const first = await status({});
    assert.equal(first.code, 200);
    assert.ok(first.etag);
    const second = await status({ 'if-none-match': first.etag });
    assert.equal(second.code, 304);
  });
});
