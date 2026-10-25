// SPIKE — not production. Tiny worker pool for the events workers (<= 5 threads by order of the lead).
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export interface InitMsg { type: 'init'; omm: Array<Record<string, unknown>>; group: Int32Array; [k: string]: unknown }

export class EvPool {
  private workers: Worker[] = [];
  private waiting = new Map<number, (v: unknown) => void>();
  private seq = 0;
  constructor(readonly size = 5, private readonly bootFile = './events-worker-boot.mjs') {}
  async start(init: InitMsg): Promise<void> {
    const boot = fileURLToPath(new URL(this.bootFile, import.meta.url));
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
  /** Send the same message to every worker and wait for all of them. */
  async broadcast(msg: unknown): Promise<unknown[]> { return Promise.all(this.workers.map((w) => this.send(w, msg))); }
  /** Sum of the SGP4 calls every worker made since the last call (each worker resets its counter). */
  async calls(): Promise<number> {
    const r = await Promise.all(this.workers.map((w) => this.send(w, { type: 'calls' })));
    return (r as number[]).reduce((a, b) => a + b, 0);
  }
  async close(): Promise<void> { await Promise.all(this.workers.map((w) => w.terminate())); }
}
