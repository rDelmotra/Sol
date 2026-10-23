// SPIKE — not production. Worker bootstrap for the planner's workers (same pattern as coverage-worker-boot.mjs).
import { register } from 'tsx/esm/api';
register();
await import('./ask-worker.ts');
