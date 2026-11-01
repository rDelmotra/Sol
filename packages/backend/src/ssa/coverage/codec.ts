// ============================================================
// Coverage layer file codec ("mini roaring"). Ported from scripts/starmap/coverage-codec.ts with the object index widened:
// the spike packed it into 16 bits (65,536 objects); here the lists are delta+varint (no cap) and the build packs 22 bits.
//
// One file = one layer of one UTC day: an INVERTED index   key -> sorted list of object indices   where
// key = cell * periodsPerDay + periodIndex (1 period for 'day', 24 for 'hour'). The object index is the position in the day's
// catalog, resolved to NORAD ids by the day's manifest (store.ts). Each list is delta+varint bytes OR a bitmap over the N objects,
// whichever is smaller (tag in the low bit of the list's byte length in the directory).
//
// File (little endian), 32-byte header:
//   "CVR2" | version u8 (2) | gran u8 (0 day, 1 hour) | order u8 | pad u8 | dayStartMs f64 | N u32 | nCells u32 | dirBytes u32 | payloadBytes u32
//   dir     = nCells x [ varint(cell - prevCell), varint(byteLen*2 + tag) ]   (cells ascending)
//   payload = concatenated list bodies
// ============================================================

export const CODEC_VERSION = 2;
const HEADER = 32;

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

/** Encode a sorted ascending list; tag 0 = delta varint, 1 = bitmap. */
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

export interface LayerStats { nCells: number; dirBytes: number; payloadBytes: number; nPairs: number; bitmapLists: number }

export function writeLayer(gran: number, order: number, dayStartMs: number, n: number, cellsMap: Map<number, ArrayLike<number>>): { file: Uint8Array; stats: LayerStats } {
  const cells = [...cellsMap.keys()].sort((a, b) => a - b);
  const dir: number[] = []; const bodies: Uint8Array[] = [];
  let prev = 0, payload = 0, pairs = 0, bms = 0;
  for (const cell of cells) {
    const ids = cellsMap.get(cell)!;
    pairs += ids.length;
    const e = encodeList(ids, n);
    if (e.tag === 1) bms++;
    putVarint(dir, cell - prev); prev = cell;
    putVarint(dir, e.bytes.length * 2 + e.tag);
    bodies.push(e.bytes); payload += e.bytes.length;
  }
  const file = new Uint8Array(HEADER + dir.length + payload);
  const dv = new DataView(file.buffer);
  file.set([0x43, 0x56, 0x52, 0x32, CODEC_VERSION, gran, order, 0], 0); // "CVR2"
  dv.setFloat64(8, dayStartMs, true); dv.setUint32(16, n, true); dv.setUint32(20, cells.length, true); dv.setUint32(24, dir.length, true); dv.setUint32(28, payload, true);
  file.set(dir, HEADER);
  let o = HEADER + dir.length;
  for (const b of bodies) { file.set(b, o); o += b.length; }
  return { file, stats: { nCells: cells.length, dirBytes: dir.length, payloadBytes: payload, nPairs: pairs, bitmapLists: bms } };
}

export interface Layer {
  gran: number; order: number; dayStartMs: number; n: number; buf: Uint8Array;
  cells: Uint32Array; offs: Float64Array; lens: Uint32Array; tags: Uint8Array;
}

export function readLayer(buf: Uint8Array): Layer {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < HEADER || String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!) !== 'CVR2') throw new Error('bad coverage file');
  if (buf[4] !== CODEC_VERSION) throw new Error(`unsupported coverage codec version ${buf[4]}`);
  const gran = buf[5]!, order = buf[6]!, dayStartMs = dv.getFloat64(8, true), n = dv.getUint32(16, true);
  const nCells = dv.getUint32(20, true), dirBytes = dv.getUint32(24, true), payload = dv.getUint32(28, true);
  if (HEADER + dirBytes + payload !== buf.length) throw new Error('truncated coverage file');
  const cells = new Uint32Array(nCells), offs = new Float64Array(nCells), lens = new Uint32Array(nCells), tags = new Uint8Array(nCells);
  const dp = { p: HEADER }; let cell = 0, off = HEADER + dirBytes;
  for (let i = 0; i < nCells; i++) {
    cell += getVarint(buf, dp); const lt = getVarint(buf, dp);
    cells[i] = cell; tags[i] = lt & 1; lens[i] = (lt - (lt & 1)) / 2; offs[i] = off; off += lens[i]!;
  }
  return { gran, order, dayStartMs, n, buf, cells, offs, lens, tags };
}

/** Index of `cell` in a layer's ascending cell array, or -1. */
export function findCell(l: Layer, cell: number): number {
  let lo = 0, hi = l.cells.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, v = l.cells[m]!;
    if (v === cell) return m;
    if (v < cell) lo = m + 1; else hi = m - 1;
  }
  return -1;
}

/** Call fn(objectIndex) for every object of list `i` of a layer. */
export function listIds(l: Layer, i: number, fn: (id: number) => void): void { forEachId(l.buf, l.offs[i]!, l.lens[i]!, l.tags[i]!, fn); }
