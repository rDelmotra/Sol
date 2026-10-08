import * as THREE from 'three';
import vertexShader from '../shaders/catalog.vert.glsl?raw';
import fragmentShader from '../shaders/catalog.frag.glsl?raw';
import { emptyFacetCounts, type FacetCounts } from '../data/types';
import type { EnrichedTLEObject, ObjectCategory, OrbitalRegime } from '@orbitwatch/contracts';
import {
  TYPE_COLORS,
  STATUS_COLORS,
  COUNTRY_COLORS,
  FALLBACK_GREY,
  sectorColor,
  type RGB,
} from '../data/facet-colors';
import {
  getPhaseMultiplierFromComponents,
  isEclipsedFromComponents,
  isObserverDarkFromUp,
  evaluateDomeBrightness,
  VISUAL_ELEVATION_THRESHOLD_SIN,
  VISUAL_FADING_START_SIN,
  VISUAL_RANGE_MAX_KM,
  ER_KM,
} from '@orbitwatch/orbital-core';
import { writeSourceToScene } from './scene/frames';
import type { VisibilityMode, ColorBy, SatelliteFilterState } from '../store/useStore';

const MAX_OBJECTS = 100_000;

/** Observer position + local "up" (zenith), scene frame — see engine/scene/sky.ts. */
export interface ObserverSceneAnchor {
  position: THREE.Vector3;
  up: THREE.Vector3;
}

// Color palettes live in data/facet-colors (shared with the FilterPanel legend).
// recolorBy() writes ONLY the color attribute from them — never pickId — so GPU
// picking (which decodes pickId, not color) is unaffected by any recolor.

/** RGB for one object under the active color-by dimension. */
function colorForObject(obj: EnrichedTLEObject, colorBy: ColorBy): RGB {
  switch (colorBy) {
    case 'type':
      return TYPE_COLORS[obj.objectType] ?? FALLBACK_GREY;
    case 'status':
      return STATUS_COLORS[obj.status] ?? FALLBACK_GREY;
    case 'sector':
      return sectorColor(obj.sectors);
    case 'country':
      return COUNTRY_COLORS[obj.countryCode] ?? FALLBACK_GREY;
  }
}

/** The per-group visible tallies returned by the render-side filter pass. */
export interface VisibleCounts {
  categoryCounts: Record<ObjectCategory, number>;
  regimeCounts: Record<OrbitalRegime, number>;
  facetCounts: FacetCounts;
}

export class SatelliteRenderer {
  readonly mesh: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly prevPosAttr: THREE.BufferAttribute;
  private readonly currPosAttr: THREE.BufferAttribute;
  private readonly prevSizeAttr: THREE.BufferAttribute;
  private readonly currSizeAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute; // Alias for currSizeAttr for picking
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly pickIdAttr: THREE.BufferAttribute;
  private readonly highlightAttr: THREE.BufferAttribute;
  private readonly multipliers: Float32Array;
  private readonly filterMask: Uint8Array;
  private readonly validFlags: Uint8Array;
  /** Highest catalog length initialised so far — lets reinit clear a shrunk tail. */
  private initializedCount = 0;

