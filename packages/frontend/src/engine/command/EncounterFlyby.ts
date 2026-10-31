import { useStore } from '../../store/useStore';
import type { AnalyticFilter } from '../../store/useStore';
import type { EncounterSummary } from '@orbitwatch/contracts';

/** The flyby starts this long before closest approach, so the approach is watched in real time. */
export const FLYBY_LEAD_MS = 120_000;

/** What the flyby needs from the camera; the Engine wires these to its NavigationController. */
export interface FlybyCamera {
  selectByIndex(index: number): void;
  /** Fly to and follow the object, framing it. */
  flyTo(index: number): void;
  /** Pull the follow camera back so an object this far from the followed one is in view. */
  frameSeparation(km: number): void;
}

function findEncounter(id: number): EncounterSummary | null {
  const { encountersByNorad } = useStore.getState();
  for (const list of Object.values(encountersByNorad)) {
    const hit = list.find((e) => e.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * The `showEncounter` / `clearEncounter` engine commands.
 *
 * Watching an encounter:
 *  - selects the primary (the object whose encounter list was clicked) and flies the
 *    follow camera to it, so the other object, a few hundred km away at the start,
 *    is in view;
 *  - shows only the pair, using the analytic filter (remembering the filter it replaced);
 *  - sets the sim clock to TCA − 2 min at 1×, so the approach plays out in real time;
 *  - records the encounter in `selectedEncounterId`, which the EncounterLayer draws.
 *
 * It ends on `clearEncounter`, or when the selection moves to another object.
 * Everything goes through the store's own actions; no UI import.
 */
export class EncounterFlyby {
  private active = false;
  private savedFilter: AnalyticFilter | null = null;
  private ownFilter: AnalyticFilter | null = null;
  private unsub: (() => void) | null = null;

  constructor(private readonly camera: FlybyCamera) {}

  show(encounterId: number): void {
    const e = findEncounter(encounterId);
    if (!e) return;
    const tcaMs = Date.parse(e.tca);
    if (!Number.isFinite(tcaMs)) return;

    let store = useStore.getState();
    // The primary is the focused object when it is in the pair, else the first of the pair.
    const focused = store.selectedSatellite?.noradId;
    const primary = focused === e.a.noradId || focused === e.b.noradId ? focused : e.a.noradId;

    // Restart cleanly when switching from one encounter to another: keep the very
    // first saved filter, not the pair filter of the previous encounter.
    this.unsub?.();
    this.unsub = null;

    if (focused !== primary) {
      const idx = store.catalogData.findIndex((o) => o.noradId === primary);
      if (idx >= 0) this.camera.selectByIndex(idx);
    }
    store = useStore.getState();
    if (store.selectedIndex !== null) {
      this.camera.flyTo(store.selectedIndex);
      // At the start the pair is about relative speed × lead apart (straight-line estimate).
      this.camera.frameSeparation(e.relSpeedKms * (FLYBY_LEAD_MS / 1000));
    }

    if (!this.active) this.savedFilter = store.analyticFilter;
    this.active = true;
    store.setAnalyticFilter(new Set([e.a.noradId, e.b.noradId]));
    this.ownFilter = useStore.getState().analyticFilter;

    if (store.simRate !== 1) store.setSimRate(1);
    useStore.getState().jumpToSimTime(new Date(tcaMs - FLYBY_LEAD_MS));
    // Away from the present: the clock console should say so.
    useStore.setState({ viewMode: 'review' });

    useStore.getState().selectEncounter(encounterId);

    // Choosing another object (or dropping the lock) ends the flyby.
    this.unsub = useStore.subscribe((s) => {
      if (s.selectedSatellite?.noradId !== primary) this.clear();
    });
  }

  clear(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.active) {
      const store = useStore.getState();
      // Restore the filter only if it is still the pair filter; a query run since
      // then owns the filter now.
      if (store.analyticFilter === this.ownFilter) {
        const prev = this.savedFilter;
        store.setAnalyticFilter(prev && prev.mode === 'only' ? prev.ids : null);
      }
    }
    this.active = false;
    this.savedFilter = null;
    this.ownFilter = null;
    useStore.getState().selectEncounter(null);
  }
}
