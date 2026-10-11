import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coordStr, dockMode, latLonStr, lensDisabled } from './dock-modes';

describe('cockpit dock', () => {
  it('a running joyride lights JOYRIDE, otherwise the vantage', () => {
    assert.equal(dockMode('following', 'joyride', 'orbit'), 'joyride');
    assert.equal(dockMode('flying', 'joyride', 'ground'), 'joyride');
    assert.equal(dockMode('following', 'follow', 'orbit'), 'orbit');
    assert.equal(dockMode('free', 'joyride', 'ground'), 'ground');
    assert.equal(dockMode('returning', 'joyride', 'orbit'), 'orbit');
  });

  it('lenses: ALL is off on the ground, the others need a location', () => {
    assert.equal(lensDisabled('all', false, 'orbit'), false);
    assert.equal(lensDisabled('all', true, 'ground'), true);
    assert.equal(lensDisabled('horizon', false, 'orbit'), true);
    assert.equal(lensDisabled('radio', true, 'ground'), false);
  });

  it('coordinates read hemisphere letters, two decimals', () => {
    assert.equal(coordStr(51.48, 'N', 'S'), '51.48° N');
    assert.equal(coordStr(-0.5, 'E', 'W'), '0.50° W');
    assert.equal(latLonStr(-33.8688, 151.2093), '33.87° S · 151.21° E');
    assert.equal(latLonStr(0, 0), '0.00° N · 0.00° E');
  });
});
