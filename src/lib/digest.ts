// Daily digest: alerts for digest channels (email) are queued and sent as one
// message per day, grouped by plant.

import type { Problem } from './status';

export interface DigestEntry {
  id: number;
  mac: string;
  plant: string;
  problem: Problem;
  /** Description at the time the alert fired, e.g. "Needs water: 13% now (ideal 15–60%)". */
  detail: string;
  createdAt: number;
}

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export function parseTimeOfDay(s: string): TimeOfDay {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    throw new Error(`Invalid time of day "${s}", expected HH:MM (24 h), e.g. 08:00`);
  }
  return { hour, minute };
}

export const formatTimeOfDay = (t: TimeOfDay) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;

/** Local calendar day, e.g. "2026-10-13". */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * True once the configured local time has passed today and today's digest has
 * not been handled yet. If the Pi was off at that time, the digest goes out as
 * soon as it is back.
 */
export function digestDue(now: number, lastDay: string | null, at: TimeOfDay): boolean {
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes >= at.hour * 60 + at.minute && lastDay !== localDayKey(now);
}

const defaultTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Builds one message from the queued entries. Repeats of the same problem on
 * the same plant are merged; each line says whether the problem is still open.
 */
export function buildDigest(
  entries: DigestEntry[],
  isOpen: (mac: string, problem: Problem) => boolean,
  formatTime: (ts: number) => string = defaultTime,
): { title: string; message: string } | null {
  if (!entries.length) return null;

  const plants = new Map<string, { name: string; problems: Map<Problem, { first: DigestEntry; last: DigestEntry; count: number }> }>();
  for (const e of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
    let p = plants.get(e.mac);
    if (!p) plants.set(e.mac, (p = { name: e.plant, problems: new Map() }));
    p.name = e.plant; // latest name wins if renamed
    const g = p.problems.get(e.problem);
    if (g) {
      g.last = e;
      g.count++;
    } else p.problems.set(e.problem, { first: e, last: e, count: 1 });
  }

  let total = 0;
  let open = 0;
  const blocks: string[] = [];
  for (const [mac, p] of plants) {
    const lines = [p.name];
    for (const [problem, g] of p.problems) {
      total++;
      const stillOpen = isOpen(mac, problem);
      if (stillOpen) open++;
      const times = g.count > 1 ? `${g.count} times, first ${formatTime(g.first.createdAt)}` : `since ${formatTime(g.first.createdAt)}`;
      lines.push(`• ${g.last.detail} (${times}; ${stillOpen ? 'still ongoing' : 'resolved now'})`);
    }
    blocks.push(lines.join('\n'));
  }

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const summary = open === total ? '' : open === 0 ? ' (all resolved)' : ` (${open} still ongoing)`;
  return {
    title: `🪴 Plant digest: ${plural(total, 'problem')} on ${plural(plants.size, 'plant')}${summary}`,
    message: blocks.join('\n\n'),
  };
}
