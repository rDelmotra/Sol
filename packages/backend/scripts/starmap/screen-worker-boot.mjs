// SPIKE — not production. Worker bootstrap for the screening workers (same pattern as worker-boot.mjs).
import { register } from 'tsx/esm/api';
register();
await import('./screen-worker.ts');
