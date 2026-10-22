#!/usr/bin/env bash
# SPIKE — not production. One-shot setup of a fresh machine for the star-map spike.
# Run from the repo root: bash packages/backend/scripts/starmap/setup-env.sh
set -euo pipefail
node --version
npm install --no-audit --no-fund
npm run build:libs
bash packages/backend/scripts/starmap/fetch-data.sh
mkdir -p /tmp/starmap
echo "cores: $(node -e 'console.log(require("os").availableParallelism())')  ram GB: $(node -e 'console.log((require("os").totalmem()/2**30).toFixed(1))')"
echo "Next: bash packages/backend/scripts/starmap/setup-db.sh  (only needed for DB tasks)"
