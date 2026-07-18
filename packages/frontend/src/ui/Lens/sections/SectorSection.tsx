import { useStore } from '../../../store/useStore';
import { FilterGroup } from '../FilterGroup';
import { SECTOR_KEYS, humanizeKey } from '../shared';

/** Sector facet — one FilterGroup rendering SECTOR_KEYS off the store's sector filter/count slices. */
export function SectorSection() {
  const sectorFilters = useStore((s) => s.sectorFilters);
  const toggleSectorFilter = useStore((s) => s.toggleSectorFilter);
  const facetCounts = useStore((s) => s.facetCounts);
  const visibleFacetCounts = useStore((s) => s.visibleFacetCounts);

  return (
    <FilterGroup
      title="Sector"
      keys={SECTOR_KEYS}
      labelFor={humanizeKey}
      active={sectorFilters}
      total={facetCounts.sector}
      visible={visibleFacetCounts.sector}
      onToggle={toggleSectorFilter}
    />
  );
}
