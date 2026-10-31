import * as THREE from 'three';
import type { EncounterSummary } from '@orbitwatch/contracts';
import { useStore } from '../../../store/useStore';
import { formatServerApproach, formatVisualSeparation } from '../../../data/encounter-format';
import { relativeApproachDirection, separationKm } from '../../scene/encounter-geometry';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/** Reads one object's interpolated scene position (Earth radii), t in [0,1]. Wired by the Engine. */
export type PositionReader = (index: number, t: number) => THREE.Vector3 | null;

/** Cyan/white family, matching the orbit trail and pass arc. No alarm colours. */
const LINE_COLOR = 0x9fe0ff;
const ARROW_COLOR = 0xe8f6ff;
const LABEL_TEXT = '#d8f2ff';
const LABEL_DIM = 'rgba(216, 242, 255, 0.72)';

/** Arrow length as a fraction of the camera's distance to the primary. */
const ARROW_LENGTH_FRAC = 0.06;
/** The label texture is redrawn at most this often (the separation changes every frame). */
const LABEL_REDRAW_MS = 250;
const LABEL_W = 780;
const LABEL_H = 112;
/** Label height as a fraction of the viewport (sprite without size attenuation). */
const LABEL_SCREEN_FRAC = 0.032;

interface Target {
  enc: EncounterSummary;
  primaryIdx: number;
  otherIdx: number;
}

type State = ReturnType<typeof useStore.getState>;

/**
 * The selected encounter (flyby) on the globe: a thin line between the two
 * objects, the other object's approach direction as a short arrow from the
 * primary, and a small label with the live separation (drawn from the rendered
 * positions and labelled "visual") above the server's closest-approach numbers.
 *
 * Visible only while an encounter is selected. Positions come from the satellite
 * renderer through a callback the Engine passes in (layers never import layers).
 * Store reads happen in one subscription that re-resolves the pair when the
 * selection, encounter list or catalog changes; update() only moves the geometry.
 */
export class EncounterLayer implements Layer {
  readonly name = 'encounter';
  readonly critical = false;

  private unsub: (() => void) | null = null;
  private group: THREE.Group | null = null;
  private line: THREE.Line | null = null;
  private linePositions = new Float32Array(6);
  private lineGeometry: THREE.BufferGeometry | null = null;
  private arrow: THREE.ArrowHelper | null = null;
  private label: THREE.Sprite | null = null;
  private labelCanvas: HTMLCanvasElement | null = null;
  private labelTexture: THREE.CanvasTexture | null = null;
  private labelKey = '';
  private labelAt = 0;
  private camera: THREE.PerspectiveCamera | null = null;

  private target: Target | null = null;
  private seen: { id: number | null; sat: State['selectedSatellite']; enc: State['encountersByNorad']; cat: State['catalogData'] } | null = null;

  private readonly mid = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(private readonly readPosition: PositionReader) {}

