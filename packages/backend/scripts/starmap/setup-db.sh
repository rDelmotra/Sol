#!/usr/bin/env bash
# SPIKE — not production. Get a Postgres 16 + TimescaleDB database for the star-map spike.
#
# Order of attempts:
#   1. STARMAP_DB already set and reachable → use it.
#   2. Docker available → run timescale/timescaledb-ha:pg16 as container orbitwatch-timescaledb.
#   3. Debian/Ubuntu with sudo/apt → install postgresql-16 + timescaledb-2-postgresql-16 from the
#      official Timescale apt repo, enable the extension, create user/db orbitwatch.
# Prints the export line to use at the end. Never touches any remote/production database.
set -euo pipefail
URL_DEFAULT="postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch"

reachable() { psql "$1" -Atc "select 1" >/dev/null 2>&1; }

if [ -n "${STARMAP_DB:-}" ] && command -v psql >/dev/null && reachable "$STARMAP_DB"; then
  echo "Using existing STARMAP_DB"; URL="$STARMAP_DB"
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}' | grep -qx orbitwatch-timescaledb || \
    docker run -d --name orbitwatch-timescaledb -e POSTGRES_USER=orbitwatch -e POSTGRES_PASSWORD=orbitwatch \
      -e POSTGRES_DB=orbitwatch -p 5432:5432 timescale/timescaledb-ha:pg16
  docker start orbitwatch-timescaledb >/dev/null
  for _ in $(seq 1 60); do docker exec orbitwatch-timescaledb pg_isready -U orbitwatch -d orbitwatch >/dev/null 2>&1 && break; sleep 2; done
  URL="$URL_DEFAULT"
  echo "Docker container orbitwatch-timescaledb is up. (Scripts also work without STARMAP_DB via docker exec.)"
elif command -v apt-get >/dev/null; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  $SUDO apt-get update -y
  $SUDO apt-get install -y gnupg curl lsb-release ca-certificates postgresql-common
  $SUDO /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y || true
  CODENAME="$(lsb_release -cs)"
  echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $CODENAME main" | $SUDO tee /etc/apt/sources.list.d/timescaledb.list
  curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | $SUDO gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/timescaledb.gpg
  $SUDO apt-get update -y
  $SUDO apt-get install -y postgresql-16 timescaledb-2-postgresql-16 postgresql-16-postgis-3 || \
    $SUDO apt-get install -y postgresql-16 timescaledb-2-postgresql-16
  CONF="$(ls /etc/postgresql/16/main/postgresql.conf)"
  grep -q "^shared_preload_libraries.*timescaledb" "$CONF" || echo "shared_preload_libraries = 'timescaledb'" | $SUDO tee -a "$CONF"
  ($SUDO service postgresql restart || $SUDO pg_ctlcluster 16 main restart)
  $SUDO -u postgres psql -v ON_ERROR_STOP=1 -c "DO \$\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='orbitwatch') THEN CREATE ROLE orbitwatch LOGIN SUPERUSER PASSWORD 'orbitwatch'; END IF; END\$\$;"
  $SUDO -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname='orbitwatch'" | grep -q 1 || $SUDO -u postgres createdb -O orbitwatch orbitwatch
  URL="$URL_DEFAULT"
else
  echo "No Docker and no apt-get: install Postgres 16 + TimescaleDB yourself, then export STARMAP_DB=<url>." >&2
  exit 1
fi

psql "$URL" -Atc "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT extversion FROM pg_extension WHERE extname='timescaledb';" 2>/dev/null \
  || docker exec orbitwatch-timescaledb psql -U orbitwatch -d orbitwatch -Atc "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT extversion FROM pg_extension WHERE extname='timescaledb';"
echo
echo "Run this in your shell before the spike scripts:"
echo "  export STARMAP_DB=$URL"
