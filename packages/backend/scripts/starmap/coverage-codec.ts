// ============================================================
// SPIKE — not production. Layer 2 daily-coverage file codec ("mini roaring").
//
// One file per UTC day holds, for each (frame, order), an INVERTED index
//   cell -> sorted list of object indices (positions in that day's catalog)
// Each list is stored as delta+varint bytes OR a plain bitmap over the day's N objects,
// whichever is smaller (tag in the low bit of the list's byte length in the directory).
//
// File (little endian):
//   "CVR1" | dayStartMs f64 | N u32 | nConfigs u32
//   norad table: byteLen u32, then N zigzag-delta varints
//   per config: frame u8 | order u8 | nCells u32 | dirBytes u32 | payloadBytes u32 | dir | payload
//     dir     = nCells x [ varint(cell - prevCell), varint(byteLen*2 + tag) ]   (cells ascending)
//     payload = concatenated list bodies
// ============================================================

export const FRAME_STAR = 0;
export const FRAME_EARTH = 1;

export function putVarint(out: number[], v: number): void {
  while (v >= 128) { out.push((v % 128) | 128); v = Math.floor(v / 128); }
  out.push(v);
}

/** Read a varint at buf[pos.p]; advances pos.p. */
export function getVarint(buf: Uint8Array, pos: { p: number }): number {
  let v = 0, mul = 1, b: number;
  do { b = buf[pos.p++]!; v += (b & 127) * mul; mul *= 128; } while (b & 128);
  return v;
}

/** Encode a sorted ascending list; returns [tag, bytes]. tag 0 = delta varint, 1 = bitmap. */
export function encodeList(ids: ArrayLike<number>, n: number): { tag: 0 | 1; bytes: Uint8Array } {
  const tmp: number[] = [];
  let prev = -1;
  for (let i = 0; i < ids.length; i++) { putVarint(tmp, ids[i]! - prev - 1); prev = ids[i]!; }
  const bmBytes = (n + 7) >> 3;
  if (tmp.length <= bmBytes) return { tag: 0, bytes: Uint8Array.from(tmp) };
  const bm = new Uint8Array(bmBytes);
  for (let i = 0; i < ids.length; i++) bm[ids[i]! >> 3]! |= 1 << (ids[i]! & 7);
  return { tag: 1, bytes: bm };
}

/** Decode a list body, calling fn(id) for each id in ascending order. */
export function forEachId(buf: Uint8Array, off: number, len: number, tag: number, fn: (id: number) => void): void {
  if (tag === 0) {
    const pos = { p: off }; const end = off + len;
    let prev = -1;
    while (pos.p < end) { prev += getVarint(buf, pos) + 1; fn(prev); }
  } else {
    for (let i = 0; i < len; i++) {
      let b = buf[off + i]!;
      while (b) { const lsb = b & -b; fn(i * 8 + (31 - Math.clz32(lsb))); b ^= lsb; }
    }
  }
}

export interface ConfigData { frame: number; order: number; cells: Map<number, ArrayLike<number>> }
export interface EncodedStats { frame: number; order: number; nCells: number; dirBytes: number; payloadBytes: number; nPairs: number; bitmapLists: number }

export function writeCoverage(dayStartMs: number, norad: number[], configs: ConfigData[]): { file: Uint8Array; stats: EncodedStats[]; noradBytes: number } {
  const n = norad.length;
  const parts: Uint8Array[] = [];
  const head = Buffer.alloc(20);
  head.write('CVR1', 0, 'ascii'); head.writeDoubleLE(dayStartMs, 4); head.writeUInt32LE(n, 12); head.writeUInt32LE(configs.length, 16);
  parts.push(head);
  const nt: number[] = []; let pn = 0;
  for (const v of norad) { const d = v - pn; putVarint(nt, d >= 0 ? d * 2 : -d * 2 - 1); pn = v; }
  const nh = Buffer.alloc(4); nh.writeUInt32LE(nt.length, 0);
  parts.push(nh, Uint8Array.from(nt));
  const stats: EncodedStats[] = [];
  for (const c of configs) {
    const cells = [...c.cells.keys()].sort((a, b) => a - b);
    const dir: number[] = []; const bodies: Uint8Array[] = [];
    let prev = 0, payload = 0, pairs = 0, bms = 0;
    for (const cell of cells) {
      const ids = c.cells.get(cell)!;
      pairs += ids.length;
      const e = encodeList(ids, n);
      if (e.tag === 1) bms++;
      putVarint(dir, cell - prev); prev = cell;
      putVarint(dir, e.bytes.length * 2 + e.tag);
      bodies.push(e.bytes); payload += e.bytes.length;
    }
    const h = Buffer.alloc(14);
    h.writeUInt8(c.frame, 0); h.writeUInt8(c.order, 1); h.writeUInt32LE(cells.length, 2); h.writeUInt32LE(dir.length, 6); h.writeUInt32LE(payload, 10);
    parts.push(h, Uint8Array.from(dir));
    for (const b of bodies) parts.push(b); // no spread: hourly files have >1M lists
    stats.push({ frame: c.frame, order: c.order, nCells: cells.length, dirBytes: dir.length, payloadBytes: payload, nPairs: pairs, bitmapLists: bms });
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const file = new Uint8Array(total); let o = 0;
  for (const p of parts) { file.set(p, o); o += p.length; }
  return { file, stats, noradBytes: 4 + nt.length };
}

export interface ReadConfig {
  frame: number; order: number; cells: Uint32Array; offs: Float64Array; lens: Uint32Array; tags: Uint8Array;
}
export interface CoverageDay { dayStartMs: number; n: number; norad: Int32Array; buf: Uint8Array; configs: ReadConfig[] }

export function readCoverage(buf: Uint8Array): CoverageDay {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!) !== 'CVR1') throw new Error('bad coverage file');
  const dayStartMs = dv.getFloat64(4, true), n = dv.getUint32(12, true), nCfg = dv.getUint32(16, true);
  let p = 20;
  const ntLen = dv.getUint32(p, true); p += 4;
  const pos = { p }; const norad = new Int32Array(n); let pn = 0;
  for (let i = 0; i < n; i++) { const z = getVarint(buf, pos); pn += z % 2 ? -(z + 1) / 2 : z / 2; norad[i] = pn; }
  p += ntLen;
  const configs: ReadConfig[] = [];
  for (let k = 0; k < nCfg; k++) {
    const frame = buf[p]!, order = buf[p + 1]!, nCells = dv.getUint32(p + 2, true), dirBytes = dv.getUint32(p + 6, true), payload = dv.getUint32(p + 10, true);
    p += 14;
    const cells = new Uint32Array(nCells), offs = new Float64Array(nCells), lens = new Uint32Array(nCells), tags = new Uint8Array(nCells);
    const dp = { p }; let cell = 0, off = p + dirBytes;
    for (let i = 0; i < nCells; i++) {
      cell += getVarint(buf, dp); const lt = getVarint(buf, dp);
      cells[i] = cell; tags[i] = lt & 1; lens[i] = (lt - (lt & 1)) / 2; offs[i] = off; off += lens[i]!;
    }
    configs.push({ frame, order, cells, offs, lens, tags });
    p += dirBytes + payload;
  }
  return { dayStartMs, n, norad, buf, configs };
}

/** Index of `cell` in a config's ascending cell array, or -1. */
export function findCell(c: ReadConfig, cell: number): number {
  let lo = 0, hi = c.cells.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, v = c.cells[m]!;
    if (v === cell) return m;
    if (v < cell) lo = m + 1; else hi = m - 1;
  }
  return -1;
}
