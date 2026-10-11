import { useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { applyCockpitKeyCommand, cockpitKeyCommand } from './keys';

/** Window keydown → cockpit surfaces (see keys.ts for the map). Reads the store on demand. */
export function useCockpitKeys(): void {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const cmd = cockpitKeyCommand(e, s);
      if (cmd && applyCockpitKeyCommand(cmd, s)) e.preventDefault();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);
}
