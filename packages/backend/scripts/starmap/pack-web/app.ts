// SPIKE — not production. Browser pack (P5) page: a thin driver around pack.worker.js. Buttons call the worker and print
// the JSON replies; window.packApp.call(op, args) is what the Playwright test uses.
const worker = new Worker('pack.worker.js');
let seq = 0;
const waiting = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
  const w = waiting.get(e.data.id);
  if (!w) return;
  waiting.delete(e.data.id);
  if (e.data.ok) w.ok(e.data.result); else w.err(new Error(e.data.error));
};
function call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((ok, err) => { const id = ++seq; waiting.set(id, { ok, err }); worker.postMessage({ id, op, args }); });
}

const params = new URLSearchParams(location.search);
const manifestUrl = params.get('manifest') ?? '/pack/latest/manifest.json';
const out = document.getElementById('out')!;
const log = (label: string, v: unknown): void => {
  const s = JSON.stringify(v, (_k, x) => (Array.isArray(x) && x.length > 40 ? `[${x.length} items]` : x), 1);
  out.textContent = `${label}\n${s}\n\n` + out.textContent;
};
function wire(id: string, label: string, fn: () => Promise<unknown>): void {
  document.getElementById(id)!.addEventListener('click', () => { fn().then((v) => log(label, v), (e) => log(label + ' FAILED', String(e))); });
}
const T0 = (): number => Date.now();
wire('b-install', 'install', () => call('install', { manifestUrl }));
wire('b-open', 'open', () => call('open'));
wire('b-india', 'who is over India now', () => call('india', { tMs: T0() }));
wire('b-iss', 'ISS next 24 h at 10 s', () => call('iss', { tMs: T0(), hours: 24, stepS: 10 }));
wire('b-box', 'box 9138 (order 3), latest pack day', async () => { const i = (await call('info')) as { window: { to: string } }; return call('box', { day: i.window.to, order: 3, cell: 9138 }); });
wire('b-bench', 'SGP4 speed', () => call('bench', { minMs: 2000 }));
wire('b-clear', 'clear OPFS', () => call('clear'));

(window as unknown as { packApp: unknown }).packApp = { call, manifestUrl };

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => { document.getElementById('sw')!.textContent = 'offline shell: ready'; }, (e) => { document.getElementById('sw')!.textContent = 'service worker failed: ' + e; });
}
