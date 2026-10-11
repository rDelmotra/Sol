import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pass } from '../../../sky/passes';
import { bearing, formatCountdown, passReadoutModel, type ReadoutInput } from './pass-readout';

const T = 1_000_000_000_000;
const pass = (over: Partial<Pass> = {}): Pass => ({
  horizonAosMs: T + 60_000,
  aosMs: T + 120_000,
  peakMs: T + 400_000,
  losMs: T + 700_000,
  horizonLosMs: T + 760_000,
  peakElevationDeg: 42.4,
  aosAzimuthDeg: 300,
  peakAzimuthDeg: 224,
  losAzimuthDeg: 120,
  startClipped: false,
  endClipped: false,
  ...over,
});
const input = (over: Partial<ReadoutInput> = {}): ReadoutInput => ({
  vantage: 'ground',
  passStatus: 'ok',
  name: 'ISS (ZARYA)',
  pass: pass(),
  nowMs: T,
  placeName: null,
  ...over,
});

describe('formatters', () => {
  it('bearing', () => {
    assert.equal(bearing(224), 'SW 224°');
    assert.equal(bearing(359.6), 'N 0°');
    assert.equal(bearing(-10), 'N 350°');
  });
  it('countdown', () => {
    assert.equal(formatCountdown(59_000 * 1), '0m 59s');
    assert.equal(formatCountdown(3548_000), '59m 8s');
    assert.equal(formatCountdown(3_900_000), '1h 05m');
    assert.equal(formatCountdown(-5), '0m 0s');
  });
});

describe('passReadoutModel', () => {
  it('is absent outside ground vantage and without a lock', () => {
    assert.equal(passReadoutModel(input({ vantage: 'orbit' })), null);
    assert.equal(passReadoutModel(input({ passStatus: 'no-selection' })), null);
    assert.equal(passReadoutModel(input({ passStatus: 'not-on-ground' })), null);
  });
  it('says why when there is nothing to show', () => {
    assert.match(passReadoutModel(input({ passStatus: 'no-location' }))!.primary, /Set your location/);
    const m = passReadoutModel(input({ passStatus: 'none-found', pass: null }))!;
    assert.match(m.primary, /No pass above 10°/);
    assert.ok(m.secondary);
  });
  it('upcoming: AOS counts down to the 10° crossing', () => {
    const m = passReadoutModel(input({ nowMs: T - 60_000 }))!;
    assert.equal(m.primary, 'AOS 3m 0s');
    assert.equal(m.secondary, 'peak 42° · SW 224°');
  });
  it('between horizon and 10° it says LOW, rising and setting', () => {
    assert.equal(passReadoutModel(input({ nowMs: T + 90_000 }))!.primary, 'LOW · AOS 0m 30s');
    assert.equal(passReadoutModel(input({ nowMs: T + 730_000 }))!.primary, 'LOW · BELOW 10°');
  });
  it('OVERHEAD NOW only above 10°, with the 10° LOS countdown', () => {
    const m = passReadoutModel(input({ nowMs: T + 400_000 }))!;
    assert.equal(m.primary, 'OVERHEAD NOW · LOS 5m 0s');
    assert.equal(m.tone, 'good');
  });
  it('a clipped end shows no fake LOS, and the peak is a floor', () => {
    const m = passReadoutModel(input({ nowMs: T + 400_000, pass: pass({ endClipped: true }) }))!;
    assert.equal(m.primary, 'OVERHEAD NOW');
    assert.match(m.secondary!, /^peak ≥/);
  });
  it('appends the place name; stale pass says ended', () => {
    assert.match(passReadoutModel(input({ placeName: 'London' }))!.secondary!, / · London$/);
    assert.equal(passReadoutModel(input({ nowMs: T + 800_000 }))!.primary, 'PASS ENDED');
  });
});
