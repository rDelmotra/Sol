// ============================================================
// Vec3 — the plain {x,y,z} vector shape every orbital-core module returns.
// No three.js Vector3, no methods: pure data + free functions, so this
// package stays loadable from a Web Worker, Node, and the browser main
// thread alike (the whole point of orbital-core — see index.ts).
// ============================================================

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Dot product. */
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Euclidean length (2-norm). */
export function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/** Component-wise subtraction, a − b. */
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** Unit vector in the direction of `a`. Returns the zero vector for a zero input (no NaN). */
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n === 0) return { x: 0, y: 0, z: 0 };
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}
