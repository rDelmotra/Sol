import { useStore } from '../../../store/useStore';
import { FilterGroup } from '../FilterGroup';
import { STATUS_KEYS, humanizeKey } from '../shared';

/** Status facet — one FilterGroup rendering STATUS_KEYS off the store's status filter/count slices. */
export function StatusSection() {
  const statusFilters = useStore((s) => s.statusFilters);
  const toggleStatusFilter = useStore((s) => s.toggleStatusFilter);
  const facetCounts = useStore((s) => s.facetCounts);
  const visibleFacetCounts = useStore((s) => s.visibleFacetCounts);

  return (
    <FilterGroup
      title="Status"
      keys={STATUS_KEYS}
      labelFor={humanizeKey}
      active={statusFilters}
      total={facetCounts.status}
      visible={visibleFacetCounts.status}
      onToggle={toggleStatusFilter}
    />
  );
}
