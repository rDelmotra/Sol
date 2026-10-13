import { useStore } from '../store/useStore';
import { simClock } from '../time/SimClock';
import { ActivityTracker } from './input/activity-tracker';
import { FrameGovernor, isPerfFull, type FrameGovernorInputs } from './render/frame-governor';

/** localStorage key for the `?perf=full` escape hatch (value `full`). */
export const PERF_STORAGE_KEY = 'orbitwatch.perf';

/** The store fields the governor reads. */
export interface PacerState {
  loadingPhase: string;
  historyLoading: boolean;
  scrubberMode: boolean;
  viewMode: string;
  cameraMode: string;
  vantage: string;
}

/** Fill the governor's yes/no flags from store state (written into `out`: this runs every display tick). Pure. */
export function pacerFlags(
  s: PacerState,
  gliding: boolean,
  out: Pick<FrameGovernorInputs, 'scrubbing' | 'cameraBusy' | 'groundView' | 'loading'>,
): void {
  out.scrubbing = s.scrubberMode || s.viewMode === 'review' || gliding;
  out.cameraBusy = s.cameraMode !== 'free';
  out.groundView = s.vantage === 'ground';
  out.loading = s.loadingPhase !== 'ready' || s.historyLoading;
}

function readPerfFull(): boolean {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(PERF_STORAGE_KEY);
  } catch {
    /* storage blocked: the URL flag still works */
  }
  return isPerfFull(window.location.search, stored);
}

export interface FramePacerHost {
  /** The "return to present" glide is running. */
  isGliding(): boolean;
}

/**
 * Glue between the render loop and the idle frame governor. Once per display
 * tick the loop asks {@link shouldRun}; on false it just returns. Reads the
 * store through getState() only (no subscription) and reuses one inputs object.
 */
export class FramePacer {
  private readonly activity = new ActivityTracker();
  private readonly governor = new FrameGovernor();
  private readonly inputs: FrameGovernorInputs = {
    nowMs: 0,
    lastActivityMs: 0,
    simRate: 1,
    scrubbing: false,
    cameraBusy: false,
    groundView: false,
    loading: true,
    windowFocused: true,
    forceFull: readPerfFull(),
  };

  constructor(private readonly host: FramePacerHost) {}

  /** True when a full frame should run on this display tick (`nowMs` = performance.now()). */
  shouldRun(nowMs: number): boolean {
    const state = useStore.getState();
    // Pads raise no events: look at them every tick (cheap) while one is connected.
    if (state.gamepadConnected) this.activity.pollGamepad();
    const i = this.inputs;
    i.nowMs = nowMs;
    i.lastActivityMs = this.activity.lastActivityMs;
    i.simRate = simClock.getRate();
    i.windowFocused = this.activity.windowFocused;
    pacerFlags(state, this.host.isGliding(), i);
    return this.governor.shouldRun(i);
  }

  /** Count "now" as activity (a canvas resize clears the picture, so it must repaint at once). */
  markActivity(): void {
    this.activity.mark();
  }

  dispose(): void {
    this.activity.dispose();
  }
}
