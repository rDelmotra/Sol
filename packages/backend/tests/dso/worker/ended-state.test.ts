// Persisted "ephemeris ended" state: atomic file under CACHE_DIR/dso, never throws on read,
// never touches snapshots, manifest or catalog.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import {
  clearDsoEnded,
  getDsoEndedStatePath,
  markDsoEnded,
  parseDsoEndedState,
  readDsoEndedState,
} from '../../../src/dso/worker/ended-state.ts';
import { dsoRetryEnded } from '../../../src/utils/config.ts';

describe('parseDsoEndedState', () => {
  it('keeps well formed entries and drops the rest', () => {
    const parsed = parseDsoEndedState({
      objects: {
        'artemis-ii': { endedAt: '2026-04-10T23:54:22.857Z', markedAt: '2026-10-14T01:00:00.000Z' },
        bad1: { endedAt: 'not a date', markedAt: '2026-10-14T01:00:00.000Z' },
        bad2: 'text',
        bad3: null,
        noMark: { endedAt: '2026-04-10T23:54:22.857Z' },
      },
    });
    assert.deepEqual(Object.keys(parsed!.objects).sort(), ['artemis-ii', 'noMark']);
    assert.equal(parsed!.objects.noMark.markedAt, '2026-04-10T23:54:22.857Z');
  });

  it('rejects a wrong top-level shape', () => {
    for (const value of [null, 'x', 7, [], {}, { objects: null }, { objects: [] }]) {
      assert.equal(parseDsoEndedState(value), null, JSON.stringify(value));
    }
  });
});

describe('DSO ended state file — real temp dir', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let warn: ReturnType<typeof mock.method>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dso-ended-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    warn = mock.method(console, 'warn', () => {});
  });

  afterEach(() => {
    mock.restoreAll();
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lives under CACHE_DIR/dso', () => {
    assert.equal(getDsoEndedStatePath(), path.join(tmpDir, 'dso', 'ended.json'));
  });

  it('missing file = nothing ended, no warning', async () => {
    assert.deepEqual(await readDsoEndedState(), { objects: {} });
    assert.equal(warn.mock.callCount(), 0);
  });

  it('corrupt file = nothing ended, with a warning', async () => {
    fs.mkdirSync(path.join(tmpDir, 'dso'), { recursive: true });
    fs.writeFileSync(getDsoEndedStatePath(), '{{{', 'utf8');
    assert.deepEqual(await readDsoEndedState(), { objects: {} });
    assert.equal(warn.mock.callCount(), 1);
  });

  it('mark persists across a restart and leaves no temp file', async () => {
    const now = new Date('2026-10-14T01:00:00.000Z');
    await markDsoEnded('artemis-ii', new Date('2026-04-10T23:54:22.857Z'), now);

    // "new process": nothing in memory, only the file
    const state = await readDsoEndedState();
    assert.deepEqual(state.objects['artemis-ii'], {
      endedAt: '2026-04-10T23:54:22.857Z',
      markedAt: '2026-10-14T01:00:00.000Z',
    });
    assert.deepEqual(fs.readdirSync(path.join(tmpDir, 'dso')), ['ended.json']);
  });

  it('marking twice keeps other objects', async () => {
    await markDsoEnded('artemis-ii', '2026-04-10T23:54:22.857Z');
    await markDsoEnded('lro', '2026-01-01T00:00:00.000Z');
    assert.deepEqual(Object.keys((await readDsoEndedState()).objects).sort(), ['artemis-ii', 'lro']);
  });

  it('clear removes one entry; clearing an absent entry writes nothing', async () => {
    await markDsoEnded('artemis-ii', '2026-04-10T23:54:22.857Z');
    await markDsoEnded('lro', '2026-01-01T00:00:00.000Z');
    await clearDsoEnded('artemis-ii');
    assert.deepEqual(Object.keys((await readDsoEndedState()).objects), ['lro']);

    const before = fs.statSync(getDsoEndedStatePath()).mtimeMs;
    await clearDsoEnded('does-not-exist');
    assert.equal(fs.statSync(getDsoEndedStatePath()).mtimeMs, before);
  });

  it('never touches the manifest, catalog or stored snapshots', async () => {
    const files: Record<string, string> = {
      'manifest.json': '{"objects":{"artemis-ii":{"currentSnapshotVersion":"v1"}}}',
      'catalog.json': '{"objects":[]}',
      [path.join('snapshots', 'artemis-ii', 'v1.json')]: '{"stateVectors":[1,2,3]}',
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, 'dso', rel)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'dso', rel), text, 'utf8');
    }

    await markDsoEnded('artemis-ii', '2026-04-10T23:54:22.857Z');
    await clearDsoEnded('artemis-ii');
    await markDsoEnded('artemis-ii', '2026-04-10T23:54:22.857Z');

    for (const [rel, text] of Object.entries(files)) {
      assert.equal(fs.readFileSync(path.join(tmpDir, 'dso', rel), 'utf8'), text, rel);
    }
  });

  it('an unwritable state file makes mark throw (the worker then records a normal failure)', async () => {
    fs.mkdirSync(getDsoEndedStatePath(), { recursive: true }); // a directory where the file goes
    await assert.rejects(markDsoEnded('artemis-ii', '2026-04-10T23:54:22.857Z'));
    assert.deepEqual(await readDsoEndedState(), { objects: {} });
  });
});

describe('DSO_RETRY_ENDED', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.DSO_RETRY_ENDED;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DSO_RETRY_ENDED;
    else process.env.DSO_RETRY_ENDED = prev;
  });

  it('is off by default and on for 1, true, yes, on', () => {
    delete process.env.DSO_RETRY_ENDED;
    assert.equal(dsoRetryEnded(), false);
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      process.env.DSO_RETRY_ENDED = v;
      assert.equal(dsoRetryEnded(), true, v);
    }
    for (const v of ['', '0', 'false', 'no', 'off', 'maybe']) {
      process.env.DSO_RETRY_ENDED = v;
      assert.equal(dsoRetryEnded(), false, v);
    }
  });
});
