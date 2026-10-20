// Quiet hours: immediate alerts (ntfy, webhook) that become due in this window
// are held and sent as one summary when it ends.

import { formatTimeOfDay, parseTimeOfDay, type TimeOfDay } from './digest';

export interface QuietHours {
  start: TimeOfDay;
  end: TimeOfDay;
}

/** "21:00-08:00" -> range; "" or "off" -> null (no quiet hours). Throws on invalid input. */
export function parseQuietHours(s: string): QuietHours | null {
  const t = s.trim().toLowerCase();
  if (t === '' || t === 'off') return null;
  const m = /^(\S+)\s*-\s*(\S+)$/.exec(t);
  if (!m) throw new Error(`Invalid quiet hours "${s}", expected HH:MM-HH:MM, e.g. 21:00-08:00, or "off"`);
  const q = { start: parseTimeOfDay(m[1]), end: parseTimeOfDay(m[2]) };
  if (q.start.hour === q.end.hour && q.start.minute === q.end.minute) {
    throw new Error(`Invalid quiet hours "${s}": start and end are the same`);
  }
  return q;
}

export const formatQuietHours = (q: QuietHours | null) => (q ? `${formatTimeOfDay(q.start)}-${formatTimeOfDay(q.end)}` : 'off');

/** Whether local time `now` falls in the range (start inclusive, end exclusive; may cross midnight). */
export function isQuietTime(now: number, q: QuietHours | null): boolean {
  if (!q) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const start = q.start.hour * 60 + q.start.minute;
  const end = q.end.hour * 60 + q.end.minute;
  return start < end ? m >= start && m < end : m >= start || m < end;
}
