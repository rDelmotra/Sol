// ============================================================
// P3 S3 Part B — generates the client<->server astro golden fixture.
//
// Run manually (tsx): npx tsx scripts/gen-astro-golden.ts
// Writes packages/backend/src/analytic/astro-golden.json (committed).
// Regenerate ONLY when the canonical frontend math in
// src/orbital/{time,coordinates}.ts changes.
//
// Computes via the REAL client path — getSunDirection/getObserverScenePosition
// (equatorial -> scene) then the live-source scene->TEME inverse swap
// `(s.x, -s.z, s.y)` — exactly what packages/backend/src/analytic/astro.ts's
// server-side sunDirTeme/observerTeme must reproduce directly (no swap).
// ============================================================

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getGAST, getSunDirection } from '../src/orbital/time';
import { getObserverScenePosition } from '../src/orbital/coordinates';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../../backend/src/analytic/astro-golden.json');

const INSTANTS_ISO = [
  '2026-01-01T00:00:00Z',
  '2026-03-20T09:00:00Z', // near the 2026 March equinox
  '2026-06-21T00:00:00Z', // near the 2026 June solstice
  '2026-09-23T00:00:00Z', // near the 2026 September equinox
  '2026-12-21T00:00:00Z', // near the 2026 December solstice
];

const OBSERVERS = [
  { latDeg: 51.5074, lonDeg: -0.1278, altKm: 0 },       // London
  { latDeg: 0, lonDeg: 0, altKm: 0 },                    // equator / prime meridian
  { latDeg: -33.8688, lonDeg: 151.2093, altKm: 0.05 },   // Sydney, nonzero altitude
];

function sunTeme(date: Date) {
  const s = getSunDirection(date);
  return { x: s.x, y: -s.z, z: s.y };
}

function observerTeme(latDeg: number, lonDeg: number, altKm: number, date: Date) {
  const p = getObserverScenePosition(latDeg, lonDeg, altKm, date);
  return { x: p.x, y: -p.z, z: p.y };
}

const rows = INSTANTS_ISO.map((iso) => {
  const tMs = Date.parse(iso);
  const date = new Date(tMs);
  return {
    iso,
    tMs,
    gast: getGAST(date),
    sun: sunTeme(date),
    observers: OBSERVERS.map((o) => ({
      ...o,
      teme: observerTeme(o.latDeg, o.lonDeg, o.altKm, date),
    })),
  };
});

writeFileSync(OUT_PATH, JSON.stringify({ generatedFrom: 'gen-astro-golden.ts', rows }, null, 2) + '\n', 'utf8');
console.log(`Wrote ${rows.length} rows x ${OBSERVERS.length} observers to ${OUT_PATH}`);
