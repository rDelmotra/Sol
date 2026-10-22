// SPIKE — not production. Worker bootstrap for the coverage workers (same pattern as worker-boot.mjs).
import { register } from 'tsx/esm/api';
register();
await import('./coverage-worker.ts');
