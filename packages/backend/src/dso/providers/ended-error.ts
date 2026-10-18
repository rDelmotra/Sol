/**
 * Thrown by a provider when it learns that a target's ephemeris ENDED in the past
 * and no part of the requested window is covered, or the covered part could not
 * be fetched. It is not a transient failure: asking again will not help until the
 * provider publishes new data. The worker marks the object as ended and stops asking.
 */
export class DsoEphemerisEndedError extends Error {
  constructor(
    message: string,
    /** The last instant the provider has data for. */
    public readonly endedAt: Date,
  ) {
    super(message);
    this.name = 'DsoEphemerisEndedError';
  }
}
