// ============================================================
// Content-coding helpers for responses we pre-compress ourselves.
//
// Why not req.acceptsEncodings(): its tie-break follows the ORDER in the
// client's header, and browsers send "gzip, deflate, br", so gzip would win
// even when we hold a smaller brotli copy. Here, brotli wins whenever the
// client allows it and rates it at least as high as gzip.
// ============================================================

export type ServedEncoding = 'br' | 'gzip' | 'identity';

/** Parse an Accept-Encoding header into coding -> q value (lower-cased names). */
export function parseAcceptEncoding(header: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!header) return out;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number.isFinite(parseFloat(m[1])) ? parseFloat(m[1]) : 1;
    }
    out.set(name, q);
  }
  return out;
}

/**
 * Pick the encoding to send. `available` says which pre-compressed copies we
 * hold right now. Brotli is chosen when allowed (q > 0) and q(br) >= q(gzip);
 * otherwise gzip when allowed; otherwise identity. A missing header means
 * identity (same as the old req.acceptsEncodings(['gzip']) behaviour).
 */
export function chooseEncoding(
  header: string | undefined,
  available: { br: boolean; gzip: boolean },
): ServedEncoding {
  const accepted = parseAcceptEncoding(header);
  const star = accepted.get('*') ?? 0;
  const q = (name: string): number => accepted.get(name) ?? star;
  const qBr = available.br ? q('br') : 0;
  const qGzip = available.gzip ? Math.max(q('gzip'), accepted.get('x-gzip') ?? 0) : 0;
  if (qBr > 0 && qBr >= qGzip) return 'br';
  if (qGzip > 0) return 'gzip';
  return 'identity';
}

/**
 * If-None-Match test using weak comparison (RFC 9110): true when the header is
 * `*` or lists the tag, with or without a W/ prefix.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const strip = (t: string): string => t.trim().replace(/^W\//, '');
  const want = strip(etag);
  return ifNoneMatch.split(',').some((t) => strip(t) === want);
}
