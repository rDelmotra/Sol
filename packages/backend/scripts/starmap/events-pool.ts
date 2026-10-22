// SPIKE — not production. Tiny worker pool for the events workers (<= 5 threads by order of the lead).
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export interface InitMsg { type: 'init'; omm: Array<Record<string, unknown>>; group: Int32Array }

export class EvPool {
  private workers: Worker[] = [];
  private waiting = new Map<number, (v: unknown) => void>();
  private seq = 0;
  constructor(readonly size = 5) {}
  async start(init: InitMsg): Promise<void> {
    const boot = fileURLToPath(new URL('./events-worker-boot.mjs', import.meta.url));
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(boot);
      w.on('message', (m: { id: number; out: unknown }) => { const r = this.waiting.get(m.id); this.waiting.delete(m.id); r?.(m.out); });
      w.on('error', (e) => { console.error('worker error', e); process.exit(1); });
      this.workers.push(w);
    }
    await Promise.all(this.workers.map((w) => this.send(w, init)));
  }
  private send(w: Worker, msg: unknown): Promise<unknown> {
    const id = this.seq++;
    return new Promise((res) => { this.waiting.set(id, res); w.postMessage({ id, msg }); });
  }
  async map<T>(tasks: unknown[]): Promise<T[]> {
    const out = new Array<T>(tasks.length);
    let next = 0;
    await Promise.all(this.workers.map(async (w) => {
      for (;;) {
        const k = next++;
        if (k >= tasks.length) return;
        out[k] = (await this.send(w, tasks[k])) as T;
      }
    }));
    return out;
  }
  async close(): Promise<void> { await Promise.all(this.workers.map((w) => w.terminate())); }
}
