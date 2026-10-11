/**
 * The one "should this keydown be ignored?" guard, shared by the flight keys
 * (engine/input/flight-input.ts) and the cockpit keys (ui/cockpit/keys.ts).
 * Pure, no DOM types: tests pass plain objects.
 */

export interface ModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface TypingGuardEvent extends ModifierState {
  target: unknown;
}

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Cmd / Ctrl / Alt held: a browser or OS shortcut, never a game key. */
export function hasModifier(e: ModifierState): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}

/** The key landed in a text field (input, textarea, select, contenteditable). */
export function isTextTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const tagName = 'tagName' in target ? target.tagName : undefined;
  const editable = 'isContentEditable' in target && target.isContentEditable === true;
  return (typeof tagName === 'string' && TEXT_TAGS.has(tagName)) || editable;
}

/** True when a keydown must NOT drive flight or the HUD: a modifier chord or typing. */
export function isTypingOrModified(e: TypingGuardEvent): boolean {
  return hasModifier(e) || isTextTarget(e.target);
}
