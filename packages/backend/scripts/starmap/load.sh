#!/usr/bin/env bash
# SPIKE — not production. Apply schema.sql then COPY a build-index.ts CSV into starmap.track_run
# of the LOCAL docker TimescaleDB.   usage: load.sh file.csv [table]
set -euo pipefail
CSV="${1:?csv path}"; TABLE="${2:-starmap.track_run}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# STARMAP_DB set → plain psql (cloud, no Docker); unset → psql inside the local docker container.
if [ -n "${STARMAP_DB:-}" ]; then PSQL=(psql "$STARMAP_DB" -v ON_ERROR_STOP=1)
else PSQL=(docker exec -i orbitwatch-timescaledb psql -v ON_ERROR_STOP=1 -U orbitwatch -d orbitwatch); fi
"${PSQL[@]}" -q < "$HERE/schema.sql"
if [ "$TABLE" != "starmap.track_run" ]; then
  "${PSQL[@]}" -q -c "CREATE TABLE IF NOT EXISTS $TABLE (LIKE starmap.track_run INCLUDING DEFAULTS)" \
    -c "SELECT create_hypertable('$TABLE','bucket',chunk_time_interval=>INTERVAL '1 day',create_default_indexes=>false,if_not_exists=>true)" \
    -c "CREATE INDEX IF NOT EXISTS ${TABLE//./_}_cb ON $TABLE (cell, bucket)" \
    -c "CREATE INDEX IF NOT EXISTS ${TABLE//./_}_nt ON $TABLE (norad_id, t_in)"
fi
START=$(date +%s)
"${PSQL[@]}" -c "\copy $TABLE (bucket,cell,ord,norad_id,t_in,t_out,elset_epoch) from stdin with csv header" < "$CSV"
echo "load seconds: $(( $(date +%s) - START ))"
"${PSQL[@]}" -At -c "SELECT count(*) FROM $TABLE"