  init(ctx: LayerContext): void {
    this.camera = ctx.camera;
    const group = new THREE.Group();
    group.visible = false;
    group.renderOrder = 10;

    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.line = new THREE.Line(
      this.lineGeometry,
      new THREE.LineBasicMaterial({ color: LINE_COLOR, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false }),
    );
    this.line.frustumCulled = false;
    this.line.renderOrder = 10;
    group.add(this.line);

    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.05, ARROW_COLOR, 0.35 * 0.05, 0.18 * 0.05);
    for (const m of [this.arrow.line.material, this.arrow.cone.material] as THREE.Material[]) {
      m.depthTest = false;
      m.depthWrite = false;
      m.transparent = true;
    }
    this.arrow.renderOrder = 10;
    this.arrow.line.renderOrder = 10;
    this.arrow.cone.renderOrder = 10;
    this.arrow.visible = false;
    group.add(this.arrow);

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = LABEL_W;
    this.labelCanvas.height = LABEL_H;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.labelTexture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }),
    );
    this.label.center.set(0.5, -0.25); // sits just above the midpoint
    this.label.scale.set(LABEL_SCREEN_FRAC * (LABEL_W / LABEL_H), LABEL_SCREEN_FRAC, 1);
    this.label.renderOrder = 11;
    group.add(this.label);

    ctx.scene.add(group);
    this.group = group;

    this.resolve(useStore.getState());
    this.unsub = useStore.subscribe((state) => this.resolve(state));
  }

  /** Re-resolve the pair when (and only when) an input the pair depends on changed. */
  private resolve(state: State): void {
    const seen = this.seen;
    if (
      seen &&
      seen.id === state.selectedEncounterId &&
      seen.sat === state.selectedSatellite &&
      seen.enc === state.encountersByNorad &&
      seen.cat === state.catalogData
    ) {
      return;
    }
    this.seen = { id: state.selectedEncounterId, sat: state.selectedSatellite, enc: state.encountersByNorad, cat: state.catalogData };
    this.target = this.targetFor(state);
    this.labelKey = '';
    if (!this.target && this.group) this.group.visible = false;
  }

  private targetFor(state: State): Target | null {
    const sat = state.selectedSatellite;
    if (state.selectedEncounterId === null || !sat) return null;
    const enc = state.encountersByNorad[sat.noradId]?.find((e) => e.id === state.selectedEncounterId);
    if (!enc) return null;
    const otherNorad = enc.a.noradId === sat.noradId ? enc.b.noradId : enc.a.noradId;
    const primaryIdx = state.catalogData.findIndex((o) => o.noradId === sat.noradId);
    const otherIdx = state.catalogData.findIndex((o) => o.noradId === otherNorad);
    if (primaryIdx < 0 || otherIdx < 0) return null;
    return { enc, primaryIdx, otherIdx };
  }

  update(frame: FrameContext): void {
    const group = this.group;
    const target = this.target;
    if (!group || !target) return;

    const t = frame.uT;
    const pCur = this.readPosition(target.primaryIdx, t);
    const qCur = this.readPosition(target.otherIdx, t);
    if (!pCur || !qCur) {
      group.visible = false;
      return;
    }
    group.visible = true;

    // Separation line.
    const a = this.linePositions;
    a[0] = pCur.x; a[1] = pCur.y; a[2] = pCur.z;
    a[3] = qCur.x; a[4] = qCur.y; a[5] = qCur.z;
    (this.lineGeometry!.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.lineGeometry!.computeBoundingSphere();

    // Approach direction from the previous and current renderer samples (~1 s apart).
    const p0 = this.readPosition(target.primaryIdx, 0);
    const p1 = this.readPosition(target.primaryIdx, 1);
    const q0 = this.readPosition(target.otherIdx, 0);
    const q1 = this.readPosition(target.otherIdx, 1);
    const arrow = this.arrow!;
    const dir = p0 && p1 && q0 && q1 ? relativeApproachDirection(p0, p1, q0, q1, this.dir) : null;
    if (dir && this.camera) {
      const len = this.camera.position.distanceTo(pCur) * ARROW_LENGTH_FRAC;
      arrow.position.copy(pCur);
      arrow.setDirection(dir);
      arrow.setLength(len, len * 0.3, len * 0.16);
      arrow.visible = true;
    } else {
      arrow.visible = false;
    }

    // Label at the midpoint.
    this.mid.copy(pCur).add(qCur).multiplyScalar(0.5);
    this.label!.position.copy(this.mid);
    this.drawLabel(formatVisualSeparation(separationKm(pCur, qCur)), formatServerApproach(target.enc));
  }

  private drawLabel(sepText: string, serverText: string): void {
    const now = performance.now();
    const key = `${sepText}|${serverText}`;
    if (key === this.labelKey || (this.labelKey !== '' && now - this.labelAt < LABEL_REDRAW_MS)) return;
    this.labelKey = key;
    this.labelAt = now;
    const canvas = this.labelCanvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !this.labelTexture) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(8, 16, 28, 0.62)';
    ctx.beginPath();
    ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 14);
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.font = '600 30px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = LABEL_TEXT;
    ctx.fillText(`Separation ${sepText}`, 20, 36);
    ctx.font = '22px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = LABEL_DIM;
    ctx.fillText(serverText, 20, 78);
    this.labelTexture.needsUpdate = true;
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    this.group?.parent?.remove(this.group);
    this.lineGeometry?.dispose();
    (this.line?.material as THREE.Material | undefined)?.dispose();
    this.arrow?.dispose();
    (this.label?.material as THREE.Material | undefined)?.dispose();
    this.labelTexture?.dispose();
    this.group = null;
    this.line = null;
    this.lineGeometry = null;
    this.arrow = null;
    this.label = null;
    this.labelTexture = null;
    this.labelCanvas = null;
    this.target = null;
  }
}
