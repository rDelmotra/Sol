// DSO snapshot housekeeping: only the newest snapshot is served; the newest 3 files
// are kept and older ones are DELETED, and only after the manifest points at the new one.
// Real temp dir under CACHE_DIR; no network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import type { DsoManifest, DsoSnapshot } from '@orbitwatch/contracts';
import {
  SNAPSHOT_RETENTION_COUNT,
  getDsoSnapshotPath,
  getDsoSnapshotsRoot,
  pruneSnapshotGenerations,
  publishDsoSnapshot,
  readCurrentDsoSnapshot,
  readDsoManifest,
  readDsoSnapshot,
} from '../../../src/dso/snapshot/index.ts';
import { getDsoRegistryEntry } from '../../../src/dso/registry/index.ts';

const ID = 'artemis-ii';

const VERSIONS = [
  '2026-10-01T000000Z',
  '2026-10-02T000000Z',
  '2026-10-03T000000Z',
  '2026-10-04T000000Z',
  '2026-10-05T000000Z',
];

/** A snapshot whose two samples sit at the SAME times in every version, with values tagged by `tag`. */
function makeSnapshot(version: string, tag: number): DsoSnapshot {
  return {
    dsoId: ID,
    snapshotVersion: version,
    fetchedAt: `${version.slice(0, 10)}T00:00:00.000Z`,
    validFrom: '2026-10-01T00:00:00.000Z',
    validTo: '2026-10-06T00:00:00.000Z',
    stateVectors: [
      ['2026-10-02T00:00:00.000Z', tag, tag, tag, 0, 0, 0],
      ['2026-10-02T00:10:00.000Z', tag + 0.5, tag, tag, 0, 0, 0],
    ],
  } as unknown as DsoSnapshot;
}

