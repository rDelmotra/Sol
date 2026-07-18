/** Switch. Visuals live in `.ow-toggle` / `.ow-toggle__knob`. */
export function Toggle({
  on,
  onToggle,
  disabled = false,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="ow-toggle"
      data-on={on ? 'true' : 'false'}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="ow-toggle__knob" />
    </button>
  );
}
