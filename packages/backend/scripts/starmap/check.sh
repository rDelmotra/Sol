#!/usr/bin/env bash
# SPIKE — not production. The gate every star-map step must pass before committing.
# Run from the repo root: bash packages/backend/scripts/starmap/check.sh
set -euo pipefail
npm run build:libs >/dev/null
npx tsc -p packages/orbital-core/tsconfig.test.json
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck \
  packages/backend/scripts/starmap/*.ts
npx tsx --test packages/orbital-core/src/*.test.ts packages/backend/scripts/starmap/*.test.ts
npx tsx --test tests/architecture.test.ts tests/state.test.ts
echo "starmap check: OK"
