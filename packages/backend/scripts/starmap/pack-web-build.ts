// SPIKE — not production. Bundles the pack page (pack-web/) into packages/backend/data/pack/web/ with esbuild.
// Usage: npx tsx packages/backend/scripts/starmap/pack-web-build.ts
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./pack-web/', import.meta.url));
const out = fileURLToPath(new URL('../../data/pack/web/', import.meta.url));
mkdirSync(out, { recursive: true });
const t = Date.now();
await build({
  entryPoints: { app: here + 'app.ts', 'pack.worker': here + 'pack.worker.ts' },
  outdir: out, bundle: true, format: 'iife', target: 'es2022', platform: 'browser', sourcemap: false, minify: false, logLevel: 'warning',
});
for (const f of ['index.html', 'sw.js']) copyFileSync(here + f, out + f);
console.log(`pack page built -> ${out} (${Date.now() - t} ms)`);
