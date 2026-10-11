import { create } from 'zustand';
import type { AppState } from './types';
import { createBootSlice } from './bootSlice';
import { createCatalogSlice } from './catalogSlice';
import { createCommandSlice } from './commandSlice';
import { createInteractionSlice } from './interactionSlice';
import { createObserverSlice } from './observerSlice';
import { createFilterSlice } from './filterSlice';
import { createAnalyticSlice } from './analyticSlice';
import { createTimeSlice } from './timeSlice';
import { createHistorySlice } from './historySlice';
import { createDsoSlice } from './dsoSlice';
import { createFlightSlice } from './flightSlice';
import { createHudSlice } from './hudSlice';

// Public surface: importers keep using `store/useStore`; types + helpers live in ./types.
export { isDomeView } from './types';
export type {
  AnalyticAnswer,
  LoadingPhase,
  CameraMode,
  TrackingStyle,
  Vantage,
  SkyLens,
  ViewMode,
  VisualListState,
  ColorBy,
  CountryFilter,
  ProgramFilter,
  LaunchFilter,
  OwnerFilter,
  AnalyticFilter,
  SatelliteFilterState,
} from './types';

export const useStore = create<AppState>()((...a) => ({
  ...createBootSlice(...a),
  ...createCatalogSlice(...a),
  ...createCommandSlice(...a),
  ...createInteractionSlice(...a),
  ...createObserverSlice(...a),
  ...createFilterSlice(...a),
  ...createAnalyticSlice(...a),
  ...createTimeSlice(...a),
  ...createHistorySlice(...a),
  ...createDsoSlice(...a),
  ...createFlightSlice(...a),
  ...createHudSlice(...a),
}));
