import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { LEFT_PANE_W, PANE_EDGE_INSET, PANE_GAP, PANE_STAGGER_MS, RIGHT_PANE_W } from '../layout';

/** What PaneStack hands each child pane: its fan-in delay and the side it fans in from. */
export interface PaneSlotProps {
  delay?: number;
  fromLeft?: boolean;
}

/**
 * A vertically centred column of panes hugging one screen edge. Each child
 * receives `delay` = index × PANE_STAGGER_MS and `fromLeft` for its side.
 */
export function PaneStack({ side, children }: { side: 'left' | 'right'; children: ReactNode }) {
  const fromLeft = side === 'left';
  const panes = Children.toArray(children).map((child, i) =>
    isValidElement(child) ? cloneElement(child as ReactElement<PaneSlotProps>, { delay: i * PANE_STAGGER_MS, fromLeft }) : child,
  );
  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        [side]: PANE_EDGE_INSET,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: PANE_GAP,
        width: fromLeft ? LEFT_PANE_W : RIGHT_PANE_W,
      }}
    >
      {panes}
    </div>
  );
}
