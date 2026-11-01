// ============================================================
// Ground regions for the pass queries: named polygons (ported from the spike's events.ts REGIONS and coverage-lib INDIA_POLY) and
// arbitrary circles. "Passed over" means: the sub-satellite point (GEODETIC latitude, longitude) of the object, at any height inside
// the star map's radial range, is inside the region — exactly the spike's definition (coverage-worker.ts flagsFn).
//
// Only India is a careful outline. The others are rough ("approximate": true in the metadata) — good enough for a fixed test of the
// machinery, not a border survey. Polygons are plain lat/lon and must not cross the antimeridian. Circles are great-circle
// distance (sphere, R = 6371 km) from the centre; they may cross the antimeridian, and must not contain or come near a pole.
// ============================================================
import { DEG } from '@orbitwatch/orbital-core';

export type LatLon = [lat: number, lon: number];

export interface PolygonRegion { kind: 'polygon'; id: string; name: string; approximate: boolean; poly: LatLon[] }
export interface CircleRegion { kind: 'circle'; id: string; name: string; approximate: false; latDeg: number; lonDeg: number; radiusKm: number }
export type Region = PolygonRegion | CircleRegion;

export const EARTH_R_KM = 6371;
export const KM_PER_DEG = (Math.PI / 180) * EARTH_R_KM;

/** India outline: identical to the spike's Layer 2 polygon (so answers can be cross-checked). */
export const INDIA_POLY: LatLon[] = [
  [8.0, 77.5], [12.0, 75.0], [20.0, 72.8], [22.5, 68.5], [24.5, 71.0], [28.0, 70.0], [32.5, 74.5],
  [35.5, 77.5], [34.5, 79.5], [30.5, 81.0], [28.5, 88.0], [27.0, 92.0], [28.5, 97.0], [23.5, 93.0],
  [21.5, 89.0], [19.5, 85.0], [13.0, 80.3], [10.0, 79.8],
];

const poly = (id: string, name: string, approximate: boolean, p: LatLon[]): PolygonRegion => ({ kind: 'polygon', id, name, approximate, poly: p });

/** Named regions. Order and outlines as the spike's REGIONS (the Bangalore circle is not named: use a circle query). */
export const REGIONS: readonly PolygonRegion[] = [
  poly('india', 'India', false, INDIA_POLY),
  poly('usa_conus', 'Contiguous United States', true, [[49, -125], [49, -95], [49, -89], [46.5, -84.5], [47.5, -69], [45, -67], [41.5, -70], [35, -75.5], [30.5, -81], [25, -80], [25.5, -97.4], [29, -103], [31.3, -106.5], [32.5, -117], [34.5, -120.6], [40.3, -124.4]]),
  poly('europe', 'Europe', true, [[36, -10], [36, 26], [41, 45], [70, 45], [70, -10]]),
  poly('china', 'China', true, [[18, 108], [21.5, 101], [22, 98], [28, 97.5], [28.5, 88], [31, 79], [36, 74], [40, 74.5], [45, 80], [49, 87.5], [47.5, 90], [49, 116], [53.5, 123], [48, 135], [43, 131], [42, 128], [39.5, 124], [34, 121], [30, 122], [25, 119.5], [21.5, 111]]),
  poly('brazil', 'Brazil', true, [[5, -60], [2, -50], [-5, -35], [-8, -34.8], [-23, -41], [-26, -48.5], [-33.7, -53.4], [-30, -57.6], [-22, -57.9], [-17, -58], [-10, -65], [-10, -73], [-4, -70], [2, -69.5]]),
  poly('australia', 'Australia', true, [[-10.7, 142], [-12, 136.5], [-11.5, 131], [-14.5, 125], [-22, 113.5], [-34.5, 115], [-35, 118], [-32, 128], [-33.8, 134], [-38, 140], [-38.5, 146], [-37.5, 150], [-28, 153.6], [-24, 151.5], [-16, 145.5]]),
  poly('japan', 'Japan', true, [[31, 129.5], [33.5, 129], [35.5, 133], [37.5, 136.5], [41, 139.5], [45.5, 141.5], [43, 145.8], [41.5, 142], [35.5, 141], [34.5, 138.5], [33.5, 135.5], [31, 131]]),
];

/** Accepted spellings of the named regions (lower-case, spaces / hyphens as underscores). */
const ALIASES: Record<string, string> = { usa: 'usa_conus', us: 'usa_conus', conus: 'usa_conus', united_states: 'usa_conus', america: 'usa_conus', eu: 'europe', prc: 'china' };

export function namedRegion(name: string): PolygonRegion | null {
  const k = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const id = ALIASES[k] ?? k;
  return REGIONS.find((r) => r.id === id) ?? null;
}

