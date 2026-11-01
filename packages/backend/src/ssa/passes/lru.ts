/** Small least-recently-used map bounded by a total weight (entries pass their own weight, default 1). */
export class LruCache<K, V> {
  private m = new Map<K, { v: V; w: number }>();
  private total = 0;
  constructor(private readonly maxWeight: number) {}
  get(k: K): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    this.m.delete(k); this.m.set(k, e);
    return e.v;
  }
  set(k: K, v: V, w = 1): void {
    const old = this.m.get(k);
    if (old) { this.total -= old.w; this.m.delete(k); }
    this.m.set(k, { v, w });
    this.total += w;
    while (this.total > this.maxWeight && this.m.size > 1) {
      const first = this.m.keys().next().value as K;
      this.total -= this.m.get(first)!.w; this.m.delete(first);
    }
  }
  get size(): number { return this.m.size; }
  clear(): void { this.m.clear(); this.total = 0; }
}