  constructor(scene: THREE.Scene) {
    const prevPositions = new Float32Array(MAX_OBJECTS * 3);
    const currPositions = new Float32Array(MAX_OBJECTS * 3);
    const prevSizes = new Float32Array(MAX_OBJECTS);
    const currSizes = new Float32Array(MAX_OBJECTS);
    const colors = new Float32Array(MAX_OBJECTS * 3);
    const pickIds = new Float32Array(MAX_OBJECTS * 3); // 0,0,0 = background until initFromCatalog
    const highlights = new Float32Array(MAX_OBJECTS); // 0 = normal, 1 = naked-eye highlight (dome)
    this.multipliers = new Float32Array(MAX_OBJECTS).fill(1.0);
    this.filterMask = new Uint8Array(MAX_OBJECTS).fill(1);
    this.validFlags = new Uint8Array(MAX_OBJECTS).fill(0);

    this.geometry = new THREE.BufferGeometry();
    this.prevPosAttr = new THREE.BufferAttribute(prevPositions, 3);
    this.currPosAttr = new THREE.BufferAttribute(currPositions, 3);
    this.prevSizeAttr = new THREE.BufferAttribute(prevSizes, 1);
    this.currSizeAttr = new THREE.BufferAttribute(currSizes, 1);
    this.sizeAttr = this.currSizeAttr;
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    this.pickIdAttr = new THREE.BufferAttribute(pickIds, 3);
    this.highlightAttr = new THREE.BufferAttribute(highlights, 1);

    this.geometry.setAttribute('previousPosition', this.prevPosAttr);
    this.geometry.setAttribute('currentPosition', this.currPosAttr);
    this.geometry.setAttribute('position', this.currPosAttr); // Three.js requires 'position' for bounding sphere
    this.geometry.setAttribute('previousSize', this.prevSizeAttr);
    this.geometry.setAttribute('currentSize', this.currSizeAttr);
    this.geometry.setAttribute('size', this.sizeAttr); // For CPU picking compatibility
    this.geometry.setAttribute('color', this.colorAttr);
    this.geometry.setAttribute('pickId', this.pickIdAttr);
    this.geometry.setAttribute('highlight', this.highlightAttr);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uPixelRatio: { value: 1.0 },
        uCameraDistance: { value: 5.0 },
        uBaseColor: { value: new THREE.Vector3(1, 1, 1) },
        uT: { value: 0.0 },
        uSelectedIndex: { value: -1.0 },
        uTimeSinceArrival: { value: -1.0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Points(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  updatePositions(
    eciPositions: Float32Array,
    validFlags: Uint8Array,
    count: number,
    observer: ObserverSceneAnchor | null,
    sunDir: THREE.Vector3,
    visibilityMode: VisibilityMode,
    catalogData: EnrichedTLEObject[],
    filters: SatelliteFilterState,
    visualNoradIds: Set<number>
  ): VisibleCounts {
    const prevArr = this.prevPosAttr.array as Float32Array;
    const currArr = this.currPosAttr.array as Float32Array;

    // Copy current → previous (in-place, no reallocation)
    prevArr.set(currArr);
    this.validFlags.set(validFlags);

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      // ECI (TEME) → Three.js scene frame
      writeSourceToScene(currArr, i3, eciPositions[i3], eciPositions[i3 + 1], eciPositions[i3 + 2]);
    }

    this.prevPosAttr.needsUpdate = true;
    this.currPosAttr.needsUpdate = true;

    return this.applyVisibilityAndFilters(count, observer, sunDir, visibilityMode, catalogData, filters, visualNoradIds, false);
  }

  /** Write positions into both previous and current buffers (no interpolation tween). */
  snapPositions(
    eciPositions: Float32Array,
    validFlags: Uint8Array,
    count: number,
    observer: ObserverSceneAnchor | null,
    sunDir: THREE.Vector3,
    visibilityMode: VisibilityMode,
    catalogData: EnrichedTLEObject[],
    filters: SatelliteFilterState,
    visualNoradIds: Set<number>
  ): VisibleCounts {
    const prevArr = this.prevPosAttr.array as Float32Array;
    const currArr = this.currPosAttr.array as Float32Array;
    this.validFlags.set(validFlags);

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const ex = eciPositions[i3];
      const ey = eciPositions[i3 + 1];
      const ez = eciPositions[i3 + 2];
      // ECI (TEME) → Three.js scene frame, written into both buffers (no tween on snap)
      writeSourceToScene(currArr, i3, ex, ey, ez);
      writeSourceToScene(prevArr, i3, ex, ey, ez);
    }

    this.prevPosAttr.needsUpdate = true;
    this.currPosAttr.needsUpdate = true;

    return this.applyVisibilityAndFilters(count, observer, sunDir, visibilityMode, catalogData, filters, visualNoradIds, true);
  }

  setSatelliteSize(index: number, multiplier: number): void {
    this.multipliers[index] = multiplier;
    const currSizeArr = this.currSizeAttr.array as Float32Array;
    currSizeArr[index] = multiplier; // update immediately if not waiting for next propagate
    this.currSizeAttr.needsUpdate = true;
  }

  /**
   * Seed per-object render data INDEPENDENT of the color-by dimension: the RCS
   * size multiplier and the GPU-pick id (catalog index `i+1` encoded as RGB).
   * COLOR is written separately by {@link recolorBy}, so pickId writes stay
   * isolated here and a recolor can never disturb picking.
   */
  initFromCatalog(objects: EnrichedTLEObject[]): void {
    const pickArr = this.pickIdAttr.array as Float32Array;

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      let rcsMult = 1.0;
      if (obj.rcsSize === 'LARGE') rcsMult = 1.2;
      else if (obj.rcsSize === 'SMALL') rcsMult = 0.6;
      this.multipliers[i] = rcsMult;

      const encoded = i + 1; // reserve 0 for background
      pickArr[i * 3]     = ((encoded >> 16) & 0xFF) / 255;
      pickArr[i * 3 + 1] = ((encoded >> 8)  & 0xFF) / 255;
      pickArr[i * 3 + 2] = ( encoded        & 0xFF) / 255;
    }

    this.pickIdAttr.needsUpdate = true;
    this.initializedCount = objects.length;
  }

