import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  FileBlobStore,
  S3BlobStore,
  assertSafeKey,
  createBlobStore,
  isNotFound,
  resetStorageWarningsForTests,
  type BlobInfo,
  type S3Ops,
} from '../../src/utils/storage/index.ts';
import { bucketConfig, storageBackend } from '../../src/utils/config.ts';

/** In-memory S3Ops: the whole bucket in a Map, with a page size to exercise pagination. */
function fakeOps(objects = new Map<string, Buffer>()): S3Ops & { objects: Map<string, Buffer>; listCalls: string[]; metas: Map<string, number | undefined> } {
  const listCalls: string[] = [];
  return {
    objects,
    listCalls,
    metas: new Map<string, number | undefined>(),
    async put(key, body, mtimeMs) { objects.set(key, Buffer.from(body)); this.metas.set(key, mtimeMs); },
    async head(key) {
      const buf = objects.get(key);
      return buf ? { size: buf.length, lastModifiedMs: 1_000, mtimeMs: this.metas.get(key) } : null;
    },
    async get(key) { return objects.get(key) ?? null; },
    async list(prefix) {
      listCalls.push(prefix);
      const out: BlobInfo[] = [];
      for (const [key, buf] of objects) if (key.startsWith(prefix)) out.push({ key, size: buf.length });
      return out;
    },
    async delete(key) { objects.delete(key); },
  };
}

