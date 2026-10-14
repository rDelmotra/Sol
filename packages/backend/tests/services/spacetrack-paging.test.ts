import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPages } from '../../src/services/spacetrack.js';

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);

test('collectPages joins full pages and a short last page', async () => {
  const pages = [rows(4), rows(4, 4), rows(2, 8)];
  const all = await collectPages(async (offset) => pages[offset / 4]!, 4);
  assert.equal(all.length, 10);
});

test('collectPages accepts a single short page', async () => {
  const all = await collectPages(async () => rows(3), 4);
  assert.equal(all.length, 3);
});

test('collectPages accepts an empty first page (nothing to return)', async () => {
  const all = await collectPages(async () => [], 4);
  assert.equal(all.length, 0);
});

test('collectPages rejects a full page followed by an empty page (truncated answer)', async () => {
  const pages = [rows(4), []];
  await assert.rejects(
    collectPages(async (offset) => pages[offset / 4]!, 4),
    /looks truncated/,
  );
});
