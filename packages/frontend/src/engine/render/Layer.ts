import type * as THREE from 'three';

/**
 * The engine-level layer contract. A {@link Layer} is a self-contained visual
 * subsystem (Earth, satellites, DSO, starfield, trails, observer marker) with a
 * uniform init/update/dispose lifecycle, managed by {@link World}.
 *
 * Layers must never import other layers; cross-layer wiring is done by the
 * Engine via callbacks.
 */

/** Init-time dependencies handed to every layer once, from Engine/Renderer/Camera. */
export interface LayerContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  maxAnisotropy: number;
}

/** Per-frame values the Engine computes once and passes to every layer's update. */
export interface FrameContext {
  /** Current simulation time. */
  date: Date;
  /** Current simulation time in ms (`simClock.now()`). */
  nowMs: number;
  /** Wall-clock frame delta in seconds (`THREE.Clock.getDelta()`). */
  delta: number;
  /** SGP4 GPU-side interpolation factor (`sgp4Client.getTickState().uT`). */
  uT: number;
  pixelRatio: number;
  /** `camera.position.length()` — used for size/LOD scaling. */
  cameraDistance: number;
  /** Sun direction in the ECI/scene frame. */
  sunDirectionECI: THREE.Vector3;
  /** Greenwich Apparent Sidereal Time, radians — Earth's `rotation.y`. */
  gastRadians: number;
  /** Camera is following a target in first-person joyride style (trail dims). */
  isJoyrideTracking: boolean;
  /**
   * Seconds since the camera arrived at the selected object (drives the TLE
   * selection glow), or -1 if none. Computed once per frame from
   * `nav.getArrivalTime()`; consumed only by SatellitesLayer.
   */
  selectionTimeSinceArrival: number;
}

export interface Layer {
  readonly name: string;
  /**
   * Critical layers ARE the product (satellites). A throw from a critical layer
   * escalates to a user-visible error; a non-critical layer fails soft so the
   * rest of the scene keeps working (CLAUDE.md graceful-degradation rule).
   */
  readonly critical: boolean;
  init(ctx: LayerContext): void | Promise<void>;
  update(frame: FrameContext): void;
  dispose(): void;
}
