import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeRawArchive } from '../../src/history/archive/raw-writer.ts';
import type { RawGpRecord } from '../../src/history/ingest/sink.ts';

// With no STORAGE_BACKEND the archive must land exactly where it always did:
// <HISTORY_ARCHIVE_DIR>/<UTC day>.json.gz, gzipped JSON envelope, no .tmp left over.
describe('writeRawArchive (default file backend)', () => {
  // The alert vars are cleared so a shell with real ones set can never make this test ping them.
  const names = ['HISTORY_ARCHIVE_DIR', 'CACHE_DIR', 'STORAGE_BACKEND', 'ALERT_WEBHOOK_URL', 'RESEND_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    for (const n of names) { saved[n] = process.env[n]; delete process.env[n]; }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-raw-'));
    process.env.HISTORY_ARCHIVE_DIR = path.join(dir, 'history', 'raw');
    process.env.CACHE_DIR = dir;
  });
  afterEach(() => {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes <archive dir>/<UTC day>.json.gz with the same envelope as before', async () => {
    const records = [{ NORAD_CAT_ID: '25544', OBJECT_NAME: 'ISS (ZARYA)' }] as unknown as RawGpRecord[];
    await writeRawArchive(records, 'space-track');

    const day = new Date().toISOString().slice(0, 10);
    const archive = process.env.HISTORY_ARCHIVE_DIR!;
    assert.deepEqual(fs.readdirSync(archive), [`${day}.json.gz`]);

    const envelope = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(archive, `${day}.json.gz`))).toString('utf8'));
    assert.equal(envelope.day, day);
    assert.equal(envelope.source, 'space-track');
    assert.deepEqual(envelope.records, records);
    assert.ok(!Number.isNaN(Date.parse(envelope.fetchedAt)));
  });

  it('a second write the same day replaces the file', async () => {
    await writeRawArchive([{ NORAD_CAT_ID: '1' }] as unknown as RawGpRecord[], 'space-track');
    await writeRawArchive([{ NORAD_CAT_ID: '2' }, { NORAD_CAT_ID: '3' }] as unknown as RawGpRecord[], 'space-track');
    const archive = process.env.HISTORY_ARCHIVE_DIR!;
    const files = fs.readdirSync(archive);
    assert.equal(files.length, 1);
    const envelope = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(archive, files[0]))).toString('utf8'));
    assert.equal(envelope.records.length, 2);
  });
});
