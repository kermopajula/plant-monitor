// Decides whether the collector connects to a sensor in this cycle.
// Connecting costs sensor battery, so it only happens when needed.

export type PollAction = 'none' | 'info' | 'data';

export interface PollInput {
  /** Readings arrived passively (broadcast) in this cycle. */
  passive: boolean;
  /** Battery value is recent enough (or was just broadcast). */
  batteryFresh: boolean;
  firmwareKnown: boolean;
  /** Last connection attempt for battery/firmware, successful or not. */
  infoAttemptAt: number | null;
  now: number;
  /** Minimum time between battery/firmware attempts. */
  infoRetryMs: number;
}

/**
 * - 'data': no broadcast readings, so connect and read them (battery/firmware come along).
 * - 'info': readings are fine, but battery/firmware are missing or stale, and the last
 *   attempt is long enough ago (so a sensor that refuses is not hammered every cycle).
 * - 'none': nothing to do.
 */
export function decidePoll(i: PollInput): PollAction {
  if (!i.passive) return 'data';
  const needInfo = !i.batteryFresh || !i.firmwareKnown;
  if (!needInfo) return 'none';
  if (i.infoAttemptAt != null && i.now - i.infoAttemptAt < i.infoRetryMs) return 'none';
  return 'info';
}
