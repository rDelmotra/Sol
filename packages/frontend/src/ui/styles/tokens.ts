// TS-side handles for the "Deep Field" design tokens defined in globals.css.
//
// Inline styles can reference CSS custom properties directly (e.g.
// `color: 'var(--ow-text-hi)'`), so this file only exports the few token maps
// that are keyed by a domain enum — where a plain string literal in JSX would
// otherwise drift between components. The single source of truth for the values
// is still globals.css.

import type { ObjectCategory } from '../../data/types';

/** Object-category swatch colours, as CSS-var references. Shared by the search
 *  results, cluster popup, and any legend — one definition, no drift. */
export const CATEGORY_COLOR: Record<ObjectCategory, string> = {
  active_satellite: 'var(--ow-cat-active)',
  inactive_satellite: 'var(--ow-cat-inactive)',
  rocket_body: 'var(--ow-cat-rocket)',
  debris: 'var(--ow-cat-debris)',
  unknown: 'var(--ow-cat-unknown)',
  deep_space: 'var(--ow-cat-deepspace)',
};
