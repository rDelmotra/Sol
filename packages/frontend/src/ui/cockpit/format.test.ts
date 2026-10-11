import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import {
  ageString,
  altitudeLabel,
  altitudeReading,
  degStr,
  elementOrbit,
  escapeFraction,
  gearSpeedStr,
  kindCode,
  pad,
  statusLabel,
  kmStr,
  kmStr3,
  minStr,
  syncStr,
  velStr,
  velStr3,
} from './format';

const obj = (over: Partial<EnrichedTLEObject>, omm: Record<string, unknown> = {}): EnrichedTLEObject =>
  ({ omm, period: NaN, apogee: NaN, perigee: NaN, inclination: NaN, ...over }) as unknown as EnrichedTLEObject;

describe('formatters', () => {
  it('group, fix decimals and dash missing values', () => {
    assert.equal(kmStr(463.4), '463 KM');
    assert.equal(kmStr(35786.2), '35,786 KM');
    assert.equal(kmStr(null), '—');
    assert.equal(kmStr3(2262.3219), '2,262.322 KM');
    assert.equal(velStr(7.637), '7.64 KM/S');
    assert.equal(velStr3(7.6371), '7.637 KM/S');
    assert.equal(velStr3(NaN), '—');
    assert.equal(degStr(53.16), '53.16°');
    assert.equal(minStr(93.94), '93.9 MIN');
    assert.equal(gearSpeedStr(1_000_000), '1,000');
    assert.equal(gearSpeedStr(250), '0.25');
  });

  it('kindCode maps wire types to the 3-letter class', () => {
    assert.equal(kindCode('satellite'), 'SAT');
    assert.equal(kindCode('rocket_body'), 'RKT');
    assert.equal(kindCode('debris'), 'DEB');
    assert.equal(kindCode('unknown'), 'UNK');
  });

  it('ageString counts years and months, null when unknown or future', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    assert.equal(ageString('2024-06-27', now), '2Y 3M');
    assert.equal(ageString(null, now), null);
    assert.equal(ageString('nonsense', now), null);
    assert.equal(ageString('2027-01-01', now), null);
  });

  it('syncStr prints UTC time of day', () => {
    assert.equal(syncStr(Date.parse('2026-10-11T11:57:38.900Z')), '11:57:38Z');
    assert.equal(syncStr(null), '—');
  });
});

describe('elementOrbit', () => {
  it('prefers backend fields', () => {
    const o = elementOrbit(obj({ period: 93.9, apogee: 464, perigee: 462, inclination: 53.16 }, { MEAN_MOTION: 1 }));
    assert.deepEqual(o, { period: 93.9, apogee: 464, perigee: 462, inclination: 53.16, meanAltKm: 463 });
  });

  it('falls back to the OMM when backend fields are missing', () => {
    // ISS-like: 15.5 rev/day, e = 0.0005 → a ≈ 6795 km.
    const o = elementOrbit(obj({}, { MEAN_MOTION: 15.5, ECCENTRICITY: 0.0005, INCLINATION: 51.6 }));
    assert.ok(Math.abs(o.period - 1440 / 15.5) < 1e-9);
    assert.ok(o.apogee > o.perigee);
    assert.ok(Math.abs(o.meanAltKm - 424) < 5, `mean alt ${o.meanAltKm}`);
    assert.equal(o.inclination, 51.6);
  });

  it('gives NaN, not a guess, when nothing is known', () => {
    const o = elementOrbit(obj({}));
    assert.ok(Number.isNaN(o.meanAltKm));
    assert.ok(Number.isNaN(o.period));
  });
});

describe('altitude and speed honesty', () => {
  it('uses the live altitude when present, else the mean one, labelled', () => {
    assert.deepEqual(altitudeReading(420.5, 463), { km: 420.5, live: true });
    assert.deepEqual(altitudeReading(null, 463), { km: 463, live: false });
    assert.equal(altitudeReading(null, NaN), null);
    assert.equal(altitudeLabel(altitudeReading(420, 463)), 'ALTITUDE');
    assert.equal(altitudeLabel(altitudeReading(null, 463)), 'MEAN ALT');
    assert.equal(altitudeLabel(null), 'ALTITUDE');
  });

  it('escapeFraction is 1/√2 for a circular orbit and null without live values', () => {
    const alt = 420;
    const vCirc = Math.sqrt(398600.4418 / (6371 + alt));
    const f = escapeFraction(vCirc, alt);
    assert.ok(f !== null && Math.abs(f - Math.SQRT1_2) < 1e-9);
    assert.equal(escapeFraction(null, alt), null);
    assert.equal(escapeFraction(7.6, null), null);
    assert.equal(escapeFraction(99, alt), 1); // clamped
  });
});

describe('pad and statusLabel', () => {
  it('zero-pads to the width', () => {
    assert.equal(pad(7), '07');
    assert.equal(pad(987, 4), '0987');
    assert.equal(pad(12), '12');
  });
  it('turns a status code into a label', () => {
    assert.equal(statusLabel('partial_data'), 'PARTIAL DATA');
    assert.equal(statusLabel('unknown'), 'UNKNOWN');
  });
});
