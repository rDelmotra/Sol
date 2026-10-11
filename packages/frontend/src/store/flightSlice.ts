import type { FlightSlice, Slice } from './types';

function sameIndices(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const createFlightSlice: Slice<FlightSlice> = (set) => ({
  cameraGear: 5,
  cameraGearCount: 10,
  cameraSpeedMps: 1_000_000,
  gamepadConnected: false,
  reticleCandidates: [],
  reticleCandidateIndex: null,
  reticleCandidateName: null,
  setCameraGearState: (gear, gearCount, speedMps) =>
    set({ cameraGear: gear, cameraGearCount: gearCount, cameraSpeedMps: speedMps }),
  setGamepadConnected: (connected) => set({ gamepadConnected: connected }),
  setReticleCandidates: (indices) =>
    set((state) => {
      // Polled on a throttle while a pad is connected: an unchanged hit list must
      // not re-render the HUD.
      if (sameIndices(indices, state.reticleCandidates)) return state;
      // Keep the current highlight if it is still in the circle, so aiming wobble
      // does not reset an L3/R3 cycle; otherwise take the top-ranked hit.
      const idx =
        state.reticleCandidateIndex !== null && indices.includes(state.reticleCandidateIndex)
          ? state.reticleCandidateIndex
          : indices[0] ?? null;
      const name = idx !== null ? state.catalogData[idx]?.name ?? null : null;
      return { reticleCandidates: indices, reticleCandidateIndex: idx, reticleCandidateName: name };
    }),
  cycleReticleCandidate: (dir) =>
    set((state) => {
      const c = state.reticleCandidates;
      if (c.length === 0) return state;
      const pos = state.reticleCandidateIndex !== null ? c.indexOf(state.reticleCandidateIndex) : -1;
      const next = c[(((pos === -1 ? 0 : pos) + dir) % c.length + c.length) % c.length];
      return { reticleCandidateIndex: next, reticleCandidateName: state.catalogData[next]?.name ?? null };
    }),
});
