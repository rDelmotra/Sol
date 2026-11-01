import type { EncounterSummary } from '@orbitwatch/contracts';
import { formatEncounterManoeuvre } from '../../../data/encounter-format';

/**
 * Quiet one-line note under an encounter row: "manoeuvred 2 d ago" for whichever object changed orbit recently (an observed
 * element-set change, not the family-based `manoeuvrable` capability). Same faint text as the rest of the row; renders nothing
 * when neither object has one on record. Pure: the caller supplies the clock.
 */
export function ManoeuvreTag({ e, noradId, nowMs }: { e: EncounterSummary; noradId: number; nowMs: number }) {
  const text = formatEncounterManoeuvre(e, noradId, nowMs);
  if (!text) return null;
  return (
    <div data-testid="manoeuvre-tag" style={{ marginTop: 2, fontSize: 10, color: 'var(--hud-text-faint)' }}>
      {text}
    </div>
  );
}