export const MIN_CIRCLE_KM = 5;
export const MAX_CIRCLE_KM = 3000;
/** A circle (with the cover's padding) must stay this far from the poles: the lat/lon cover plane degenerates there. */
export const MAX_CIRCLE_LAT_REACH_DEG = 85;

export function circleRegion(latDeg: number, lonDeg: number, radiusKm: number): CircleRegion {
  if (![latDeg, lonDeg, radiusKm].every(Number.isFinite)) throw new RangeError('circle: lat, lon and radius must be numbers');
  if (latDeg < -90 || latDeg > 90 || lonDeg < -180 || lonDeg > 180) throw new RangeError('circle: lat must be in -90..90 and lon in -180..180');
  if (radiusKm < MIN_CIRCLE_KM || radiusKm > MAX_CIRCLE_KM) throw new RangeError(`circle: radius must be ${MIN_CIRCLE_KM}..${MAX_CIRCLE_KM} km`);
  if (Math.abs(latDeg) + radiusKm / KM_PER_DEG > MAX_CIRCLE_LAT_REACH_DEG) throw new RangeError(`circle: too close to a pole (it must stay within ${MAX_CIRCLE_LAT_REACH_DEG} degrees of latitude)`);
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const la = r4(latDeg), lo = r4(lonDeg), rk = Math.round(radiusKm * 1e3) / 1e3;
  return { kind: 'circle', id: `circle:${la},${lo},${rk}`, name: `${rk} km around ${la}, ${lo}`, approximate: false, latDeg: la, lonDeg: lo, radiusKm: rk };
}

/** Region from a query: a name, or {latDeg, lonDeg, radiusKm}. Throws RangeError with a user-facing message. */
export function resolveRegion(spec: string | { latDeg: number; lonDeg: number; radiusKm: number }): Region {
  if (typeof spec === 'string') {
    const r = namedRegion(spec);
    if (!r) throw new RangeError(`unknown region '${spec}' (known: ${REGIONS.map((x) => x.id).join(', ')})`);
    return r;
  }
  return circleRegion(spec.latDeg, spec.lonDeg, spec.radiusKm);
}

// ---------------- geometry ----------------
/** Even-odd point-in-polygon on plain lat/lon. */
export function inPoly(lat: number, lon: number, p: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [yi, xi] = p[i]!, [yj, xj] = p[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance (degrees, plain lat/lon plane) from a point to the nearest polygon edge. */
export function distToPolyEdges(lat: number, lon: number, p: LatLon[]): number {
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const [y0, x0] = p[i]!, [y1, x1] = p[(i + 1) % p.length]!;
    const dx = x1 - x0, dy = y1 - y0;
    const t = Math.max(0, Math.min(1, ((lon - x0) * dx + (lat - y0) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(lon - (x0 + t * dx), lat - (y0 + t * dy)));
  }
  return best;
}

/** Great-circle distance in km (sphere) between two lat/lon points in degrees. */
export function havKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** THE definition of "over the region": the sub-satellite point (geodetic lat, lon) inside the polygon / circle. */
export function contains(r: Region, latDeg: number, lonDeg: number): boolean {
  return r.kind === 'polygon' ? inPoly(latDeg, lonDeg, r.poly) : havKm(latDeg, lonDeg, r.latDeg, r.lonDeg) <= r.radiusKm;
}

/** Margin (deg of arc, ~333 km) around the region inside which a sample counts as "near": a 20 s step moves the point at most ~200 km. */
export const NEAR_DEG = 3;

/** True if (lat, lon) is within NEAR_DEG of the region (polygon: its lat/lon bounding box, as the spike; circle: great-circle distance). */
export function isNear(r: Region, latDeg: number, lonDeg: number): boolean {
  if (r.kind === 'circle') return havKm(latDeg, lonDeg, r.latDeg, r.lonDeg) <= r.radiusKm + NEAR_DEG * KM_PER_DEG;
  const b = polyBounds(r);
  return latDeg >= b.latMin - NEAR_DEG && latDeg <= b.latMax + NEAR_DEG && lonDeg >= b.lonMin - NEAR_DEG && lonDeg <= b.lonMax + NEAR_DEG;
}

const boundsCache = new Map<string, { latMin: number; latMax: number; lonMin: number; lonMax: number }>();
export function polyBounds(r: PolygonRegion): { latMin: number; latMax: number; lonMin: number; lonMax: number } {
  let b = boundsCache.get(r.id);
  if (!b) {
    b = { latMin: Math.min(...r.poly.map((v) => v[0])), latMax: Math.max(...r.poly.map((v) => v[0])), lonMin: Math.min(...r.poly.map((v) => v[1])), lonMax: Math.max(...r.poly.map((v) => v[1])) };
    boundsCache.set(r.id, b);
  }
  return b;
}

export { DEG };