describe('pruneSnapshotGenerations — newest 3 kept, older deleted', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];

  const dir = () => path.join(getDsoSnapshotsRoot(), ID);
  const list = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

  /** Versions given, content 'body-<version>'. */
  function seed(...versions: string[]): void {
    fs.mkdirSync(dir(), { recursive: true });
    for (const v of versions) fs.writeFileSync(path.join(dir(), `${v}.json`), `body-${v}`, 'utf8');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dso-prune-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    lines = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });

  afterEach(() => {
    mock.restoreAll();
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps 3 snapshots', () => {
    assert.equal(SNAPSHOT_RETENTION_COUNT, 3);
  });

  it('5 snapshots: the newest 3 stay, the 2 oldest are deleted, nothing is moved anywhere', async () => {
    seed('v1', 'v2', 'v3', 'v4', 'v5');
    await pruneSnapshotGenerations(ID);

    assert.deepEqual(list(dir()), ['v3.json', 'v4.json', 'v5.json']);
    assert.equal(fs.existsSync(path.join(dir(), 'archive')), false, 'no archive folder is made');
  });

  it('3 or fewer snapshots: nothing is deleted', async () => {
    seed('v1', 'v2', 'v3');
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['v1.json', 'v2.json', 'v3.json']);
  });

  it('running it again changes nothing', async () => {
    seed('v1', 'v2', 'v3', 'v4', 'v5');
    await pruneSnapshotGenerations(ID);
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['v3.json', 'v4.json', 'v5.json']);
  });

  it('orphaned .tmp files are removed, even when there are no old snapshots', async () => {
    seed('v1', 'v2');
    fs.writeFileSync(path.join(dir(), 'v3.json.tmp'), 'half written', 'utf8');
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['v1.json', 'v2.json']);
  });

  it('a .tmp file and old snapshots are removed together', async () => {
    seed('v1', 'v2', 'v3', 'v4');
    fs.writeFileSync(path.join(dir(), 'v5.json.tmp'), 'half written', 'utf8');
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['v2.json', 'v3.json', 'v4.json']);
  });

  it('the version the manifest points to is never deleted, even if its name sorts oldest', async () => {
    seed('v1', 'v2', 'v3', 'v4', 'v5');
    await pruneSnapshotGenerations(ID, 'v1');
    assert.deepEqual(list(dir()), ['v1.json', 'v3.json', 'v4.json', 'v5.json']);
    assert.equal(fs.readFileSync(path.join(dir(), 'v1.json'), 'utf8'), 'body-v1');
  });

  it('a missing folder is fine', async () => {
    await pruneSnapshotGenerations('does-not-exist');
    assert.equal(lines.some((l) => l.includes('WARN')), false);
  });

  it('a file that cannot be deleted is logged and the others are still deleted; it does not throw', async () => {
    seed('v1', 'v2', 'v3', 'v4', 'v5');
    const real = fsp.unlink.bind(fsp);
    mock.method(fsp, 'unlink', async (p: string) => {
      if (String(p).endsWith('v1.json')) throw Object.assign(new Error('EPERM: no'), { code: 'EPERM' });
      return real(p);
    });

    await pruneSnapshotGenerations(ID); // does not throw
    assert.deepEqual(list(dir()), ['v1.json', 'v3.json', 'v4.json', 'v5.json']);
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('housekeeping') && l.includes('v1.json')));

    mock.restoreAll();
    await pruneSnapshotGenerations(ID); // retried on the next publish
    assert.deepEqual(list(dir()), ['v3.json', 'v4.json', 'v5.json']);
  });

  it('through the real publish path: 5 publishes leave 3 files, the manifest on the newest, the 2 oldest deleted', async () => {
    const entry = getDsoRegistryEntry(ID)!;
    let manifest: DsoManifest | null = null;
    for (const [i, v] of VERSIONS.entries()) {
      ({ manifest } = await publishDsoSnapshot(entry, makeSnapshot(v, i + 1), manifest, null));
    }

    assert.deepEqual(list(dir()), [
      '2026-10-03T000000Z.json',
      '2026-10-04T000000Z.json',
      '2026-10-05T000000Z.json',
    ]);
    const onDisk = await readDsoManifest();
    assert.equal(onDisk?.objects[ID].currentSnapshotVersion, VERSIONS[4]);
    assert.equal(onDisk?.objects[ID].snapshotPath, `snapshots/${ID}/${VERSIONS[4]}.json`);
    assert.equal((await readDsoSnapshot(ID, VERSIONS[4]))?.snapshotVersion, VERSIONS[4]);
    assert.equal(await readDsoSnapshot(ID, VERSIONS[0]), null, 'the oldest file is gone');
    assert.equal(await readDsoSnapshot(ID, VERSIONS[1]), null, 'the second oldest file is gone');
  });

  it('order: older files are deleted only AFTER the manifest points at the new, newest snapshot', async () => {
    const entry = getDsoRegistryEntry(ID)!;
    let manifest: DsoManifest | null = null;
    for (const [i, v] of VERSIONS.slice(0, 3).entries()) {
      ({ manifest } = await publishDsoSnapshot(entry, makeSnapshot(v, i + 1), manifest, null));
    }
    assert.equal(list(dir()).length, 3, 'nothing to delete yet');

    // Spy on every delete of the next publish: at that moment the manifest on disk must already
    // name the new snapshot, and the new snapshot file must already be in place.
    const newest = VERSIONS[3];
    const real = fsp.unlink.bind(fsp);
    const seen: { file: string; manifestVersion: string | null; newestExists: boolean }[] = [];
    mock.method(fsp, 'unlink', async (p: string) => {
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'dso', 'manifest.json'), 'utf8')) as DsoManifest;
      seen.push({
        file: path.basename(String(p)),
        manifestVersion: onDisk.objects[ID].currentSnapshotVersion,
        newestExists: fs.existsSync(getDsoSnapshotPath(ID, newest)),
      });
      return real(p);
    });

    ({ manifest } = await publishDsoSnapshot(entry, makeSnapshot(newest, 4), manifest, null));
    mock.restoreAll();

    assert.deepEqual(seen.map((s) => s.file), [`${VERSIONS[0]}.json`], 'exactly the oldest file is deleted');
    for (const s of seen) {
      assert.equal(s.manifestVersion, newest, 'manifest already points at the new snapshot at delete time');
      assert.equal(s.newestExists, true, 'the new snapshot file already exists at delete time');
    }
    assert.deepEqual(list(dir()), [`${VERSIONS[1]}.json`, `${VERSIONS[2]}.json`, `${newest}.json`]);
    const files = list(dir());
    assert.equal(files[files.length - 1], `${(await readDsoManifest())?.objects[ID].currentSnapshotVersion}.json`, 'the current snapshot is the newest file');
  });

  it('a delete failure after the manifest is updated does not fail the publish', async () => {
    const entry = getDsoRegistryEntry(ID)!;
    let manifest: DsoManifest | null = null;
    for (const [i, v] of VERSIONS.slice(0, 3).entries()) {
      ({ manifest } = await publishDsoSnapshot(entry, makeSnapshot(v, i + 1), manifest, null));
    }
    mock.method(fsp, 'unlink', async () => {
      throw Object.assign(new Error('EACCES: nope'), { code: 'EACCES' });
    });

    const result = await publishDsoSnapshot(entry, makeSnapshot(VERSIONS[3], 4), manifest, null); // resolves
    mock.restoreAll();

    assert.equal(result.manifest.objects[ID].failureCount, 0);
    assert.equal((await readDsoManifest())?.objects[ID].currentSnapshotVersion, VERSIONS[3]);
    assert.equal((await readCurrentDsoSnapshot(ID))?.snapshotVersion, VERSIONS[3]);
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('housekeeping')));
  });

  it('a newer snapshot replaces older values for the same timestamps in what readers return', async () => {
    const entry = getDsoRegistryEntry(ID)!;
    let manifest: DsoManifest | null = null;
    for (const [i, v] of VERSIONS.entries()) {
      // same two timestamps every time; the values change with each new version (tag 1..5)
      ({ manifest } = await publishDsoSnapshot(entry, makeSnapshot(v, i + 1), manifest, null));
    }

    // Readers use only the manifest's current snapshot.
    const served = await readCurrentDsoSnapshot(ID);
    assert.equal(served?.snapshotVersion, VERSIONS[4]);
    assert.deepEqual(served?.stateVectors, [
      ['2026-10-02T00:00:00.000Z', 5, 5, 5, 0, 0, 0],
      ['2026-10-02T00:10:00.000Z', 5.5, 5, 5, 0, 0, 0],
    ]);
    // Same answer through the manifest object the route passes in.
    const viaManifest = await readCurrentDsoSnapshot(ID, await readDsoManifest());
    assert.deepEqual(viaManifest?.stateVectors, served?.stateVectors);

    // The old, wrong values for those times can no longer be read by version.
    assert.equal(await readDsoSnapshot(ID, VERSIONS[0]), null);
    assert.equal(await readDsoSnapshot(ID, VERSIONS[1]), null);
  });
});
