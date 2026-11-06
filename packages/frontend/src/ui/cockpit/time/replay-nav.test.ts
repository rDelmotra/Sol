import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryRange } from '../../../data/replay-types';
import {
  accuracyBadge,
  bucketContains,
  bucketStartDay,
  bucketStarts,
  chooseBucket,
  formatAccuracyKm,
  jumpToDayMs,
  laneFraction,
  pickerBounds,
  timelineWindow,
  yearJumpDay,
} from './replay-nav';

const RANGE: HistoryRange = { firstDay: '1959-01-11', lastDay: '2026-03-31', days: 24552, eventsFirstDay: null, eventsLastDay: null, hasCoverage: true };
const WALL = Date.parse('2026-11-06T12:00:00Z');

describe('timeline bucket choice by zoom', () => {
  it('year for multi-year spans, month for a year, day for a month', () => {
    assert.equal(chooseBucket('1959-01-11', '2026-03-31'), 'year');
    assert.equal(chooseBucket('1998-01-01', '1998-12-31'), 'month');
    assert.equal(chooseBucket('1998-11-01', '1998-11-30'), 'day');
    assert.equal(chooseBucket('1998-11-15', '1998-12-31'), 'day'); // 47 days
    assert.equal(chooseBucket('1998-01-01', '2000-12-31'), 'month'); // 3 years
  });
  it('zoom windows around the sim day, clipped to the archive', () => {
    assert.deepEqual(timelineWindow('all', '1998-11-20', RANGE), { from: '1959-01-11', to: '2026-03-31', bucket: 'year' });
    assert.deepEqual(timelineWindow('year', '1998-11-20', RANGE), { from: '1998-01-01', to: '1998-12-31', bucket: 'month' });
    assert.deepEqual(timelineWindow('month', '2000-02-10', RANGE), { from: '2000-02-01', to: '2000-02-29', bucket: 'day' });
    assert.deepEqual(timelineWindow('year', '1959-03-01', RANGE), { from: '1959-01-11', to: '1959-12-31', bucket: 'month' });
    assert.deepEqual(timelineWindow('month', '2026-11-06', RANGE).to, '2026-03-31');
  });
  it('bucket labels → start day, and containment', () => {
    assert.equal(bucketStartDay('1998'), '1998-01-01');
    assert.equal(bucketStartDay('1998-11'), '1998-11-01');
    assert.equal(bucketStartDay('1998-11-20T00:00:00.000Z'), '1998-11-20');
    assert.ok(bucketContains('1998', 'year', '1998-11-20'));
    assert.ok(bucketContains('1998-11-01', 'month', '1998-11-20'));
    assert.ok(!bucketContains('1998-11-19', 'day', '1998-11-20'));
  });
  it('lays out every bucket of the window (the API omits empty ones)', () => {
    assert.equal(bucketStarts('1959-01-11', '2026-03-31', 'year').length, 68);
    assert.deepEqual(bucketStarts('1998-11-15', '1999-01-03', 'month'), ['1998-11-01', '1998-12-01', '1999-01-01']);
    assert.deepEqual(bucketStarts('2000-02-27', '2000-03-01', 'day'), ['2000-02-27', '2000-02-28', '2000-02-29', '2000-03-01']);
  });
  it('lane heights are log-scaled and bounded', () => {
    assert.equal(laneFraction(0, 10), 0);
    assert.equal(laneFraction(10, 10), 1);
    assert.ok(laneFraction(1, 1000) > 0.09);
  });
});

describe('date picker and jumps', () => {
  it('with the archive: first archive day .. live horizon', () => {
    assert.deepEqual(pickerBounds(RANGE, WALL), { min: '1959-01-11', max: '2026-11-20', archive: true });
  });
  it('503 (no archive): only the live range, no error', () => {
    assert.deepEqual(pickerBounds(null, WALL), { min: '2026-10-07', max: '2026-11-20', archive: false });
  });
  it('jumping keeps the UTC time of day; the year scrubber keeps month/day', () => {
    assert.equal(new Date(jumpToDayMs('1998-11-20', Date.parse('2026-11-06T07:08:09Z'))).toISOString(), '1998-11-20T07:08:09.000Z');
    assert.equal(yearJumpDay(1965, '2024-02-29', '1959-01-11', '2026-11-20'), '1965-02-28');
    assert.equal(yearJumpDay(1959, '2026-01-01', '1959-01-11', '2026-11-20'), '1959-01-11');
  });
});

describe('accuracy badge', () => {
  it('none in live mode', () => {
    assert.equal(accuracyBadge(null, { medianKm: 79, p95Km: 500 }, 10), null);
  });
  it('states the median and notes SGP objects', () => {
    const b = accuracyBadge('1965-06-05', { medianKm: 79.4, p95Km: 600 }, 1234)!;
    assert.equal(b.accuracy, 'POSITIONS ±~79 km (MEDIAN)');
    assert.match(b.note!, /1,234 OBJ ON ORIGINAL SGP MODEL/);
    assert.equal(accuracyBadge('1998-11-20', null, 0)!.note, null);
    assert.match(accuracyBadge('1998-11-20', null, 0)!.accuracy, /NOT MEASURED/);
  });
  it('rounds to a rough two-digit figure', () => {
    assert.equal(formatAccuracyKm(1024), '±~1,000 km');
    assert.equal(formatAccuracyKm(283), '±~280 km');
    assert.equal(formatAccuracyKm(3.24), '±~3.2 km');
  });
});
