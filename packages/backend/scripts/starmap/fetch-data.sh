#!/usr/bin/env bash
# SPIKE — not production. Fetch the data the star-map spike needs into the gitignored
# packages/backend/data/ folder, using only the live app's PUBLIC read endpoints (the same
# requests the browser makes). Nothing on Railway or in its database is changed.
#
#   usage: fetch-data.sh [base_url]     (default https://orbitwatch.up.railway.app)
#
# Writes:
#   packages/backend/data/tle-cache.json                      live catalog (plain array)
#   packages/backend/data/history/catalog-YYYY-MM-DD.json     catalog as of each day (plain array)
# Days: weekly 2026-06-23..2026-09-15 (history before ~2026-06-23 is near-empty), then daily
# 2026-09-20..2026-10-18. One request per day, 1 s apart.
set -euo pipefail
BASE="${1:-https://orbitwatch.up.railway.app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HERE/../../data"
mkdir -p "$DATA/history"

unwrap() { # stdin JSON envelope {data:[...]} or plain array -> plain array file $1
  node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:j.data;require('fs').writeFileSync(process.argv[1],JSON.stringify(a));console.log(process.argv[1].split('/').pop(),a.length)})" "$1"
}

if [ ! -s "$DATA/tle-cache.json" ]; then
  curl -sf --compressed "$BASE/api/tle/all" | unwrap "$DATA/tle-cache.json"
fi

days=$(node -e "
const out=[];const add=(d)=>out.push(d.toISOString().slice(0,10));
for(let d=new Date('2026-06-23');d<new Date('2026-09-20');d.setUTCDate(d.getUTCDate()+7))add(new Date(d));
for(let d=new Date('2026-09-20');d<=new Date('2026-10-18');d.setUTCDate(d.getUTCDate()+1))add(new Date(d));
console.log(out.join(' '))")
for D in $days; do
  f="$DATA/history/catalog-$D.json"
  [ -s "$f" ] && continue
  curl -sf --compressed "$BASE/api/history/at?t=${D}T12:00:00Z" | unwrap "$f" || echo "$D FAILED"
  sleep 1
done
du -sh "$DATA/history"