describe('assertSafeKey', () => {
  it('accepts normal relative keys', () => {
    assert.doesNotThrow(() => assertSafeKey('a.json'));
    assert.doesNotThrow(() => assertSafeKey('history/raw/2026-10-24.json.gz'));
  });
  it('rejects empty, absolute, traversal, dot, double-slash, backslash and NUL keys', () => {
    for (const bad of ['', '/abs', '../x', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'a\0b']) {
      assert.throws(() => assertSafeKey(bad), `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('FileBlobStore', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-store-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('round-trips bytes and creates missing directories', async () => {
    const store = new FileBlobStore(path.join(root, 'deep', 'er'));
    await store.put('a/b/c.bin', Buffer.from([1, 2, 3]));
    assert.deepEqual(await store.get('a/b/c.bin'), Buffer.from([1, 2, 3]));
  });

  it('writes the file at root/<key> and leaves no .tmp behind', async () => {
    const store = new FileBlobStore(root);
    await store.put('2026-10-24.json.gz', Buffer.from('x'));
    assert.deepEqual(fs.readdirSync(root), ['2026-10-24.json.gz']);
  });

  it('replaces an existing object', async () => {
    const store = new FileBlobStore(root);
    await store.put('k', Buffer.from('old'));
    await store.put('k', Buffer.from('new'));
    assert.equal((await store.get('k'))?.toString(), 'new');
  });

  it('get returns null for a missing key or a missing root', async () => {
    assert.equal(await new FileBlobStore(root).get('nope'), null);
    assert.equal(await new FileBlobStore(path.join(root, 'absent')).get('nope'), null);
  });

  it('list filters by prefix, sorts, reports sizes and ignores .tmp files', async () => {
    const store = new FileBlobStore(root);
    await store.put('raw/2026-10-02.gz', Buffer.alloc(5));
    await store.put('raw/2026-10-01.gz', Buffer.alloc(3));
    await store.put('other/x', Buffer.alloc(1));
    fs.writeFileSync(path.join(root, 'raw', 'half.gz.tmp'), 'partial');
    assert.deepEqual(await store.list('raw/'), [
      { key: 'raw/2026-10-01.gz', size: 3 },
      { key: 'raw/2026-10-02.gz', size: 5 },
    ]);
    assert.equal((await store.list()).length, 3);
    assert.deepEqual(await new FileBlobStore(path.join(root, 'absent')).list(), []);
  });

  it('put can set the mtime and stat reads it back; stat of a missing key is null', async () => {
    const store = new FileBlobStore(root);
    await store.put('k', Buffer.from('abcd'), { mtimeMs: 1_700_000_000_000 });
    const st = await store.stat('k');
    assert.equal(st?.size, 4);
    assert.ok(Math.abs((st?.mtimeMs ?? 0) - 1_700_000_000_000) < 5);
    assert.equal(await store.stat('nope'), null);
    assert.deepEqual(fs.readdirSync(root), ['k'], 'no temp file left behind');
  });

  it('delete removes the object and tolerates a missing one', async () => {
    const store = new FileBlobStore(root);
    await store.put('k', Buffer.from('v'));
    await store.delete('k');
    await store.delete('k');
    assert.equal(await store.get('k'), null);
  });

  it('refuses keys that would leave the root', async () => {
    const store = new FileBlobStore(root);
    await assert.rejects(store.put('../escape', Buffer.from('x')));
    await assert.rejects(store.get('/etc/passwd'));
  });
});

describe('S3BlobStore', () => {
  it('stores under the prefix and strips it again on list', async () => {
    const ops = fakeOps();
    const store = new S3BlobStore(async () => ops, 'history/raw');
    await store.put('2026-10-24.json.gz', Buffer.from('abc'));
    assert.ok(ops.objects.has('history/raw/2026-10-24.json.gz'));
    assert.deepEqual(await store.list(), [{ key: '2026-10-24.json.gz', size: 3 }]);
    assert.deepEqual(ops.listCalls, ['history/raw/']);
  });

  it('get returns the bytes, or null for a missing key', async () => {
    const store = new S3BlobStore(async () => fakeOps(), 'p');
    await store.put('k', Buffer.from('v'));
    assert.equal((await store.get('k'))?.toString(), 'v');
    assert.equal(await store.get('missing'), null);
  });

  it('does not list objects outside its prefix', async () => {
    const ops = fakeOps(new Map([['p/a', Buffer.from('1')], ['pp/b', Buffer.from('2')], ['q/c', Buffer.from('3')]]));
    const store = new S3BlobStore(async () => ops, 'p');
    assert.deepEqual((await store.list()).map((o) => o.key), ['a']);
  });

  it('works with no prefix and deletes', async () => {
    const ops = fakeOps();
    const store = new S3BlobStore(async () => ops);
    await store.put('k', Buffer.from('v'));
    await store.delete('k');
    assert.equal(ops.objects.size, 0);
  });

  it('validates keys and never loads ops until first use', async () => {
    let loaded = 0;
    const store = new S3BlobStore(async () => { loaded++; return fakeOps(); }, 'p');
    assert.equal(loaded, 0);
    await assert.rejects(store.put('../x', Buffer.from('v')));
    assert.equal(loaded, 0);
    await store.put('ok', Buffer.from('v'));
    await store.get('ok');
    assert.equal(loaded, 1, 'ops are loaded once and reused');
  });

  it('stat reports size and the preserved mtime, falling back to the upload time', async () => {
    const ops = fakeOps();
    const store = new S3BlobStore(async () => ops, 'p');
    assert.equal(await store.stat('missing'), null);
    await store.put('with-mtime', Buffer.from('abc'), { mtimeMs: 123_456 });
    await store.put('without', Buffer.from('xy'));
    assert.deepEqual(await store.stat('with-mtime'), { size: 3, mtimeMs: 123_456 });
    assert.deepEqual(await store.stat('without'), { size: 2, mtimeMs: 1_000 });
  });

  it('isNotFound recognises the SDK shapes', () => {
    assert.equal(isNotFound({ name: 'NoSuchKey' }), true);
    assert.equal(isNotFound({ $metadata: { httpStatusCode: 404 } }), true);
    assert.equal(isNotFound({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }), false);
    assert.equal(isNotFound(null), false);
  });
});

describe('createBlobStore / env', () => {
  const names = ['STORAGE_BACKEND', 'BUCKET', 'ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION', 'S3_PATH_STYLE',
    'AWS_S3_BUCKET_NAME', 'AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const n of names) { saved[n] = process.env[n]; delete process.env[n]; }
    resetStorageWarningsForTests();
  });
  afterEach(() => {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  });

  function setBucketVars() {
    Object.assign(process.env, {
      BUCKET: 'b-123', ENDPOINT: 'https://t3.storageapi.dev', ACCESS_KEY_ID: 'id', SECRET_ACCESS_KEY: 'sec', REGION: 'auto',
    });
  }

  it('defaults to the file backend', () => {
    assert.equal(storageBackend(), 'file');
    assert.equal(createBlobStore({ fileRoot: '/tmp/x' }).kind, 'file');
  });

  it('treats unknown STORAGE_BACKEND values as file', () => {
    process.env.STORAGE_BACKEND = 'gcs';
    assert.equal(storageBackend(), 'file');
    assert.equal(createBlobStore({ fileRoot: '/tmp/x' }).kind, 'file');
  });

  it('selects s3 only when asked AND the bucket variables are complete', () => {
    process.env.STORAGE_BACKEND = 'S3';
    setBucketVars();
    assert.equal(createBlobStore({ fileRoot: '/tmp/x' }).kind, 's3');
  });

  it('falls back to files when s3 is requested but a bucket variable is missing', () => {
    process.env.STORAGE_BACKEND = 's3';
    setBucketVars();
    delete process.env.SECRET_ACCESS_KEY;
    assert.equal(bucketConfig(), null);
    assert.equal(createBlobStore({ fileRoot: '/tmp/x' }).kind, 'file');
  });

  it('bucketConfig prefers the AWS SDK preset names over the bare Railway ones', () => {
    setBucketVars();
    Object.assign(process.env, {
      AWS_S3_BUCKET_NAME: 'aws-b', AWS_ENDPOINT_URL: 'https://aws.example', AWS_ACCESS_KEY_ID: 'aid',
      AWS_SECRET_ACCESS_KEY: 'asec', AWS_DEFAULT_REGION: 'ams',
    });
    try {
      assert.deepEqual(bucketConfig(), {
        bucket: 'aws-b', endpoint: 'https://aws.example', accessKeyId: 'aid', secretAccessKey: 'asec', region: 'ams', pathStyle: false,
      });
    } finally {
      for (const n of ['AWS_S3_BUCKET_NAME', 'AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION']) delete process.env[n];
    }
  });

  it('bucketConfig reads the Railway names and the path-style flag', () => {
    setBucketVars();
    process.env.S3_PATH_STYLE = '1';
    assert.deepEqual(bucketConfig(), {
      bucket: 'b-123', endpoint: 'https://t3.storageapi.dev', accessKeyId: 'id', secretAccessKey: 'sec', region: 'auto', pathStyle: true,
    });
  });

  it('uses an injected s3Ops (the test seam) and the prefix', async () => {
    process.env.STORAGE_BACKEND = 's3';
    const ops = fakeOps();
    const store = createBlobStore({ fileRoot: '/tmp/x', s3Prefix: 'history/raw', s3Ops: async () => ops });
    await store.put('d.gz', Buffer.from('v'));
    assert.ok(ops.objects.has('history/raw/d.gz'));
  });
});
