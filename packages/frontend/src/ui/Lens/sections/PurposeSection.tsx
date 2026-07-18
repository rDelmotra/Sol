import { useStore } from '../../../store/useStore';
import { FilterGroup } from '../FilterGroup';
import { PURPOSE_KEYS, humanizeKey } from '../shared';

/** "Purpose" facet section inside the Lens sheet. */
export function PurposeSection() {
  const purposeFilters = useStore((s) => s.purposeFilters);
  const togglePurposeFilter = useStore((s) => s.togglePurposeFilter);
  const facetCounts = useStore((s) => s.facetCounts);
  const visibleFacetCounts = useStore((s) => s.visibleFacetCounts);

  return (
    <FilterGroup
      title="Purpose"
      keys={PURPOSE_KEYS}
      labelFor={humanizeKey}
      active={purposeFilters}
      total={facetCounts.purpose}
      visible={visibleFacetCounts.purpose}
      onToggle={togglePurposeFilter}
    />
  );
}
