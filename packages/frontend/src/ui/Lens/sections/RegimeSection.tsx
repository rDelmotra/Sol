import { useStore } from '../../../store/useStore';
import { Pill } from '../../primitives';
import { REGIME_KEYS, REGIME_LABELS, lensSectionTitleStyle } from '../shared';

/**
 * "Orbital Regimes" filter row inside the Lens sheet. Plain on/off Pill toggles —
 * FacetCounts has no per-regime group, so unlike Types/Status/Sector/Purpose this
 * does not (and cannot) show visible/total counts via DataTag.
 */
export function RegimeSection() {
  const regimeFilters = useStore((s) => s.regimeFilters);
  const toggleRegimeFilter = useStore((s) => s.toggleRegimeFilter);

  return (
    <div>
      <div style={lensSectionTitleStyle}>Regimes</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {REGIME_KEYS.map((key) => (
          <Pill
            key={key}
            on={regimeFilters[key]}
            accent="perceptor"
            onClick={() => toggleRegimeFilter(key)}
          >
            {REGIME_LABELS[key]}
          </Pill>
        ))}
      </div>
    </div>
  );
}
