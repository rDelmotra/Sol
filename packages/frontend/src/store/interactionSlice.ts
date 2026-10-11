import type { CameraMode, InteractionSlice, Slice } from './types';

export const createInteractionSlice: Slice<InteractionSlice> = (set) => ({
  cameraMode: 'free',
  trackingStyle: 'follow',
  selectedIndex: null,
  selectedSatellite: null,
  selectedAltitude: null,
  liveAltitudeKm: null,
  liveSpeedKmS: null,
  showOrbitTrail: false,
  selectedDso: null,
  hoveredName: null,
  hoverScreenX: 0,
  hoverScreenY: 0,
  clusterItems: [],
  clusterScreenX: 0,
  clusterScreenY: 0,
  setCameraMode: (mode) => set({ cameraMode: mode }),
  setTrackingStyle: (style) => set({ trackingStyle: style }),
  setSelectedSatellite: (index, data, altitude) =>
    set((state) => ({
      selectedIndex: index,
      selectedSatellite: data,
      selectedAltitude: altitude ?? null,
      // Drop the previous object's live readout; the Engine refills it within
      // ~250 ms, and a stale number is worse than a dash meanwhile.
      liveAltitudeKm: null,
      liveSpeedKmS: null,
      showOrbitTrail: false,
      // Clear DSO selection when selecting a TLE object
      ...(index !== null ? { selectedDso: null } : {}),
      // Deselecting during tracking: smooth return to Earth-centered view
      ...(index === null && (state.cameraMode === 'flying' || state.cameraMode === 'following')
        ? { cameraMode: 'returning' as CameraMode }
        : {}),
    })),
  setSelectedDso: (dso) =>
    set((state) => ({
      selectedDso: dso,
      // Clear TLE selection when selecting a DSO
      ...(dso !== null
        ? { selectedIndex: null, selectedSatellite: null, selectedAltitude: null }
        : {}),
      // Deselecting during tracking: smooth return
      ...(dso === null && (state.cameraMode === 'flying' || state.cameraMode === 'following')
        ? { cameraMode: 'returning' as CameraMode }
        : {}),
    })),
  // Runs ~4×/s and every write re-renders the HUD, so an unchanged push is free.
  setLiveKinematics: (altitudeKm, speedKmS) =>
    set((state) =>
      state.liveAltitudeKm === altitudeKm && state.liveSpeedKmS === speedKmS
        ? state
        : { liveAltitudeKm: altitudeKm, liveSpeedKmS: speedKmS },
    ),
  setShowOrbitTrail: (show) => set({ showOrbitTrail: show }),
  setHover: (name, screenX, screenY) =>
    set({
      hoveredName: name,
      hoverScreenX: screenX ?? 0,
      hoverScreenY: screenY ?? 0,
    }),
  setCluster: (items, screenX, screenY) =>
    set({
      clusterItems: items,
      clusterScreenX: screenX,
      clusterScreenY: screenY,
    }),
  clearCluster: () => set({ clusterItems: [] }),
});
