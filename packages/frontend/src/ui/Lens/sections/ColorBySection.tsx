import { useStore } from '../../../store/useStore';
import { Pill } from '../../primitives';
import { lensSectionTitleStyle, humanizeKey } from '../shared';

const COLOR_BY_OPTIONS = ['type', 'status', 'sector', 'country'] as const;

/** "Color by" facet section of the Lens sheet — ported from the old TopTaskbar
 *  ColorByMenu dropdown, restyled as a compact horizontal Pill row instead of a
 *  vertical button list (few, short options read fine wrapped in a row). */
export function ColorBySection() {
  const colorBy = useStore((s) => s.colorBy);
  const setColorBy = useStore((s) => s.setColorBy);

  return (
    <div>
      <div style={lensSectionTitleStyle}>Color by</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {COLOR_BY_OPTIONS.map((opt) => (
          <Pill key={opt} on={colorBy === opt} onClick={() => setColorBy(opt)}>
            {humanizeKey(opt)}
          </Pill>
        ))}
      </div>
    </div>
  );
}
