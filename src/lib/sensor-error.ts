// Decides which stored read error is still worth showing, and how loudly.
//
// A failed battery/firmware read is secondary: readings may still be arriving.
// It is shown low-key and disappears once a later battery/firmware read works.

export type SensorErrorKind = 'read' | 'info';

export interface SensorError {
  message: string;
  at: number | null;
  kind: SensorErrorKind;
}

export interface SensorErrorRow {
  last_error: string | null;
  last_error_at: number | null;
  battery_at: number | null;
  device_info_at: number | null;
}

/** Prefix of every battery/firmware error the collector stores. */
export const INFO_ERROR_PREFIX = 'Battery/firmware read failed';

export function isInfoError(message: string | null | undefined): boolean {
  if (!message) return false;
  // "Could not read battery/firmware" is the older wording, still in existing databases.
  return message.startsWith(INFO_ERROR_PREFIX) || message.startsWith('Could not read battery/firmware');
}

export function currentSensorError(s: SensorErrorRow): SensorError | null {
  if (!s.last_error) return null;
  const at = s.last_error_at;
  if (isInfoError(s.last_error)) {
    const lastInfo = Math.max(s.battery_at ?? 0, s.device_info_at ?? 0);
    if (at != null && lastInfo >= at) return null;
    return { message: s.last_error, at, kind: 'info' };
  }
  return { message: s.last_error, at, kind: 'read' };
}

/** The error fields the dashboard and setup page show. */
export function errorFields(s: SensorErrorRow) {
  const e = currentSensorError(s);
  return { lastError: e?.message ?? null, lastErrorAt: e?.at ?? null, lastErrorKind: e?.kind ?? null };
}
