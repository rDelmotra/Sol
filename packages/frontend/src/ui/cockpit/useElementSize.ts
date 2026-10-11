import { useEffect, useState, type RefObject } from 'react';

/**
 * Size of an element in CSS px, kept current by a ResizeObserver. The HUD layers
 * measure themselves rather than the window, so they agree with the HUD root.
 * {0, 0} until the first measure.
 */
export function useElementSize(ref: RefObject<HTMLElement>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
