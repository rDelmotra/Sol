import { useEffect, useRef, useState } from 'react';

/**
 * Counts gear changes after mount. GearSweep and GearReadout each call it with
 * the same store value, so their one-shot flare / glow fire together; the
 * first render returns 0 so only a real shift animates.
 */
export function useGearBump(gear: number): number {
  const [bump, setBump] = useState(0);
  const prev = useRef(gear);
  useEffect(() => {
    if (prev.current === gear) return;
    prev.current = gear;
    setBump((b) => b + 1);
  }, [gear]);
  return bump;
}
