import { DataTag, type FilterItemState } from '../primitives';
import { lensSectionTitleStyle } from './shared';

/**
 * A titled group of facet pills inside the Lens sheet (Types / Status / Sector /
 * Purpose all render through this — one generic instead of four near-duplicate
 * components). Each pill's fill encodes `visible / total`; its emphasis follows
 * the group's aggregate state:
 *   - nothing narrowed (every key active)   -> every pill 'implicit'
 *   - the group is narrowed                 -> active keys 'selected', rest 'excluded'
 */
export function FilterGroup<K extends string>({
  title,
  keys,
  labelFor,
  active,
  total,
  visible,
  onToggle,
  colorFor,
}: {
  title: string;
  keys: readonly K[];
  labelFor: (key: K) => string;
  active: Record<K, boolean>;
  total: Record<K, number>;
  visible: Record<K, number>;
  onToggle: (key: K) => void;
  colorFor?: (key: K) => string | undefined;
}) {
  const allOn = keys.every((k) => active[k]);

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={lensSectionTitleStyle}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {keys.map((key) => {
          const state: FilterItemState = allOn ? 'implicit' : active[key] ? 'selected' : 'excluded';
          return (
            <DataTag
              key={key}
              label={labelFor(key)}
              state={state}
              visible={visible[key] ?? 0}
              total={total[key] ?? 0}
              color={colorFor?.(key)}
              onClick={() => onToggle(key)}
            />
          );
        })}
      </div>
    </div>
  );
}
