// ============================================================
// SPIKE — not production. Browser pack (P5): headless Chromium test (Playwright).
//
// Needs the pack server running (pack-serve.ts --latest <dir>) and the page built (pack-web-build.ts).
// Playwright is not a repo dependency: it is loaded from the machine's global tools (/opt/node-tools).
//
//   npx tsx packages/backend/scripts/starmap/pack-browser-test.ts --base http://127.0.0.1:8123 --label main
//   ... --mode delta --from <packA dir name> --delta <delta dir name>   (install old pack, apply daily delta)
//
// main mode, session 1: fresh profile -> download pack into OPFS -> open -> queries -> SGP4 speed -> integrity.
//       session 2: NEW browser process, same profile, network OFF -> page from the service worker, pack from OPFS -> same queries.
// Results: packages/backend/data/pack/browser-<label>.json (compare with pack-verify.ts).
// ============================================================
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './catalog.js';

const args = parseArgs(process.argv.slice(2));
const BASE = args.get('base') ?? 'http://127.0.0.1:8123';
const LABEL = args.get('label') ?? 'main';
const MODE = args.get('mode') ?? 'main';
const REPS = Number(args.get('reps') ?? 5);
const PACKDIR = fileURLToPath(new URL('../../data/pack/', import.meta.url));
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0); // fixed "now" so Node can compute the same answer
const BOX = { day: args.get('day') ?? '2026-10-12', order: 3, cell: 9138 };

const require = createRequire('/opt/node-tools/node_modules/');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = require('playwright') as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;
const call = (page: Page, op: string, a: Record<string, unknown> = {}): Promise<{ r: any; wall: number }> =>
  page.evaluate(async ({ op, a }: { op: string; a: Record<string, unknown> }) => {
    const t = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (window as any).packApp.call(op, a);
    return { r, wall: performance.now() - t };
  }, { op, a });

async function launch(profile: string): Promise<{ ctx: any; page: Page; version: string }> {
  const opts = { headless: true, args: ['--no-sandbox'] } as Record<string, unknown>;
  let ctx;
  try { ctx = await chromium.launchPersistentContext(profile, opts); }
  catch (e) {
    console.log('default chromium launch failed (' + String(e).split('\n')[0] + '); retrying with /opt/pw-browsers/chromium');
    ctx = await chromium.launchPersistentContext(profile, { ...opts, executablePath: '/opt/pw-browsers/chromium' });
  }
  const page = await ctx.newPage();
  return { ctx, page, version: ctx.browser()?.version?.() ?? '' };
}

async function questions(page: Page, withBench: boolean): Promise<Record<string, any>> {
  const q: Record<string, any> = {};
  const runs = async (name: string, op: string, a: Record<string, unknown>, n = REPS): Promise<void> => {
    const rs: Array<{ ms: number; wall: number }> = []; let last: any;
    for (let i = 0; i < n; i++) { const { r, wall } = await call(page, op, a); rs.push({ ms: r.ms, wall }); last = r; }
    q[name] = { runs: rs, result: last };
  };
  await runs('india', 'india', { tMs: T0 });
  await runs('iss', 'iss', { tMs: T0, hours: 24, stepS: 10 });
  await runs('box', 'box', { day: BOX.day, order: BOX.order, cell: BOX.cell });
  await runs('boxAll', 'boxAll', { order: BOX.order, cell: BOX.cell }, 2);
  if (withBench) await runs('dayCatalog', 'dayCatalog', { day: BOX.day }, 1);
  return q;
}

