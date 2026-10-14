// DSO snapshot housekeeping: older generations are MOVED to snapshots/<id>/archive/,
// never deleted. Real temp dir under CACHE_DIR; no network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import type { DsoManifest, DsoSnapshot } from '@orbitwatch/contracts';
import {
  SNAPSHOT_ARCHIVE_DIR,
  SNAPSHOT_RETENTION_COUNT,
  getDsoSnapshotPath,
  getDsoSnapshotsRoot,
  pruneSnapshotGenerations,
  publishDsoSnapshot,
  readDsoManifest,
  readDsoSnapshot,
} from '../../../src/dso/snapshot/index.ts';
import { getDsoRegistryEntry } from '../../../src/dso/registry/index.ts';

const ID = 'artemis-ii';

describe('pruneSnapshotGenerations — archive, never delete', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];

  const dir = () => path.join(getDsoSnapshotsRoot(), ID);
  const archive = () => path.join(dir(), SNAPSHOT_ARCHIVE_DIR);
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

  it('keeps 3 snapshots in the live folder', () => {
    assert.equal(SNAPSHOT_RETENTION_COUNT, 3);
  });

  it('5 snapshots: the newest 3 stay, the 2 oldest are archived with their content, none deleted', async () => {
    seed('v1', 'v2', 'v3', 'v4', 'v5');
    await pruneSnapshotGenerations(ID);

    assert.deepEqual(list(dir()), ['archive', 'v3.json', 'v4.json', 'v5.json']);
    assert.deepEqual(list(archive()), ['v1.json', 'v2.json']);
    assert.equal(fs.readFileSync(path.join(archive(), 'v1.json'), 'utf8'), 'body-v1');
    assert.equal(fs.readFileSync(path.join(archive(), 'v2.json'), 'utf8'), 'body-v2');
    assert.ok(lines.some((l) => l.includes('DSO snapshots archived') && l.includes('moved=2')));
  });

  it('3 or fewer snapshots: nothing moves and no archive folder is made', async () => {
    seed('v1', 'v2', 'v3');
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['v1.json', 'v2.json', 'v3.json']);
    assert.equal(fs.existsSync(archive()), false);
  });

  it('running it again changes nothing', async () => {
    seed('v1', 'v2', 'v3', 'v4', 'v5');
    await pruneSnapshotGenerations(ID);
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['archive', 'v3.json', 'v4.json', 'v5.json']);
    assert.deepEqual(list(archive()), ['v1.json', 'v2.json']);
  });

  it('a name clash in the archive gets a numeric suffix and the old archived file is untouched', async () => {
    fs.mkdirSync(archive(), { recursive: true });
    fs.writeFileSync(path.join(archive(), 'v1.json'), 'ARCHIVED-EARLIER', 'utf8');
    seed('v1', 'v2', 'v3', 'v4');

    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(archive()), ['v1.1.json', 'v1.json']);
    assert.equal(fs.readFileSync(path.join(archive(), 'v1.json'), 'utf8'), 'ARCHIVED-EARLIER');
    assert.equal(fs.readFileSync(path.join(archive(), 'v1.1.json'), 'utf8'), 'body-v1');

    // v1 comes back once more, and v1.json and v1.1.json are both taken -> v1.2.json
    seed('v1');
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(archive()), ['v1.1.json', 'v1.2.json', 'v1.json']);
    assert.equal(fs.readFileSync(path.join(archive(), 'v1.json'), 'utf8'), 'ARCHIVED-EARLIER');
    assert.equal(fs.readFileSync(path.join(archive(), 'v1.1.json'), 'utf8'), 'body-v1');
    assert.equal(fs.readFileSync(path.join(archive(), 'v1.2.json'), 'utf8'), 'body-v1');
  });

  it('orphaned .tmp files are removed, even when there is nothing to archive', async () => {
    seed('v1', 'v2');
    fs.writeFileSync(path.join(dir(), 'v3.json.tmp'), 'half written', 'utf8');
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['v1.json', 'v2.json']);
  });

  it('a .tmp file is removed, not archived, while old snapshots are archived', async () => {
    seed('v1', 'v2', 'v3', 'v4');
    fs.writeFileSync(path.join(dir(), 'v5.json.tmp'), 'half written', 'utf8');
    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['archive', 'v2.json', 'v3.json', 'v4.json']);
    assert.deepEqual(list(archive()), ['v1.json']);
  });

  it('files already in archive/ are never touched and do not count toward the 3', async () => {
    fs.mkdirSync(archive(), { recursive: true });
    for (const v of ['a1', 'a2', 'a3', 'a4', 'a5']) fs.writeFileSync(path.join(archive(), `${v}.json`), v, 'utf8');
    fs.writeFileSync(path.join(archive(), 'old.json.tmp'), 'x', 'utf8');
    seed('v1', 'v2', 'v3');

    await pruneSnapshotGenerations(ID);
    assert.deepEqual(list(dir()), ['archive', 'v1.json', 'v2.json', 'v3.json']);
    assert.deepEqual(list(archive()), ['a1.json', 'a2.json', 'a3.json', 'a4.json', 'a5.json', 'old.json.tmp']);
  });

  it('readers use the top-level files only: an archived version is no longer served, the rest are', async () => {
    seed('v1', 'v2', 'v3', 'v4');
    await pruneSnapshotGenerations(ID);
    assert.ok(fs.existsSync(path.join(archive(), 'v1.json')));
    assert.equal(getDsoSnapshotPath(ID, 'v1'), path.join(dir(), 'v1.json'));
    assert.equal(await readDsoSnapshot(ID, 'v1'), null, 'archive/ is not a read path');

    fs.writeFileSync(path.join(dir(), 'v4.json'), JSON.stringify({ snapshotVersion: 'v4' }), 'utf8');
    assert.deepEqual(await readDsoSnapshot(ID, 'v4'), { snapshotVersion: 'v4' } as unknown as DsoSnapshot);
  });

  it('a missing folder is fine', async () => {
    await pruneSnapshotGenerations('does-not-exist');
    assert.equal(lines.some((l) => l.includes('WARN')), false);
  });

  it('a failure to archive is logged, nothing is lost and publishing is not broken', async () => {
    seed('v1', 'v2', 'v3', 'v4', 'v5');
    fs.writeFileSync(archive(), 'i am a file, not a folder', 'utf8'); // mkdir archive/ must fail

    await pruneSnapshotGenerations(ID); // does not throw
    assert.deepEqual(list(dir()), ['archive', 'v1.json', 'v2.json', 'v3.json', 'v4.json', 'v5.json']);
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) {
      assert.equal(fs.readFileSync(path.join(dir(), `${v}.json`), 'utf8'), `body-${v}`);
    }
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('housekeeping') && l.includes('retried next publish')));
  });

  it('through the real publish path: 5 publishes leave 3 live, 2 archived, manifest on the newest', async () => {
    const entry = getDsoRegistryEntry(ID)!;
    const versions = [
      '2026-10-01T000000Z',
      '2026-10-02T000000Z',
      '2026-10-03T000000Z',
      '2026-10-04T000000Z',
      '2026-10-05T000000Z',
    ];
    let manifest: DsoManifest | null = null;
    for (const v of versions) {
      const snapshot = {
        dsoId: ID,
        snapshotVersion: v,
        fetchedAt: `${v.slice(0, 10)}T00:00:00.000Z`,
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: '2026-10-06T00:00:00.000Z',
        stateVectors: [],
      } as unknown as DsoSnapshot;
      ({ manifest } = await publishDsoSnapshot(entry, snapshot, manifest, null));
    }

    assert.deepEqual(list(dir()), [
      '2026-10-03T000000Z.json',
      '2026-10-04T000000Z.json',
      '2026-10-05T000000Z.json',
      'archive',
    ]);
    assert.deepEqual(list(archive()), ['2026-10-01T000000Z.json', '2026-10-02T000000Z.json']);
    const onDisk = await readDsoManifest();
    assert.equal(onDisk?.objects[ID].currentSnapshotVersion, '2026-10-05T000000Z');
    assert.equal((await readDsoSnapshot(ID, '2026-10-05T000000Z'))?.snapshotVersion, '2026-10-05T000000Z');
  });
});
