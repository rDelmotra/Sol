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

/** Degrees per radian (multiply a radian value by this to get degrees). */
export const DEG = 180 / Math.PI;

/** Radians per degree (multiply a degree value by this to get radians). */
export const RAD = Math.PI / 180;

/** Earth's standard gravitational parameter, km^3/s^2 (used for semi-major-axis derivation). */
export const MU_KM3_S2 = 398600.4418;
