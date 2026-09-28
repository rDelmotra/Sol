// ============================================================
// Visual/naked-eye visibility — the gate that decides whether a curated
// satellite is visible to an observer's naked eye right now, plus the
// sky-dome (planetarium) size/brightness policy.
//
// Verbatim copy of frontend orbital/visual-visibility.ts: every export, same
// names, same math. Zero behavior change — an addition, not a move (the
// frontend file is deleted in a later step per PROJECT_MAP/15, §3).
// ============================================================

const DEG_TO_RAD = Math.PI / 180;

export const VISUAL_ELEVATION_THRESHOLD_DEG = 10;
export const VISUAL_ELEVATION_THRESHOLD_RAD = VISUAL_ELEVATION_THRESHOLD_DEG * DEG_TO_RAD;
export const VISUAL_ELEVATION_THRESHOLD_SIN = Math.sin(VISUAL_ELEVATION_THRESHOLD_RAD);

export const VISUAL_FADING_START_ELEVATION_DEG = 45;
export const VISUAL_FADING_START_ELEVATION_RAD = VISUAL_FADING_START_ELEVATION_DEG * DEG_TO_RAD;
export const VISUAL_FADING_START_SIN = Math.sin(VISUAL_FADING_START_ELEVATION_RAD);

export const VISUAL_RANGE_MAX_KM = 2000;

// Sky-dome horizon gate: everything at/above the true horizon is shown (a touch
// below 0° for standard atmospheric refraction, so objects rise/set naturally).
export const DOME_ELEVATION_THRESHOLD_DEG = -0.57;
export const DOME_ELEVATION_THRESHOLD_SIN = Math.sin(DOME_ELEVATION_THRESHOLD_DEG * DEG_TO_RAD);

export type VisualVisibilityReason =
  | 'not_curated'
  | 'below_elevation'
  | 'out_of_range'
  | 'observer_daylight'
  | 'satellite_eclipsed';

export interface VisualVisibilityInput {
  isCurated: boolean;
  elevationSin: number;
  rangeKm: number;
  observerDark: boolean;
  satelliteEclipsed: boolean;
  elevationThresholdSin?: number;
  rangeMaxKm?: number;
}

export interface VisualVisibilityResult {
  visible: boolean;
  reason: VisualVisibilityReason | null;
}

export function evaluateVisualVisibility(input: VisualVisibilityInput): VisualVisibilityResult {
  const elevationThresholdSin = input.elevationThresholdSin ?? VISUAL_ELEVATION_THRESHOLD_SIN;
  const rangeMaxKm = input.rangeMaxKm ?? VISUAL_RANGE_MAX_KM;

  if (!input.isCurated) {
    return { visible: false, reason: 'not_curated' };
  }

  if (input.elevationSin < elevationThresholdSin) {
    return { visible: false, reason: 'below_elevation' };
  }

  if (input.rangeKm > rangeMaxKm) {
    return { visible: false, reason: 'out_of_range' };
  }

  if (!input.observerDark) {
    return { visible: false, reason: 'observer_daylight' };
  }

  if (input.satelliteEclipsed) {
    return { visible: false, reason: 'satellite_eclipsed' };
  }

  return { visible: true, reason: null };
}

export interface DomeBrightnessInput {
  elevationSin: number;
  rangeKm: number;
  isCurated: boolean;
  observerDark: boolean;
  satelliteEclipsed: boolean;
  /** Illuminated-phase fraction (0..1) of the satellite as seen by the observer. */
  illuminatedPhase: number;
}

export interface DomeBrightnessResult {
  /** Size/brightness multiplier for the object's base size (0 = hidden). */
  factor: number;
  /** True when genuinely naked-eye-visible — drives the colour highlight. */
  highlighted: boolean;
}

/**
 * Sky-dome size/brightness for one satellite — multiply the object's base size by
 * `factor` (`0` = hidden, below the horizon), and tint it when `highlighted`.
 *
 * Policy for the planetarium view: show everything above the horizon, but make the
 * genuinely naked-eye-visible objects (curated + dark + uneclipsed + in range, via
 * {@link evaluateVisualVisibility}) clearly the brightest — floored so a low-phase
 * pass never sinks into the faint background "traffic". Both fade gently across the
 * lowest 0–10° band so passes rise and set cleanly at the horizon.
 */
export function evaluateDomeBrightness(input: DomeBrightnessInput): DomeBrightnessResult {
  if (input.elevationSin < DOME_ELEVATION_THRESHOLD_SIN) {
    return { factor: 0, highlighted: false }; // below the horizon — not in the sky
  }

  const nakedEyeVisible = input.isCurated && evaluateVisualVisibility({
    isCurated: input.isCurated,
    elevationSin: input.elevationSin,
    rangeKm: input.rangeKm,
    observerDark: input.observerDark,
    satelliteEclipsed: input.satelliteEclipsed,
  }).visible;

  // Highlight floored well above the traffic so it's always findable; phase only adds.
  let factor = nakedEyeVisible ? (3.0 + 1.8 * input.illuminatedPhase) : 0.2;

  // Gentle fade in the lowest 0–10° band.
  if (input.elevationSin < VISUAL_ELEVATION_THRESHOLD_SIN) {
    factor *= Math.max(
      0.4,
      (input.elevationSin - DOME_ELEVATION_THRESHOLD_SIN)
      / (VISUAL_ELEVATION_THRESHOLD_SIN - DOME_ELEVATION_THRESHOLD_SIN),
    );
  }

  return { factor, highlighted: nakedEyeVisible };
}
