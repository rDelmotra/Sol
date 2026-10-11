import { useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { cockpitKeyCommand } from './keys';

/** Window keydown → cockpit surfaces (see keys.ts for the map). Reads the store on demand. */
export function useCockpitKeys(): void {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const cmd = cockpitKeyCommand(e, s);
      if (!cmd) return;
      switch (cmd) {
        case 'toggleAnalysis': s.toggleAnalysisPanel(); break;
        case 'toggleFocus': s.toggleFocusPanel(); break;
        case 'openAsk': e.preventDefault(); s.setAskBarOpen(true); break;
        case 'toggleSheet': e.preventDefault(); s.toggleControlsSheet(); break;
        case 'closeSheet': s.setControlsSheetOpen(false); break;
        case 'closeAsk': s.setAskBarOpen(false); break;
        case 'closePanels': s.closePanels(); break;
        case 'closeScrubber': s.setScrubberMode(false); break;
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);
}
