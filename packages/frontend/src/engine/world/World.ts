import type { FrameContext, Layer, LayerContext } from '../render/Layer';

/**
 * The engine-level layer registry.
 *
 * Owns the set of {@link Layer}s, drives their init/update/dispose, and isolates
 * failures: a non-critical layer that throws is logged once, marked failed, and
 * skipped on future frames so the rest of the scene keeps rendering; a CRITICAL
 * layer that throws escalates via `onCriticalError` (Engine wires this to
 * `store.setLoadingError`). Adding a visual system = `world.register(new XLayer())`.
 */
export class World {
  private readonly layers: Layer[] = [];
  private readonly initialized = new Set<Layer>();
  private readonly failed = new Set<Layer>();
  private readonly disposedLayers = new Set<Layer>();
  private readonly onCriticalError: (err: unknown) => void;
  private disposed = false;

  constructor(callbacks: { onCriticalError: (err: unknown) => void }) {
    this.onCriticalError = callbacks.onCriticalError;
  }

  register(layer: Layer): this {
    this.layers.push(layer);
    return this;
  }

  /**
   * Initialize all layers. **Synchronous** layers complete (and become
   * updatable) within this call, so the caller can rely on their products
   * immediately. Asynchronous layers init in the background and are marked
   * ready when they resolve — `update(frame)` skips them until then.
   */
  init(ctx: LayerContext): void {
    for (const layer of this.layers) {
      try {
        const result: unknown = layer.init(ctx);
        if (isThenable(result)) {
          result.then(
            () => {
              if (!this.disposed) this.initialized.add(layer);
            },
            (err: unknown) => {
              if (!this.disposed) this.handleFailure(layer, err, 'init');
            },
          );
        } else {
          this.initialized.add(layer);
        }
      } catch (err) {
        this.handleFailure(layer, err, 'init');
      }
    }
  }

  update(frame: FrameContext): void {
    for (const layer of this.layers) {
      // Skip layers whose (possibly async) init hasn't completed, and failed ones.
      if (!this.initialized.has(layer) || this.failed.has(layer)) continue;
      try {
        layer.update(frame);
      } catch (err) {
        this.handleFailure(layer, err, 'update');
      }
    }
  }

  /**
   * Run a direct (command-style) call on a layer with the SAME failure isolation
   * as `update()`: non-critical failures log + disable the layer; critical ones
   * escalate. Also guards against commands arriving before the layer's init has
   * resolved (returns + warns instead of silently dropping). Use this for any
   * layer method the Engine calls outside the `update(frame)` path.
   *
   * Returns true iff `fn` actually ran to completion — lets the caller gate
   * dependent work (e.g. only start DSO data polling if DSO activation ran).
   */
  runLayerCommand(layer: Layer, label: string, fn: () => void): boolean {
    if (this.failed.has(layer)) return false;
    if (!this.initialized.has(layer)) {
      console.warn(`[world] command "${label}" on "${layer.name}" before init — ignored`);
      return false;
    }
    try {
      fn();
      return true;
    } catch (err) {
      this.handleFailure(layer, err, `command:${label}`);
      return false;
    }
  }

  /**
   * Escalate a failure that surfaced OUTSIDE the init / update / runLayerCommand
   * paths — i.e. inside a layer's own async callback (a worker `onmessage` or a
   * store subscription), which runs on its own event-loop turn with no World
   * try/catch around it. Applies the SAME severity-aware handling: mark failed,
   * escalate critical via `onCriticalError`, dispose the layer once. A critical
   * layer (satellites) wires its worker/subscription callbacks to this so a
   * runtime throw becomes a user-visible error instead of vanishing.
   */
  reportLayerFailure(layer: Layer, err: unknown, phase: string): void {
    if (this.disposed || this.failed.has(layer)) return;
    this.handleFailure(layer, err, phase);
  }

  /** Placeholder for the future post-processing composer (reference 05). */
  getEffects(): object[] {
    return [];
  }

  dispose(): void {
    this.disposed = true;
    for (const layer of this.layers) {
      this.disposeLayerOnce(layer);
    }
    this.layers.length = 0;
    this.initialized.clear();
    this.failed.clear();
    this.disposedLayers.clear();
  }

  private handleFailure(layer: Layer, err: unknown, phase: string): void {
    this.failed.add(layer);
    if (layer.critical) {
      console.error(`[world] CRITICAL layer "${layer.name}" failed at ${phase}:`, err);
      this.onCriticalError(err);
    } else {
      console.warn(`[world] layer "${layer.name}" failed at ${phase} (continuing):`, err);
    }
    // A failed layer is dead (skipped forever) — free its resources now so a
    // soft-failed non-critical layer doesn't leak its worker/GL until full
    // Engine disposal. Idempotent via disposedLayers (dispose() runs once).
    this.disposeLayerOnce(layer);
  }

  /** Dispose a layer at most once (failure path + dispose() both call this). */
  private disposeLayerOnce(layer: Layer): void {
    if (this.disposedLayers.has(layer)) return;
    this.disposedLayers.add(layer);
    try {
      layer.dispose();
    } catch (err) {
      console.error(`[world] ${layer.name} dispose failed:`, err);
    }
  }
}

/** Detects any PromiseLike (Promise, or a generic thenable from an async init). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
