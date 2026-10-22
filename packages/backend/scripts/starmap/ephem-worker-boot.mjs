// SPIKE — not production. Worker bootstrap: register tsx's loader, then load build-ephem's worker half.
import { register } from 'tsx/esm/api';
register();
await import('./build-ephem.ts');
