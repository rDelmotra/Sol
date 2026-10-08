import type { DsoObject } from './dso-types';

// The store only ever replaces `dsoObjects` (never mutates in place), so the
// array reference is a sound cache key.
const cache = new WeakMap<readonly DsoObject[], Map<string, number>>();

/** Same result as `list.findIndex(d => d.dsoId === id)`, O(1) after first call per array. */
export function dsoIndexOf(list: readonly DsoObject[], id: string): number {
  let map = cache.get(list);
  if (!map) {
    map = new Map();
    for (let i = 0; i < list.length; i++) {
      const key = list[i].dsoId;
      if (!map.has(key)) map.set(key, i);
    }
    cache.set(list, map);
  }
  return map.get(id) ?? -1;
}
