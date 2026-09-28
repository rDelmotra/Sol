import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { sourceToScene, sourceToSceneInto, writeSourceToScene } from './frames';

// Characterization of the ONE render-side frame swap: scene = (src.x, src.z, -src.y).
// A sign flip or axis transposition here silently mislocates every satellite, DSO,
// trail, and observer marker — so pin the convention down hard.

describe('frames: source (TEME/ECI/ECEF) → scene swap', () => {
  it('sourceToScene maps (x, y, z) → (x, z, -y)', () => {
    const v = sourceToScene(1, 2, 3);
    assert.equal(v.x, 1);
    assert.equal(v.y, 3);
    assert.equal(v.z, -2);
  });

  it('sourceToSceneInto fills the given vector and returns it (no allocation)', () => {
    const out = new THREE.Vector3(9, 9, 9);
    const ret = sourceToSceneInto(out, 1, 2, 3);
    assert.equal(ret, out); // same reference
    assert.deepEqual([out.x, out.y, out.z], [1, 3, -2]);
  });

  it('writeSourceToScene writes (x, z, -y) at the offset, default scale = 1', () => {
    const arr = new Float32Array(3);
    writeSourceToScene(arr, 0, 1, 2, 3);
    assert.deepEqual(Array.from(arr), [1, 3, -2]);
  });

  it('writeSourceToScene scales every component and respects the offset', () => {
    const arr = new Float32Array(6).fill(9);
    // src (2, 4, 6) scaled by 0.5 → (1, 3, -2), written at index 3..5; 0..2 untouched.
    writeSourceToScene(arr, 3, 2, 4, 6, 0.5);
    assert.deepEqual(Array.from(arr), [9, 9, 9, 1, 3, -2]);
  });

  it('agrees across all three entry points for the same input', () => {
    const x = 7, y = -11, z = 4;
    const viaNew = sourceToScene(x, y, z);
    const viaInto = sourceToSceneInto(new THREE.Vector3(), x, y, z);
    const arr = new Float32Array(3);
    writeSourceToScene(arr, 0, x, y, z);
    assert.deepEqual([viaNew.x, viaNew.y, viaNew.z], [viaInto.x, viaInto.y, viaInto.z]);
    assert.deepEqual([viaNew.x, viaNew.y, viaNew.z], Array.from(arr));
  });
});
