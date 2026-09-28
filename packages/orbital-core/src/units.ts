// ============================================================
// Units — the ONE home for unit constants.
//
// ER_KM is the scene/wire LENGTH UNIT: "1 ER" in worker buffers, the WASM
// output, DSO CanonicalStateVector ('earth_radii') and the render scene.
// It is a unit, not a claim about the Earth's shape — it stays 6371 forever.
// The Earth's physical figure (spherical today, WGS84 in phase 3) lives in
// earth.ts as a separate constant, even though today both equal 6371.
// ============================================================

/** Kilometres per scene/wire unit (1 ER). A unit — never changes. */
export const ER_KM = 6371;

export const MINUTES_PER_DAY = 1440;
export const MS_PER_DAY = 86_400_000;
