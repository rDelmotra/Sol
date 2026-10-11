import * as THREE from 'three';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore, isDomeView } from '../../../store/useStore';
import { pickCurrentPass, DEFAULT_MIN_ELEVATION_DEG, type Pass } from '../../../sky/passes';
import { samplePassArc } from '../../../sky/pass-arc';
import type { GeodeticObserver } from '../../../data/types';
import { writeSourceToScene } from '../../scene/frames';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/** Samples along the arc. Dense enough to read as a smooth curve at dome scale. */
const ARC_POINTS = 150;

/** Cyan, matching the observer marker and orbit trail. Bright at or above 10°. */
const BRIGHT_COLOR = new THREE.Color(0x9fe0ff);
/** Same hue dimmed for the 0–10° fringe: "same path, not worth watching yet". */
const DIM_COLOR = new THREE.Color(0x9fe0ff).multiplyScalar(0.5);

type State = ReturnType<typeof useStore.getState>;

/** The store fields (and picked pass) the last sync was made from. */
interface SeenInputs {
  sat: State['selectedSatellite'];
  observer: State['observerLocation'];
  status: State['passStatus'];
  passes: State['nextPasses'];
  cameraMode: State['cameraMode'];
  vantage: State['vantage'];
  pass: Pass | null;
}

/** What the arc is drawn for. Rebuilt only when this changes. */
interface ArcTarget {
  key: string;
  sat: EnrichedTLEObject;
  observer: GeodeticObserver;
  pass: Pass;
}

/**
 * The selected object's current or next pass, drawn across the dome sky from
 * horizon to horizon. Bright where it is at least 10° up, dim below. Solid for
 * the part already flown, dashed for the part still ahead.
 *
 * The curve is sampled in Earth-fixed coordinates (sky/pass-arc.ts) and parented
 * to the rotating Earth group, like the horizon compass, so its ends stay on the
 * observer's horizon as the Earth turns.
 *
 * Store reads happen in ONE subscription, not in the frame loop: it picks the
 * pass, rebuilds the geometry when the pass changes, and tracks visibility.
 * Per frame, update() only moves the solid/dashed split to the sim clock.
 */
export class PassArcLayer implements Layer {
  readonly name = 'pass-arc';
  readonly critical = false;

  private unsub: (() => void) | null = null;
  private currentKey: string | null = null;
  /** Inputs of the last sync; see needsSync. */
  private seen: SeenInputs | null = null;
  private visible = false;

  /** Vertex data. The dashed line wears a second wrapper over the same attributes
   *  because drawRange lives on the geometry, not the line. */
  private geometry: THREE.BufferGeometry | null = null;
  private dashedGeometry: THREE.BufferGeometry | null = null;
  private solidLine: THREE.Line | null = null;
  private dashedLine: THREE.Line | null = null;
  private solidMaterial: THREE.LineBasicMaterial | null = null;
  private dashedMaterial: THREE.LineDashedMaterial | null = null;
  private spanStartMs = 0;
  private spanMs = 0;

  /** `getParent` resolves the Earth group lazily (it exists after EarthLayer.init). */
  constructor(private readonly getParent: () => THREE.Object3D | null) {}

  init(_ctx: LayerContext): void {
    this.sync(useStore.getState());
    this.unsub = useStore.subscribe((state) => {
      if (!this.needsSync(state)) return;
      try {
        this.sync(state);
      } catch (err) {
        // Fail soft: a bad element set must not break the store notify turn.
        console.warn('[pass-arc] rebuild failed', err);
        this.clear();
      }
    });
  }

  /**
   * The store notifies on every write, including the 4 Hz clock. Sync only when a
   * field the arc reads changed. The clock matters only through which pass is
   * current, so a clock-only write is skipped while the same pass stays current.
   */
  private needsSync(state: State): boolean {
    const seen = this.seen;
    const unchanged =
      seen !== null &&
      seen.sat === state.selectedSatellite &&
      seen.observer === state.observerLocation &&
      seen.status === state.passStatus &&
      seen.passes === state.nextPasses &&
      seen.cameraMode === state.cameraMode &&
      seen.vantage === state.vantage &&
      seen.pass === pickCurrentPass(state.nextPasses, state.simTimeMs);
    return !unchanged;
  }

  private sync(state: State): void {
    this.seen = {
      sat: state.selectedSatellite,
      observer: state.observerLocation,
      status: state.passStatus,
      passes: state.nextPasses,
      cameraMode: state.cameraMode,
      vantage: state.vantage,
      pass: pickCurrentPass(state.nextPasses, state.simTimeMs),
    };
    const target = this.targetFor(state);
    if ((target?.key ?? null) !== this.currentKey) {
      this.clear();
      if (target) this.build(target);
      this.currentKey = target?.key ?? null;
    }
    this.visible = target !== null && isDomeView(state);
    if (this.solidLine) this.solidLine.visible = this.visible;
    if (this.dashedLine) this.dashedLine.visible = this.visible;
  }

