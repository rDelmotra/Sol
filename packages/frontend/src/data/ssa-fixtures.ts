// Test fixtures for /api/ssa responses (shapes from @orbitwatch/contracts).
import type { EncounterSummary, ObjectEncounters, SsaRunInfo } from '@orbitwatch/contracts';

export function runFixture(id = 1): SsaRunInfo {
  return {
    id,
    batchTime: '2026-10-31T02:30:00.000Z',
    elementCutoff: '2026-10-31T02:00:00.000Z',
    objects: 30000,
    encounters: 2,
    durationS: 210,
    codeVersion: 'test',
  };
}

export function encounterFixture(id: number, aNorad: number, bNorad: number, tca: string, over: Partial<EncounterSummary> = {}): EncounterSummary {
  return {
    id,
    a: { noradId: aNorad, name: `OBJ-${aNorad}`, objectType: 'PAYLOAD' },
    b: { noradId: bNorad, name: `OBJ-${bNorad}`, objectType: 'DEBRIS' },
    tca,
    missKm: 0.412,
    relSpeedKms: 11.2,
    ricKm: [0.1, 0.3, 0.25],
    volume: 'leo',
    pc: 2.3e-5,
    pcMax: 4.1e-5,
    hardBodyRadiusKm: 0.01,
    manoeuvrable: false,
    label: null,
    firstSeen: '2026-10-31T02:30:00.000Z',
    updates: 1,
    ...over,
  };
}

/** Two encounters for `noradId`, deliberately out of TCA order. */
export function encountersFixture(noradId: number, runId = 1): ObjectEncounters {
  return {
    noradId,
    run: runFixture(runId),
    encounters: [
      encounterFixture(11, noradId, 90001, '2026-10-31T20:00:00.000Z', { missKm: 2.4, pc: null }),
      encounterFixture(10, 90002, noradId, '2026-10-31T14:00:00.000Z', { manoeuvrable: true }),
    ],
    events: [],
  };
}
