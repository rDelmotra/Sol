import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FileBlobStore } from '../../src/utils/storage/file-store.ts';
import { Mirror, MTIME_TOLERANCE_MS, type MirrorSpec } from '../../src/utils/storage/mirror.ts';
import type { BlobStore } from '../../src/utils/storage/types.ts';
import { initMirror, mirrorSpec, resetMirrorForTests } from '../../src/utils/storage/mirror-runtime.ts';
import { cacheAgeMs, isCacheFresh, writeCache } from '../../src/cache/file-cache.ts';

const NOW = Date.now();
const HOUR = 3_600_000;
const SPEC: MirrorSpec = { files: ['a.json', 'version.json'], dirs: ['dso'], archiveDirs: ['history/raw'] };

function write(root: string, rel: string, text: string, mtimeMs = NOW): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const mtime = (root: string, rel: string) => fs.statSync(path.join(root, rel)).mtimeMs;
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));

describe('Mirror', () => {
  let local: string;
  let remoteDir: string;
  let remote: FileBlobStore;

  beforeEach(() => {
    local = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-mirror-local-'));
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-mirror-remote-'));
    remote = new FileBlobStore(remoteDir);
  });
  afterEach(() => {
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it('uploads a local-only file and keeps its mtime', async () => {
    write(local, 'a.json', 'A', NOW - 5 * HOUR);
    const report = await new Mirror(local, remote, SPEC).syncAtBoot();
    assert.deepEqual(report.uploaded, ['a.json']);
    assert.equal(read(remoteDir, 'a.json'), 'A');
    assert.ok(Math.abs(mtime(remoteDir, 'a.json') - (NOW - 5 * HOUR)) < 5);
  });

  it('downloads a remote-only file onto an empty disk and restores its mtime', async () => {
    write(remoteDir, 'a.json', 'A', NOW - 30 * HOUR);
    const report = await new Mirror(local, remote, SPEC).syncAtBoot();
    assert.deepEqual(report.downloaded, ['a.json']);
    assert.equal(read(local, 'a.json'), 'A');
    assert.ok(Math.abs(mtime(local, 'a.json') - (NOW - 30 * HOUR)) < 5, 'age survives a fresh disk');
  });

  it('when both exist the newer side wins, in either direction', async () => {
    write(local, 'a.json', 'local-new', NOW);
    write(remoteDir, 'a.json', 'remote-old', NOW - HOUR);
    write(local, 'version.json', 'local-old', NOW - HOUR);
    write(remoteDir, 'version.json', 'remote-new', NOW);
    const report = await new Mirror(local, remote, SPEC).syncAtBoot();
    assert.deepEqual(report.uploaded, ['a.json']);
    assert.deepEqual(report.downloaded, ['version.json']);
    assert.equal(read(remoteDir, 'a.json'), 'local-new');
    assert.equal(read(local, 'version.json'), 'remote-new');
  });

  it('does nothing when the mtimes agree within the tolerance', async () => {
    write(local, 'a.json', 'same', NOW);
    write(remoteDir, 'a.json', 'same-ish', NOW - MTIME_TOLERANCE_MS + 500);
    const report = await new Mirror(local, remote, SPEC).syncAtBoot();
    assert.equal(report.uploaded.length + report.downloaded.length, 0);
    assert.equal(report.skipped, 1);
    assert.equal(read(local, 'a.json'), 'same');
    assert.equal(read(remoteDir, 'a.json'), 'same-ish');
  });

  it('syncs the union of a mutable dir, nested files included', async () => {
    write(local, 'dso/catalog.json', 'cat');
    write(remoteDir, 'dso/snapshots/artemis/v1.json', 'eph');
    const report = await new Mirror(local, remote, SPEC).syncAtBoot();
    assert.deepEqual(report.uploaded, ['dso/catalog.json']);
    assert.deepEqual(report.downloaded, ['dso/snapshots/artemis/v1.json']);
    assert.equal(read(local, 'dso/snapshots/artemis/v1.json'), 'eph');
  });

  it('archive dirs: uploads local files missing remotely, never downloads, skips same-size files', async () => {
    write(local, 'history/raw/2026-10-01.json.gz', 'one');
    write(local, 'history/raw/2026-10-02.json.gz', 'two');
    write(remoteDir, 'history/raw/2026-10-02.json.gz', 'TWO'); // same size: already backed up
    write(remoteDir, 'history/raw/2026-09-30.json.gz', 'old'); // remote only: stays remote
    const m = new Mirror(local, remote, SPEC);
    await m.syncAtBoot();
    await m.waitForArchiveSync();
    assert.equal(read(remoteDir, 'history/raw/2026-10-01.json.gz'), 'one');
    assert.equal(read(remoteDir, 'history/raw/2026-10-02.json.gz'), 'TWO', 'a same-size remote copy is left alone');
    assert.equal(exists(local, 'history/raw/2026-09-30.json.gz'), false, 'archives are never downloaded');
  });

  it('never deletes anything on either side', async () => {
    write(local, 'a.json', 'A');
    const m = new Mirror(local, remote, SPEC);
    await m.syncAtBoot();
    fs.rmSync(path.join(local, 'a.json'));
    await m.flush();
    assert.equal(read(remoteDir, 'a.json'), 'A');
  });

  it('flush uploads a change once and then stays quiet', async () => {
    const m = new Mirror(local, remote, SPEC);
    await m.syncAtBoot();
    write(local, 'a.json', 'v1', NOW);
    assert.deepEqual((await m.flush()).uploaded, ['a.json']);
    assert.equal((await m.flush()).uploaded.length, 0);
    write(local, 'a.json', 'v2-longer', NOW + 5_000);
    assert.deepEqual((await m.flush()).uploaded, ['a.json']);
    assert.equal(read(remoteDir, 'a.json'), 'v2-longer');
  });

  it('a downloaded file is not uploaded again by the next flush', async () => {
    write(remoteDir, 'a.json', 'A', NOW - 3 * HOUR);
    const m = new Mirror(local, remote, SPEC);
    await m.syncAtBoot();
    assert.equal((await m.flush()).uploaded.length, 0);
  });

  it('a failing remote is logged, never thrown, and retried on the next flush', async () => {
    let failing = true;
    const flaky: BlobStore = {
      kind: 's3',
      put: async (k, d, o) => { if (failing) throw new Error('bucket down'); return remote.put(k, d, o); },
      get: (k) => remote.get(k),
      stat: (k) => remote.stat(k),
      list: (p) => remote.list(p),
      delete: (k) => remote.delete(k),
    };
    write(local, 'a.json', 'A');
    const m = new Mirror(local, flaky, SPEC);
    const boot = await m.syncAtBoot();
    assert.equal(boot.failed, 1);
    assert.equal((await m.flush()).failed, 1);
    failing = false;
    assert.deepEqual((await m.flush()).uploaded, ['a.json']);
    assert.equal(read(remoteDir, 'a.json'), 'A');
  });

  it('close() gives up after the timeout when the remote hangs', async () => {
    const hanging: BlobStore = {
      kind: 's3',
      put: () => new Promise<void>(() => {}),
      get: (k) => remote.get(k),
      stat: (k) => remote.stat(k),
      list: (p) => remote.list(p),
      delete: (k) => remote.delete(k),
    };
    write(local, 'a.json', 'A');
    const m = new Mirror(local, hanging, { files: ['a.json'], dirs: [], archiveDirs: [] });
    const started = Date.now();
    await m.close(150);
    assert.ok(Date.now() - started < 2_000);
  });

  it('a fresh disk keeps the catalog age: a 30 h old catalog must still look stale after a restore', async () => {
    const saved = process.env.CACHE_DIR;
    try {
      process.env.CACHE_DIR = local;
      writeCache([{ noradId: 1 } as never]);
      const old = new Date(Date.now() - 30 * HOUR);
      fs.utimesSync(path.join(local, 'tle-cache.json'), old, old);
      assert.equal(isCacheFresh(), false);

      const m = new Mirror(local, remote, { ...SPEC, files: ['tle-cache.json', 'version.json'] });
      await m.syncAtBoot();

      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-mirror-fresh-'));
      try {
        process.env.CACHE_DIR = fresh;
        const m2 = new Mirror(fresh, remote, { ...SPEC, files: ['tle-cache.json', 'version.json'] });
        await m2.syncAtBoot();
        assert.ok((cacheAgeMs() ?? 0) > 29 * HOUR, `age should survive the restore, got ${cacheAgeMs()}`);
        assert.equal(isCacheFresh(), false, 'a stale catalog must not look fresh on a new disk');
      } finally {
        fs.rmSync(fresh, { recursive: true, force: true });
      }
    } finally {
      if (saved === undefined) delete process.env.CACHE_DIR; else process.env.CACHE_DIR = saved;
    }
  });
});

describe('mirror runtime', () => {
  const names = ['STORAGE_BACKEND', 'AWS_S3_BUCKET_NAME', 'AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'AWS_DEFAULT_REGION', 'BUCKET', 'ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION', 'CACHE_DIR', 'HISTORY_ARCHIVE_DIR'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const n of names) { saved[n] = process.env[n]; delete process.env[n]; }
    resetMirrorForTests();
  });
  afterEach(() => {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    resetMirrorForTests();
  });

  it('is off by default and when the bucket variables are incomplete', () => {
    assert.equal(initMirror(), null);
    process.env.STORAGE_BACKEND = 's3';
    assert.equal(initMirror(), null);
  });

  it('turns on with STORAGE_BACKEND=s3 and the AWS preset variables, and is reused', () => {
    process.env.STORAGE_BACKEND = 's3';
    Object.assign(process.env, {
      AWS_S3_BUCKET_NAME: 'b', AWS_ENDPOINT_URL: 'https://t3.storageapi.dev', AWS_ACCESS_KEY_ID: 'i',
      AWS_SECRET_ACCESS_KEY: 's', AWS_DEFAULT_REGION: 'auto',
    });
    const m = initMirror();
    assert.ok(m);
    assert.equal(initMirror(), m);
  });

  it('mirrors history/raw only when the archive is under CACHE_DIR', () => {
    process.env.CACHE_DIR = '/tmp/ow-x';
    assert.deepEqual(mirrorSpec().archiveDirs, ['history/raw']);
    process.env.HISTORY_ARCHIVE_DIR = '/somewhere/else';
    assert.deepEqual(mirrorSpec().archiveDirs, []);
  });

  it('lists the catalog before its version marker and covers the state files and dso/', () => {
    const spec = mirrorSpec();
    assert.ok(spec.files.indexOf('tle-cache.json') < spec.files.indexOf('version.json'));
    for (const f of ['spacetrack-attempts.json', 'celestrak-attempts.json', 'alert-state.json']) assert.ok(spec.files.includes(f));
    assert.deepEqual(spec.dirs, ['dso']);
  });
});