async function main(): Promise<void> {
  const res: Record<string, any> = { meta: { label: LABEL, mode: MODE, base: BASE, tMs: T0, boxDay: BOX.day, boxOrder: BOX.order, boxCell: BOX.cell, startedAt: new Date().toISOString() } };
  const profile = mkdtempSync(tmpdir() + '/packprofile-');
  const url = (m: string): string => `${BASE}/?manifest=${encodeURIComponent(m)}`;
  const reset = async (): Promise<void> => { await (await fetch(BASE + '/__log/reset')).text(); };
  const packRequests = async (): Promise<Array<{ url: string; bytes: number }>> => (await fetch(BASE + '/__log')).json() as Promise<Array<{ url: string; bytes: number }>>;

  if (MODE === 'main') {
    // ---------- session 1: first load ----------
    const m = '/pack/latest/manifest.json';
    let s = await launch(profile);
    res.meta.userAgent = await s.page.evaluate(() => navigator.userAgent);
    await reset();
    let t = Date.now();
    await s.page.goto(url(m));
    await s.page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    res.pageLoadMs = Date.now() - t;
    t = Date.now();
    const inst = await call(s.page, 'install', { manifestUrl: m });
    res.install = { ...inst.r, wallMs: Date.now() - t, pageWallMs: inst.wall };
    res.install.serverRequests = (await packRequests()).length;
    res.install.persist = await s.page.evaluate(() => navigator.storage.persist());
    res.install.estimate = await s.page.evaluate(() => navigator.storage.estimate());
    const op1 = await call(s.page, 'open');
    res.open1 = { ...op1.r, wall: op1.wall };
    res.queries = await questions(s.page, true);
    const b = await call(s.page, 'bench', { minMs: 3000 });
    res.bench = b.r;
    res.integrity = (await call(s.page, 'integrity')).r;
    res.heap = await s.page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? null);
    // reopen inside the same session (worker state dropped by a fresh page) for a "warm" number
    await s.ctx.close();

    // ---------- session 2: new browser process, same profile, network OFF ----------
    s = await launch(profile);
    await s.ctx.setOffline(true);
    await reset();
    t = Date.now();
    await s.page.goto(url(m));
    res.reload = { pageLoadMs: Date.now() - t };
    const sw = await s.page.evaluate(() => !!navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true));
    res.reload.serviceWorkerOk = !!sw;
    const op2 = await call(s.page, 'open');
    res.reload.open = { ...op2.r, wall: op2.wall };
    res.reload.timeToReadyMs = Date.now() - t;
    res.reload.queries = await questions(s.page, true);
    res.reload.packRequests = (await packRequests()).length;
    res.reload.offlineFetchFails = await s.page.evaluate(() => fetch('/pack/latest/manifest.json').then(() => false, () => true));
    await s.ctx.close();
  } else {
    // ---------- delta mode: install old pack, apply daily delta ----------
    const from = args.get('from')!, delta = args.get('delta')!;
    const s = await launch(profile);
    await reset();
    await s.page.goto(url(`/pack/${from}/manifest.json`));
    await s.page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    const i1 = await call(s.page, 'install', { manifestUrl: `/pack/${from}/manifest.json` });
    res.installOld = i1.r;
    res.open0 = (await call(s.page, 'open')).r;
    await reset();
    const t = Date.now();
    const up = await call(s.page, 'update', { deltaBase: `/pack/${delta}/` });
    res.update = { ...up.r, wallMs: Date.now() - t, serverRequests: (await packRequests()).length };
    res.open1 = (await call(s.page, 'open')).r;
    res.integrity = (await call(s.page, 'integrity')).r;
    res.meta.liveFile = PACKDIR + '../history/catalog-2026-10-18.json';
    res.meta.boxDay = '2026-10-18';
    BOX.day = '2026-10-18';
    res.queries = await questions(s.page, true);
    await s.ctx.close();
  }
  rmSync(profile, { recursive: true, force: true });
  const outPath = PACKDIR + `browser-${LABEL}.json`;
  writeFileSync(outPath, JSON.stringify(res));
  console.log('wrote', outPath, existsSync(outPath));
  const f = (x: any): string => JSON.stringify(x);
  if (MODE === 'main') {
    console.log('install', f({ ...res.install, estimate: undefined }), '\nstorage', f(res.install.estimate));
    console.log('open (from OPFS, online session)', f(res.open1));
    console.log('reload offline', f({ ...res.reload, queries: undefined }));
  } else console.log('update', f(res.update), '\nopen after', f(res.open1), '\nintegrity', f(res.integrity));
}
main().catch((e) => { console.error(e); process.exit(1); });
