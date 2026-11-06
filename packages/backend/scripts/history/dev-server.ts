// Dev server for the history API: the real express app (createApp) WITHOUT the boot tasks (no TLE download, no cron, no workers), reading the
// history root in SSA_HISTORY_DIR (or --dir). The database is only needed for /api/history/timeline, /api/ssa/events and the pass names:
//
//   SSA_HISTORY_DIR=/path/to/sample DATABASE_URL=postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch npm run history:dev -w @orbitwatch/backend
//   (or)  npx tsx scripts/history/dev-server.ts --dir /path/to/sample [--port 3001]
//
// DATABASE_URL defaults to the local docker container's (orbitwatch-pg) when unset. The /api rate limit (100 requests / 15 min / IP) applies
// as in production: replay clients should rely on the long Cache-Control of /api/history/catalog.
import 'dotenv/config';
import { existsSync } from 'node:fs';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };

const dir = arg('dir') ?? process.env.SSA_HISTORY_DIR;
if (dir) process.env.SSA_HISTORY_DIR = dir;
const explicit = process.env.SSA_HISTORY_ELSETS_DIR || process.env.SSA_HISTORY_COVERAGE_DIR;
if ((!dir || !existsSync(dir)) && !explicit) { console.error('SSA_HISTORY_DIR (or --dir) must name an existing history root (elsets/, objects.jsonl.gz, coverage/, events/), or set SSA_HISTORY_ELSETS_DIR / SSA_HISTORY_COVERAGE_DIR (lab layout)'); process.exit(1); }
process.env.DATABASE_URL ||= 'postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch';
const port = Number(arg('port') ?? process.env.PORT ?? 3001);

// the modules below read DATABASE_URL when they are first loaded: import them after the defaults are set
const { createApp } = await import('../../src/app.js');
const { initHistory } = await import('../../src/history/index.js');
const { logger } = await import('../../src/utils/logger.js');
const app = createApp();
app.listen(port, async () => {
  logger.info(`history dev server on http://localhost:${port}  (SSA_HISTORY_DIR=${dir})`);
  try { await initHistory(); } catch (err) { logger.warn(`database not ready (timeline / events / pass names will 503): ${(err as Error).message}`); }
});
