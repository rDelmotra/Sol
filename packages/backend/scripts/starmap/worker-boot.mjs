// SPIKE — not production. Worker bootstrap: register tsx's loader inside the worker
// thread (it does not inherit .js -> .ts resolution), then load the TypeScript worker.
import { register } from 'tsx/esm/api';
register();
await import('./build-index.ts');
