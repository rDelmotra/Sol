import type { DsoSnapshot } from '@orbitwatch/contracts';

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const CADENCE_TOLERANCE_SEC = 1;

export class DsoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsoValidationError';
  }
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new DsoValidationError(`${label} must be a finite number`);
  }
}

export function validateDsoSnapshot(snapshot: DsoSnapshot): void {
  if (snapshot.stateVectors.length < 2) {
    throw new DsoValidationError('DSO snapshot must contain at least 2 state vectors');
  }

  const validFromMs = Date.parse(snapshot.validFrom);
  const validToMs = Date.parse(snapshot.validTo);

  if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs)) {
    throw new DsoValidationError('DSO snapshot validity bounds must be ISO timestamps');
  }

  if (validToMs <= validFromMs) {
    throw new DsoValidationError('DSO snapshot validTo must be after validFrom');
  }

  let previousTimestampMs = Number.NaN;

  for (let index = 0; index < snapshot.stateVectors.length; index++) {
    const [timestampIso, x, y, z, vx, vy, vz] = snapshot.stateVectors[index];
    const timestampMs = Date.parse(timestampIso);

    if (!Number.isFinite(timestampMs)) {
      throw new DsoValidationError(`State vector ${index} has an invalid ISO timestamp`);
    }

    if (index > 0) {
      if (timestampMs <= previousTimestampMs) {
        throw new DsoValidationError('DSO snapshot timestamps must be strictly ascending');
      }

      const cadenceSeconds = (timestampMs - previousTimestampMs) / 1000;
      if (Math.abs(cadenceSeconds - snapshot.sampleStepSec) > CADENCE_TOLERANCE_SEC) {
        throw new DsoValidationError(
          `DSO snapshot cadence ${cadenceSeconds}s does not match sampleStepSec ${snapshot.sampleStepSec}s`,
        );
      }
    }

    assertFiniteNumber(x, `State vector ${index} x`);
    assertFiniteNumber(y, `State vector ${index} y`);
    assertFiniteNumber(z, `State vector ${index} z`);
    assertFiniteNumber(vx, `State vector ${index} vx`);
    assertFiniteNumber(vy, `State vector ${index} vy`);
    assertFiniteNumber(vz, `State vector ${index} vz`);

    previousTimestampMs = timestampMs;
  }

  if (snapshot.stateVectors[0][0] !== snapshot.validFrom) {
    throw new DsoValidationError('DSO snapshot validFrom must equal the first state vector timestamp');
  }

  if (snapshot.stateVectors[snapshot.stateVectors.length - 1][0] !== snapshot.validTo) {
    throw new DsoValidationError('DSO snapshot validTo must equal the last state vector timestamp');
  }

  const byteSize = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (byteSize > MAX_SNAPSHOT_BYTES) {
    throw new DsoValidationError(
      `DSO snapshot exceeds the ${MAX_SNAPSHOT_BYTES} byte size guard (${byteSize} bytes)`,
    );
  }
}
