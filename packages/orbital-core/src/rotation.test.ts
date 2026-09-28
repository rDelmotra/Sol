import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ecefToTeme, temeToEcef } from './rotation.js';

describe('rotation: ecefToTeme / temeToEcef round-trip', () => {
  it('ecefToTeme then temeToEcef is the identity (1e-15)', () => {
    const v = { x: 0.42, y: -0.71, z: 0.33 };
    const theta = 2.0071;
    const r = temeToEcef(ecefToTeme(v, theta), theta);
    assert.ok(Math.abs(r.x - v.x) < 1e-15);
    assert.ok(Math.abs(r.y - v.y) < 1e-15);
    assert.ok(Math.abs(r.z - v.z) < 1e-15);
  });

  it('temeToEcef then ecefToTeme is the identity (1e-15)', () => {
    const v = { x: -0.15, y: 0.88, z: -0.44 };
    const theta = 5.5;
    const r = ecefToTeme(temeToEcef(v, theta), theta);
    assert.ok(Math.abs(r.x - v.x) < 1e-15);
    assert.ok(Math.abs(r.y - v.y) < 1e-15);
    assert.ok(Math.abs(r.z - v.z) < 1e-15);
  });
});

describe('rotation: basic properties', () => {
  it('theta=0 is the identity for both directions', () => {
    const v = { x: 1, y: 2, z: 3 };
    assert.deepEqual(ecefToTeme(v, 0), v);
    assert.deepEqual(temeToEcef(v, 0), v);
  });

  it('preserves vector length (rotation, not scaling)', () => {
    const v = { x: 0.3, y: 0.4, z: 0.5 };
    const theta = 1.1;
    const r = ecefToTeme(v, theta);
    const before = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const after = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    assert.ok(Math.abs(before - after) < 1e-15);
  });

  it('leaves z unchanged (rotation is about the z axis)', () => {
    const v = { x: 0.1, y: 0.2, z: 0.9 };
    assert.equal(ecefToTeme(v, 1.3).z, v.z);
    assert.equal(temeToEcef(v, 1.3).z, v.z);
  });
});