  /**
   * Rewrite the per-object COLOR attribute from the active color-by dimension.
   * Touches ONLY colorAttr — never pickIdAttr — so GPU picking (which decodes the
   * pickId buffer, not color) is invariant under any recolor. Called once after
   * initFromCatalog/reinitFromCatalog, and again whenever `colorBy` changes.
   */
  recolorBy(objects: EnrichedTLEObject[], colorBy: ColorBy): void {
    const colorArr = this.colorAttr.array as Float32Array;
    for (let i = 0; i < objects.length; i++) {
      const [r, g, b] = colorForObject(objects[i], colorBy);
      colorArr[i * 3]     = r;
      colorArr[i * 3 + 1] = g;
      colorArr[i * 3 + 2] = b;
    }
    this.colorAttr.needsUpdate = true;
  }

  /**
   * Re-seed colors/pickIds from a NEW catalog (historical time-scrub). Buffers are
   * fixed-size and propagation only writes [0,count), so a smaller catalog would
   * otherwise leave the old tail [len, prevCount) rendering + pickable as ghost
   * points. Clear that tail (size, validFlags, pickId, highlight), then run the
   * normal init writes for [0,len).
   */
  reinitFromCatalog(objects: EnrichedTLEObject[]): void {
    const prevCount = this.initializedCount;
    const currSizeArr = this.currSizeAttr.array as Float32Array;
    const prevSizeArr = this.prevSizeAttr.array as Float32Array;
    const pickArr = this.pickIdAttr.array as Float32Array;
    const highlightArr = this.highlightAttr.array as Float32Array;

    for (let i = objects.length; i < prevCount; i++) {
      currSizeArr[i] = 0;
      prevSizeArr[i] = 0;
      this.validFlags[i] = 0;
      this.multipliers[i] = 1.0;
      highlightArr[i] = 0;
      pickArr[i * 3] = 0;
      pickArr[i * 3 + 1] = 0;
      pickArr[i * 3 + 2] = 0;
    }
    if (objects.length < prevCount) {
      this.currSizeAttr.needsUpdate = true;
      this.prevSizeAttr.needsUpdate = true;
      this.highlightAttr.needsUpdate = true;
    }

    // Writes colors/pickIds for [0,len) and updates initializedCount.
    this.initFromCatalog(objects);
  }

