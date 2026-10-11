import { useStore } from '../../../store/useStore';
import { EmptyPane } from '../primitives/EmptyPane';
import { PaneStack } from '../primitives/PaneStack';
import { CatalogPane } from './CatalogPane';
import { IdentityPane } from './IdentityPane';
import { OrbitPane } from './OrbitPane';

/** Left stack (Q): IDENTITY, ORBIT, CATALOG of the lock, vertically centred. */
export function AnalysisPanes() {
  const open = useStore((s) => s.analysisPanelOpen);
  const selected = useStore((s) => s.selectedSatellite);
  if (!open) return null;

  return (
    <PaneStack side="left">
      {selected
        ? [<IdentityPane key="identity" selected={selected} />, <OrbitPane key="orbit" selected={selected} />, <CatalogPane key="catalog" selected={selected} />]
        : [<EmptyPane key="empty" text="NO OBJECT LOCKED" />]}
    </PaneStack>
  );
}
