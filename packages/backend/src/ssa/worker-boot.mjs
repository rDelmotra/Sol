// Worker bootstrap for TypeScript sources (tsx runs, i.e. tests and `npm run ssa:once`). Compiled runs (dist/*.js) do not use it.
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
await import(workerData.file);