  updateUniforms(cameraDistance: number, pixelRatio: number): void {
    this.material.uniforms.uCameraDistance.value = cameraDistance;
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  updateSelectedUniforms(selectedIndex: number, timeSinceArrival: number): void {
    this.material.uniforms.uSelectedIndex.value = selectedIndex;
    this.material.uniforms.uTimeSinceArrival.value = timeSinceArrival;
  }

  /** Returns the GPU-equivalent interpolated world position for a single object. */
  getInterpolatedPosition(index: number, t: number): THREE.Vector3 {
    const prevArr = this.prevPosAttr.array as Float32Array;
    const currArr = this.currPosAttr.array as Float32Array;
    const i3 = index * 3;
    return new THREE.Vector3(
      prevArr[i3]     + (currArr[i3]     - prevArr[i3])     * t,
      prevArr[i3 + 1] + (currArr[i3 + 1] - prevArr[i3 + 1]) * t,
      prevArr[i3 + 2] + (currArr[i3 + 2] - prevArr[i3 + 2]) * t,
    );
  }

  private applyVisibilityAndFilters(
    count: number,
    observer: ObserverSceneAnchor | null,
    sunDir: THREE.Vector3,
    visibilityMode: VisibilityMode,
    catalogData: EnrichedTLEObject[],
    filters: SatelliteFilterState,
    visualNoradIds: Set<number>,
    snap = false
  ): VisibleCounts {
    const prevSizeArr = this.prevSizeAttr.array as Float32Array;
    const currSizeArr = this.currSizeAttr.array as Float32Array;
    const currArr = this.currPosAttr.array as Float32Array;
    const highlightArr = this.highlightAttr.array as Float32Array;

    if (!snap) {
      prevSizeArr.set(currSizeArr);
    }

    const catCounts: Record<ObjectCategory, number> = {
      active_satellite: 0, inactive_satellite: 0, rocket_body: 0, debris: 0, unknown: 0, deep_space: 0,
    };
    const regCounts: Record<OrbitalRegime, number> = {
      LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0,
    };
    const facetCounts = emptyFacetCounts();

    // Destructure once (the gate runs per object over the whole catalog).
    const { typeFilters, statusFilters, sectorFilters, purposeFilters, regimeFilters, countryFilter, programFilter, launchFilter, ownerFilter, analyticFilter } = filters;
    const countryAll = countryFilter.mode === 'all';
    const countryCodes = countryFilter.mode === 'only' ? countryFilter.codes : null;
    const programAll = programFilter.mode === 'all';
    const programIds = programFilter.mode === 'only' ? programFilter.ids : null;
    const launchAll = launchFilter.mode === 'all';
    const launchTags = launchFilter.mode === 'only' ? launchFilter.tags : null;
    const ownerAll = ownerFilter.mode === 'all';
    const ownerCodes = ownerFilter.mode === 'only' ? ownerFilter.codes : null;
    const analyticAll = analyticFilter.mode === 'all';
    const analyticIds = analyticFilter.mode === 'only' ? analyticFilter.ids : null;

    const observerAvailable = observer !== null;
    const obsX = observer?.position.x ?? 0;
    const obsY = observer?.position.y ?? 0;
    const obsZ = observer?.position.z ?? 0;
    // Local zenith is the observer's already-unit "up" (geodetic normal) — no need to
    // normalize the position ourselves (see engine/scene/sky.ts / orbital-core observer.ts).
    const zenithX = observer?.up.x ?? 0;
    const zenithY = observer?.up.y ?? 0;
    const zenithZ = observer?.up.z ?? 0;
    const hasZenith = observerAvailable;
    const sunX = sunDir.x;
    const sunY = sunDir.y;
    const sunZ = sunDir.z;
    const obsInDark = observerAvailable
      ? isObserverDarkFromUp(zenithX, zenithY, zenithZ, sunX, sunY, sunZ)
      : false;

    for (let i = 0; i < count; i++) {
      const obj = catalogData[i];

      // Facet gate (inlined — runs over the whole catalog). An object shows only if
      // every active facet group admits it: type, status, regime, sector (any of its
      // sectors enabled, or 'unspecified' when it has none), purpose, and country.
      let isVisibleBase = this.validFlags[i] === 1
        && typeFilters[obj.objectType]
        && statusFilters[obj.status]
        && regimeFilters[obj.regime]
        && purposeFilters[obj.purpose];
      if (isVisibleBase) {
        // Sector (multi-valued) — manual loop to avoid a per-object closure alloc.
        if (obj.sectors.length === 0) {
          isVisibleBase = sectorFilters.unspecified;
        } else {
          let anySector = false;
          for (let k = 0; k < obj.sectors.length; k++) {
            if (sectorFilters[obj.sectors[k]]) { anySector = true; break; }
          }
          isVisibleBase = anySector;
        }
      }
      if (isVisibleBase && !countryAll) {
        isVisibleBase = countryCodes!.has(obj.countryCode || 'TBD');
      }
      // Program (query-driven): objects without a program are excluded when a
      // program filter is active — "starlink" means only Starlink.
      if (isVisibleBase && !programAll) {
        isVisibleBase = programIds!.has(obj.program ?? '');
      }
      // Launch/owner (query-driven, G3): same exclude-when-absent semantics as
      // program. Vehicle/site/year queries have already been compiled to a
      // launch-tag set upstream (executor), so this stays a single O(1) lookup.
      if (isVisibleBase && !launchAll) {
        isVisibleBase = launchTags!.has(obj.launchTag ?? '');
      }
      if (isVisibleBase && !ownerAll) {
        isVisibleBase = ownerCodes!.has(obj.owner ?? '');
      }
      // Analytic allow-set (P1): the noradIds an Analytic IR program returned.
      if (isVisibleBase && !analyticAll) {
        isVisibleBase = analyticIds!.has(obj.noradId);
      }

      this.filterMask[i] = isVisibleBase ? 1 : 0;
      highlightArr[i] = 0; // default; only the dome's naked-eye-visible ones light up

      let finalMult = 0.0;

      if (isVisibleBase) {
        finalMult = this.multipliers[i];

        if (visibilityMode === 'radio' && observerAvailable && hasZenith) {
          const i3 = i * 3;
          const satX = currArr[i3];
          const satY = currArr[i3 + 1];
          const satZ = currArr[i3 + 2];
          const vx = satX - obsX;
          const vy = satY - obsY;
          const vz = satZ - obsZ;
          const vDist = Math.sqrt((vx * vx) + (vy * vy) + (vz * vz));
          if (vDist === 0) {
            finalMult = 0.0;
          } else {
            const elevationSin = ((vx * zenithX) + (vy * zenithY) + (vz * zenithZ)) / vDist;
            if (elevationSin < VISUAL_ELEVATION_THRESHOLD_SIN) {
              finalMult = 0.0;
            } else {
              // Radio pass: RCS multiplier already in finalMult; apply range + mode scalar
              const distKm = vDist * ER_KM;
              const rangeScale = Math.max(0.3, Math.min(1.0, VISUAL_RANGE_MAX_KM / distKm));
              finalMult *= rangeScale * 0.6;

              // Fading cone: gradual falloff from 45° to 10° elevation
              if (finalMult > 0.0 && elevationSin < VISUAL_FADING_START_SIN) {
                finalMult *= Math.max(
                  0.4,
                  (elevationSin - VISUAL_ELEVATION_THRESHOLD_SIN)
                  / (VISUAL_FADING_START_SIN - VISUAL_ELEVATION_THRESHOLD_SIN),
                );
              }
            }
          }
        } else if (visibilityMode === 'dome' && observerAvailable && hasZenith) {
          // Sky-dome: everything above the horizon, naked-eye ones highlighted. The
          // per-object policy (horizon gate + highlight + fade) lives in the pure
          // evaluateDomeBrightness(); the renderer just supplies geometry + lighting.
          const i3 = i * 3;
          const satX = currArr[i3];
          const satY = currArr[i3 + 1];
          const satZ = currArr[i3 + 2];
          const vx = satX - obsX;
          const vy = satY - obsY;
          const vz = satZ - obsZ;
          const vDist = Math.sqrt((vx * vx) + (vy * vy) + (vz * vz));
          if (vDist === 0) {
            finalMult = 0.0;
          } else {
            const elevationSin = ((vx * zenithX) + (vy * zenithY) + (vz * zenithZ)) / vDist;
            const dome = evaluateDomeBrightness({
              elevationSin,
              rangeKm: vDist * ER_KM,
              isCurated: visualNoradIds.has(obj.noradId),
              observerDark: obsInDark,
              satelliteEclipsed: isEclipsedFromComponents(satX, satY, satZ, sunX, sunY, sunZ),
              illuminatedPhase: getPhaseMultiplierFromComponents(
                satX, satY, satZ, obsX, obsY, obsZ, sunX, sunY, sunZ,
              ),
            });
            finalMult *= dome.factor;
            if (dome.highlighted) highlightArr[i] = 1;
          }
        }

        currSizeArr[i] = finalMult;
        if (finalMult > 0.0) {
          // Tally the visible object into every facet group (mirrors buildCatalogResult).
          catCounts[obj.category]++;
          regCounts[obj.regime]++;
          facetCounts.type[obj.objectType]++;
          facetCounts.status[obj.status]++;
          facetCounts.purpose[obj.purpose]++;
          if (obj.sectors.length === 0) {
            facetCounts.sector.unspecified++;
          } else {
            for (let k = 0; k < obj.sectors.length; k++) facetCounts.sector[obj.sectors[k]]++;
          }
          const code = obj.countryCode || 'TBD';
          facetCounts.country[code] = (facetCounts.country[code] ?? 0) + 1;
        }
      } else {
        currSizeArr[i] = 0.0;
      }
    }

    if (snap) {
      prevSizeArr.set(currSizeArr);
    }
    this.prevSizeAttr.needsUpdate = true;
    this.currSizeAttr.needsUpdate = true;
    this.highlightAttr.needsUpdate = true;
    return { categoryCounts: catCounts, regimeCounts: regCounts, facetCounts };
  }

  applyFilters(
    catalogData: EnrichedTLEObject[],
    filters: SatelliteFilterState,
    observer: ObserverSceneAnchor | null,
    sunDir: THREE.Vector3,
    visibilityMode: VisibilityMode,
    visualNoradIds: Set<number>
  ): VisibleCounts {
    return this.applyVisibilityAndFilters(catalogData.length, observer, sunDir, visibilityMode, catalogData, filters, visualNoradIds);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
