// Move-equivalent of packages/backend/tests/frontend/visual-visibility.test.ts —
// same cases, copied (not moved: the backend file stays until a later step per
// PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md §3).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateVisualVisibility,
  VISUAL_ELEVATION_THRESHOLD_SIN,
  VISUAL_RANGE_MAX_KM,
} from './visibility.js';

describe('evaluateVisualVisibility', () => {
  it('returns visible only when all constraints pass', () => {
    const result = evaluateVisualVisibility({
      isCurated: true,
      elevationSin: VISUAL_ELEVATION_THRESHOLD_SIN + 0.05,
      rangeKm: VISUAL_RANGE_MAX_KM - 50,
      observerDark: true,
      satelliteEclipsed: false,
    });
    assert.deepEqual(result, { visible: true, reason: null });
  });

  it('returns deterministic reasons in constraint priority order', () => {
    assert.equal(
      evaluateVisualVisibility({
        isCurated: false,
        elevationSin: 1,
        rangeKm: 1,
        observerDark: true,
        satelliteEclipsed: false,
      }).reason,
      'not_curated',
    );

    assert.equal(
      evaluateVisualVisibility({
        isCurated: true,
        elevationSin: VISUAL_ELEVATION_THRESHOLD_SIN - 0.001,
        rangeKm: 1,
        observerDark: true,
        satelliteEclipsed: false,
      }).reason,
      'below_elevation',
    );

    assert.equal(
      evaluateVisualVisibility({
        isCurated: true,
        elevationSin: VISUAL_ELEVATION_THRESHOLD_SIN + 0.001,
        rangeKm: VISUAL_RANGE_MAX_KM + 1,
        observerDark: true,
        satelliteEclipsed: false,
      }).reason,
      'out_of_range',
    );

    assert.equal(
      evaluateVisualVisibility({
        isCurated: true,
        elevationSin: VISUAL_ELEVATION_THRESHOLD_SIN + 0.001,
        rangeKm: VISUAL_RANGE_MAX_KM - 1,
        observerDark: false,
        satelliteEclipsed: false,
      }).reason,
      'observer_daylight',
    );

    assert.equal(
      evaluateVisualVisibility({
        isCurated: true,
        elevationSin: VISUAL_ELEVATION_THRESHOLD_SIN + 0.001,
        rangeKm: VISUAL_RANGE_MAX_KM - 1,
        observerDark: true,
        satelliteEclipsed: true,
      }).reason,
      'satellite_eclipsed',
    );
  });
});
