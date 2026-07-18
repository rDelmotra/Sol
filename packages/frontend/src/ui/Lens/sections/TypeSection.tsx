import { useStore } from '../../../store/useStore';
import type { CatalogType } from '../../../data/types';
import { CATEGORY_COLOR } from '../../styles/tokens';
import { FilterGroup } from '../FilterGroup';
import { TYPE_KEYS, TYPE_LABELS } from '../shared';

/** 'satellite' has no direct ObjectCategory counterpart — it maps to the
 *  'active_satellite' swatch. Every other CatalogType key lines up by name. */
function colorForType(key: CatalogType): string | undefined {
  return key === 'satellite' ? CATEGORY_COLOR.active_satellite : CATEGORY_COLOR[key];
}

/** "Types" facet section of the Lens sheet — thin config wrapper around the
 *  shared FilterGroup. */
export function TypeSection() {
  const typeFilters = useStore((s) => s.typeFilters);
  const toggleTypeFilter = useStore((s) => s.toggleTypeFilter);
  const facetCounts = useStore((s) => s.facetCounts);
  const visibleFacetCounts = useStore((s) => s.visibleFacetCounts);

  return (
    <FilterGroup
      title="Types"
      keys={TYPE_KEYS}
      labelFor={(k) => TYPE_LABELS[k]}
      active={typeFilters}
      total={facetCounts.type}
      visible={visibleFacetCounts.type}
      onToggle={toggleTypeFilter}
      colorFor={colorForType}
    />
  );
}
