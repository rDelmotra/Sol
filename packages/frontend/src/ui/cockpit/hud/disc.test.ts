import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { discItems, discRadius, polar, sectorPath, upperText } from './disc';

const obj = (over: Partial<EnrichedTLEObject> = {}): EnrichedTLEObject =>
  ({
    noradId: 25544,
    omm: {},
    period: 92.4,
    apogee: 420,
    perigee: 410,
    inclination: 51.64,
    purpose: 'science',
    countryCode: 'ISS',
    launchDate: '1998-11-20',
    rcsSize: 'LARGE',
    ...over,
  }) as unknown as EnrichedTLEObject;

describe('disc geometry', () => {
  it('polar: 0° is 12 o clock, 90° is 3 o clock', () => {
    const top = polar({ x: 100, y: 100 }, 10, 0);
    assert.ok(Math.abs(top.x - 100) < 1e-9 && Math.abs(top.y - 90) < 1e-9);
    const right = polar({ x: 100, y: 100 }, 10, 90);
    assert.ok(Math.abs(right.x - 110) < 1e-9 && Math.abs(right.y - 100) < 1e-9);
  });
  it('radius is 0.26 of the short side', () => {
    assert.equal(discRadius(1500, 900), 234);
    assert.equal(discRadius(800, 1200), 208);
  });
  it('sector path is a small arc', () => {
    assert.match(sectorPath({ x: 0, y: 0 }, 10, 25, 47), /^M .* A 10 10 0 0 0 /);
  });
  it('upperText', () => {
    assert.equal(upperText('earth_observation'), 'EARTH OBSERVATION');
    assert.equal(upperText(null), '—');
  });
});

describe('discItems', () => {
  it('live altitude and speed', () => {
    const { primary, secondary } = discItems(obj(), 418.4, 7.66);
    assert.deepEqual(primary[0], { k: 'ALTITUDE', v: '418 km' });
    assert.deepEqual(primary[1], { k: 'VELOCITY', v: '7.66 km/s' });
    assert.deepEqual(primary[2], { k: 'ROLE', v: 'SCIENCE' });
    assert.deepEqual(secondary.map((i) => i.k), ['NORAD', 'INCL', 'PERIOD', 'RCS', 'LAUNCHED', 'COUNTRY']);
    assert.equal(secondary.find((i) => i.k === 'PERIOD')!.v, '92.4 min');
  });
  it('without a live state: MEAN ALT label and a velocity dash', () => {
    const { primary } = discItems(obj(), null, null);
    assert.deepEqual(primary[0], { k: 'MEAN ALT', v: '415 km' });
    assert.equal(primary[1]!.v, '—');
  });
});
