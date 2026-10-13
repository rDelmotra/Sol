import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

/**
 * Thin wrapper around three's {@link KTX2Loader} for GPU-compressed (KTX2 / Basis)
 * textures. One instance owns the transcoder worker pool (created via
 * `setTranscoderPath` + `detectSupport`) and is shared across all of a renderer's
 * texture loads.
 *
 * It also **tracks every texture it loads and disposes them in {@link dispose}** —
 * `KTX2Loader.dispose()` only frees the worker pool, and `Material.dispose()` does NOT
 * free textures held in shader uniforms, so without this the `CompressedTexture`s would
 * leak VRAM on teardown.
 *
 * The `load(path, colorSpace, onLoad)` signature mirrors the inline helper EarthRenderer
 * used with `THREE.TextureLoader`, so call sites barely change.
 */
export class KtxTextureLoader {
  private readonly loader: KTX2Loader;
  private readonly maxAnisotropy: number;
  private readonly loaded: THREE.Texture[] = [];
  private disposed = false;
  private pending = 0;
  private releaseRequested = false;
  private workersReleased = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    maxAnisotropy: number,
    transcoderPath = '/basis/',
  ) {
    this.maxAnisotropy = maxAnisotropy;
    this.loader = new KTX2Loader()
      .setTranscoderPath(transcoderPath)
      .detectSupport(renderer);
  }

  /**
   * Load a `.ktx2` texture. `colorSpace` is applied explicitly (sRGB for colour maps,
   * linear for data maps) — deterministic regardless of the container's transfer fn.
   * Failures are logged and swallowed: the caller keeps its 1×1 placeholder uniform.
   */
  load(
    path: string,
    colorSpace: THREE.ColorSpace,
    onLoad: (tex: THREE.Texture) => void,
  ): void {
    // Loads can be deferred (see EarthRenderer's gate); a load after dispose() would
    // spin up a fresh transcoder worker pool nobody frees.
    if (this.disposed) return;
    this.pending++;
    this.loader.load(
      path,
      (tex) => {
        this.pending--;
        // A transcode can finish after dispose() (async). Don't touch disposed uniforms
        // or leak the late texture — free it immediately and skip the callback.
        if (this.disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = colorSpace;
        tex.anisotropy = this.maxAnisotropy;
        tex.needsUpdate = true;
        this.loaded.push(tex);
        onLoad(tex);
        this.maybeReleaseWorkers();
      },
      undefined,
      (err) => {
        this.pending--;
        console.error(`[KtxTextureLoader] failed to load ${path}`, err);
        this.maybeReleaseWorkers();
      },
    );
  }

  /**
   * Terminate the transcoder worker pool once all in-flight loads finish — frees the
   * worker threads + Basis WASM. The already-loaded textures stay valid (three's
   * `KTX2Loader.dispose()` only tears down the pool, not the textures). Call this after
   * kicking off all loads for a one-shot texture set (e.g. the Earth maps).
   */
  releaseWorkersWhenIdle(): void {
    this.releaseRequested = true;
    this.maybeReleaseWorkers();
  }

  private maybeReleaseWorkers(): void {
    if (this.releaseRequested && !this.workersReleased && !this.disposed && this.pending === 0) {
      this.loader.dispose();
      this.workersReleased = true;
    }
  }

  /** Disposes every loaded texture AND the loader's transcoder worker pool. Any
   *  in-flight load that resolves after this is freed in the load callback (see above). */
  dispose(): void {
    this.disposed = true;
    for (const tex of this.loaded) tex.dispose();
    this.loaded.length = 0;
    if (!this.workersReleased) this.loader.dispose();
  }
}