  private targetFor(state: State): ArcTarget | null {
    const sat = state.selectedSatellite;
    const observer = state.observerLocation;
    if (!sat || !observer || state.passStatus !== 'ok') return null;
    const pass = pickCurrentPass(state.nextPasses, state.simTimeMs);
    if (!pass) return null;
    // Not aosMs: it is reset to the search start for a pass already in progress,
    // so it moves on every recompute. The horizon span (whole seconds) does not.
    const key = `${sat.noradId}:${Math.round(pass.horizonAosMs / 1000)}:${Math.round(pass.horizonLosMs / 1000)}`;
    return { key, sat, observer, pass };
  }

  private build({ sat, observer, pass }: ArcTarget): void {
    const parent = this.getParent();
    if (!parent) return;
    const samples = samplePassArc(
      sat.omm,
      { latDeg: observer.lat, lonDeg: observer.lon, altKm: observer.alt },
      pass.horizonAosMs,
      pass.horizonLosMs,
      ARC_POINTS,
    );
    if (!samples) return;

    const positions = new Float32Array(ARC_POINTS * 3);
    const colors = new Float32Array(ARC_POINTS * 3);
    for (let i = 0; i < ARC_POINTS; i++) {
      const e = samples.ecefEr;
      writeSourceToScene(positions, i * 3, e[i * 3], e[i * 3 + 1], e[i * 3 + 2]);
      const c = samples.elevationDeg[i] >= DEFAULT_MIN_ELEVATION_DEG ? BRIGHT_COLOR : DIM_COLOR;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    const positionAttr = new THREE.BufferAttribute(positions, 3);
    const colorAttr = new THREE.BufferAttribute(colors, 3);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', positionAttr);
    this.geometry.setAttribute('color', colorAttr);
    this.solidMaterial = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false,
    });
    this.dashedMaterial = new THREE.LineDashedMaterial({
      vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false,
      dashSize: 0.02, gapSize: 0.015,
    });
    this.solidLine = new THREE.Line(this.geometry, this.solidMaterial);
    this.solidLine.frustumCulled = false;
    this.solidLine.computeLineDistances(); // writes lineDistance for the dashed wrapper

    this.dashedGeometry = new THREE.BufferGeometry();
    this.dashedGeometry.setAttribute('position', positionAttr);
    this.dashedGeometry.setAttribute('color', colorAttr);
    this.dashedGeometry.setAttribute('lineDistance', this.geometry.getAttribute('lineDistance'));
    this.dashedLine = new THREE.Line(this.dashedGeometry, this.dashedMaterial);
    this.dashedLine.frustumCulled = false;

    this.spanStartMs = pass.horizonAosMs;
    this.spanMs = pass.horizonLosMs - pass.horizonAosMs;
    this.geometry.setDrawRange(0, 0);
    this.dashedGeometry.setDrawRange(0, ARC_POINTS);
    parent.add(this.solidLine);
    parent.add(this.dashedLine);
  }

  update(frame: FrameContext): void {
    if (!this.visible || !this.geometry || !this.dashedGeometry) return;
    const k = this.sampleIndexAt(frame.nowMs);
    // The two ranges share vertex k, so the segment at the object's own position
    // belongs to one of them and the arc does not break open there.
    this.geometry.setDrawRange(0, k > 0 ? Math.min(ARC_POINTS, k + 1) : 0);
    this.dashedGeometry.setDrawRange(k, ARC_POINTS - k);
  }

  /** Sample index of `nowMs` in [0, ARC_POINTS]: 0 = nothing flown, ARC_POINTS = all flown. */
  private sampleIndexAt(nowMs: number): number {
    if (!(this.spanMs > 0)) return 0;
    const f = (nowMs - this.spanStartMs) / this.spanMs;
    if (f <= 0) return 0;
    if (f >= 1) return ARC_POINTS;
    return Math.round(f * (ARC_POINTS - 1));
  }

  private clear(): void {
    this.solidLine?.parent?.remove(this.solidLine);
    this.dashedLine?.parent?.remove(this.dashedLine);
    this.solidLine = null;
    this.dashedLine = null;
    this.solidMaterial?.dispose();
    this.dashedMaterial?.dispose();
    this.solidMaterial = null;
    this.dashedMaterial = null;
    this.geometry?.dispose();
    this.dashedGeometry?.dispose();
    this.geometry = null;
    this.dashedGeometry = null;
    this.spanStartMs = 0;
    this.spanMs = 0;
    this.currentKey = null;
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    this.clear();
  }
}
