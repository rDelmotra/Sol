/**
 * Centralized simulation clock.
 *
 * Single source of truth for "what time is it in the simulation?"
 * At rate=1 with no jumps, simClock.now() === Date.now().
 *
 * Wall-clock (Date.now / performance.now) is still used for:
 *  - animation easing / frame deltas
 *  - cache freshness / TTL checks
 *  - hover throttling
 *
 * Only the Zustand store actions (setSimRate, jumpToSimTime, resetSimClock)
 * should call setRate / jumpTo / reset. UI code should never mutate this
 * directly.
 */
class SimClock {
  private _epoch = 0;
  private _simEpoch = 0;
  private _rate = 1;
  private _initialized = false;

  /** Lazy init — avoids time jump if module loads before Engine.start() */
  private ensureInitialized(): void {
    if (!this._initialized) {
      this._epoch = Date.now();
      this._simEpoch = this._epoch;
      this._initialized = true;
    }
  }

  /** Current simulation time in ms (like Date.now()) */
  now(): number {
    this.ensureInitialized();
    return this._simEpoch + (Date.now() - this._epoch) * this._rate;
  }

  /** Current simulation time as a Date */
  date(): Date {
    return new Date(this.now());
  }

  getRate(): number {
    return this._rate;
  }

  setRate(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.ensureInitialized();
    const currentSimTime = this.now();
    this._simEpoch = currentSimTime;
    this._epoch = Date.now();
    this._rate = rate;
  }

  jumpTo(date: Date): void {
    const ts = date.getTime();
    if (!Number.isFinite(ts)) return;
    this.ensureInitialized();
    this._simEpoch = ts;
    this._epoch = Date.now();
  }

  reset(): void {
    const wallNow = Date.now();
    this._epoch = wallNow;
    this._simEpoch = wallNow;
    this._rate = 1;
    this._initialized = true;
  }
}

export const simClock = new SimClock();
