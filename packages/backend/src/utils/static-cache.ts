// ============================================================
// Cache policy for the built frontend's hashed files.
//
// Vite writes everything it bundles to dist/assets/ as name-HASH.ext, where HASH
// is 8 base64url characters of the file's content. New content means a new name,
// so these files can be cached for a year and never revalidated. index.html is
// the only thing that names them; it stays revalidated on every visit, so a new
// deploy is picked up as soon as the page is opened.
//
// The rule is deliberately narrow: only under assets/, only when the file name
// ends in -HASH.ext. Anything that does not clearly look hashed keeps the
// default (revalidate), which is always safe.
// ============================================================

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// "-" then 8 or more of [A-Za-z0-9_-], then ".ext" at the end of the name. The
// lookahead wants at least one digit or capital letter in there, which a real
// content hash has (all-lowercase names like my-long-image.png do not count).
const HASHED_NAME = /-(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/**
 * True when `relPath` (relative to the frontend dist root, forward slashes) is a
 * content-hashed build asset that is safe to cache forever.
 */
export function isHashedAsset(relPath: string): boolean {
  return relPath.startsWith('assets/') && HASHED_NAME.test(relPath);
}
