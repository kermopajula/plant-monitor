// Winter season: houseplants rest while days are short. In this window low
// conductivity is not reported as "Needs fertilizer" (plants should not be fed),
// and the low-light limit is lowered so normal winter light does not alert.
// The default suits Estonia (and similar latitudes): dark days from October,
// growth and feeding resume in March as the light comes back.

export interface MonthDay {
  month: number; // 1-12
  day: number;
}

export interface WinterSeason {
  start: MonthDay;
  end: MonthDay;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseMonthDay(s: string, whole: string): MonthDay {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  const month = m ? Number(m[1]) : NaN;
  const day = m ? Number(m[2]) : NaN;
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1])) {
    throw new Error(`Invalid winter season "${whole}", expected MM-DD..MM-DD, e.g. 10-01..03-01, or "off"`);
  }
  return { month, day };
}

/** "10-01..03-01" -> range; "" or "off" -> null (no seasonal changes). Throws on invalid input. */
export function parseWinterSeason(s: string): WinterSeason | null {
  const t = s.trim().toLowerCase();
  if (t === '' || t === 'off') return null;
  const m = /^(\S+)\s*\.\.\s*(\S+)$/.exec(t);
  if (!m) throw new Error(`Invalid winter season "${s}", expected MM-DD..MM-DD, e.g. 10-01..03-01, or "off"`);
  const r = { start: parseMonthDay(m[1], s), end: parseMonthDay(m[2], s) };
  if (r.start.month === r.end.month && r.start.day === r.end.day) {
    throw new Error(`Invalid winter season "${s}": start and end are the same`);
  }
  return r;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const formatWinterSeason = (r: WinterSeason | null) =>
  r ? `${pad(r.start.month)}-${pad(r.start.day)}..${pad(r.end.month)}-${pad(r.end.day)}` : 'off';

/** Whether local date `now` falls in the season (start inclusive, end exclusive; may cross New Year). */
export function isWinter(now: number, r: WinterSeason | null): boolean {
  if (!r) return false;
  const d = new Date(now);
  const key = (d.getMonth() + 1) * 100 + d.getDate();
  const start = r.start.month * 100 + r.start.day;
  const end = r.end.month * 100 + r.end.day;
  return start < end ? key >= start && key < end : key >= start || key < end;
}
