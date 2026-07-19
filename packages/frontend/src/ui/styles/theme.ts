// Modular theme selection for the "Deep Field" design system.
//
// A theme is just a named set of --ow-* skin overrides in globals.css, applied
// by setting `data-theme` on <html>. This module owns the list, the persisted
// choice, and the apply/read helpers — nothing else needs to know how theming
// works. To add a theme: add a `[data-theme='<id>']` block in globals.css and
// one entry here.

export const THEMES = [
  { id: 'dune', label: 'Dune' },
  { id: 'deep-field', label: 'Deep Field' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

const STORAGE_KEY = 'orbitwatch:theme:v1';
const DEFAULT_THEME: ThemeId = 'dune';

function isThemeId(v: string | null): v is ThemeId {
  return v !== null && THEMES.some((t) => t.id === v);
}

/** The persisted theme, or the default when none is stored / storage is blocked. */
export function getStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(v)) return v;
  } catch {
    // Ignore — private mode / blocked storage falls back to the default.
  }
  return DEFAULT_THEME;
}

/** Apply a theme to the document + persist it. Safe to call before React mounts. */
export function applyTheme(id: ThemeId): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = id;
  }
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the attribute is set for this session even if we can't persist.
  }
}
