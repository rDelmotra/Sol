// Small worker_threads pool for the screener. Resolves the worker next to this module: compiled (dist/ssa/worker.js) it starts
// directly; from TypeScript sources (tsx) it goes through worker-boot.mjs, which registers tsx inside the thread first.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export class WorkerPool {
  private workers: Worker[] = [];
  private waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private seq = 0;
  private failure: Error | null = null;
  constructor(readonly size: number) {}

  async start(init: unknown): Promise<void> {
    const isTs = fileURLToPath(import.meta.url).endsWith('.ts');
    const worker = new URL(isTs ? './worker.ts' : './worker.js', import.meta.url);
    for (let i = 0; i < this.size; i++) {
      const w = isTs
        ? new Worker(new URL('./worker-boot.mjs', import.meta.url), { workerData: { file: worker.href } })
        : new Worker(worker);
      w.on('message', (m: { id: number; out: unknown }) => {
        const r = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        r?.res(m.out);
      });
      w.on('error', (e) => this.fail(e instanceof Error ? e : new Error(String(e))));
      w.on('exit', (code) => { if (code !== 0 && !this.closing) this.fail(new Error(`screener worker exited with code ${code}`)); });
      this.workers.push(w);
    }
    await this.broadcast(init);
  }
  private closing = false;
  private fail(e: Error): void {
    this.failure ??= e;
    for (const [, r] of this.waiting) r.rej(e);
    this.waiting.clear();
  }
  private send(w: Worker, msg: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.seq++;
    return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); w.postMessage({ id, msg }); });
  }
  /** Run tasks over the workers, results in task order. */
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
    const r = await this.broadcast({ type: 'calls' });
    return (r as number[]).reduce((a, b) => a + b, 0);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
