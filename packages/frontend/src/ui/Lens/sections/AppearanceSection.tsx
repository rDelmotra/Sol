import { useState } from 'react';
import { Pill } from '../../primitives';
import { lensSectionTitleStyle } from '../shared';
import { THEMES, applyTheme, getStoredTheme, type ThemeId } from '../../styles/theme';

/** Theme picker — swaps the active [data-theme] skin. Local state only: the
 *  choice lives on <html> + localStorage (styles/theme.ts), not the store. */
export function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeId>(getStoredTheme);

  const pick = (id: ThemeId) => {
    applyTheme(id);
    setTheme(id);
  };

  return (
    <div>
      <div style={lensSectionTitleStyle}>Theme</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {THEMES.map((t) => (
          <Pill key={t.id} on={theme === t.id} onClick={() => pick(t.id)}>
            {t.label}
          </Pill>
        ))}
      </div>
    </div>
  );
}
