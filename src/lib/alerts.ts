// Alert state machine: notify once a problem has persisted for `holdMs`,
// never repeat while it persists, and only forget it after it has been
// clear for `holdMs` too (so a value hovering around a limit does not re-alert).

import type { Problem } from './status';

export interface AlertState {
  mac: string;
  problem: Problem;
  since: number;
  notifiedAt: number | null;
  clearedSince: number | null;
}

export interface AlertPlan {
  /** New state for this sensor (replaces the old rows). */
  state: AlertState[];
  /** Problems that should be notified now. */
  notify: AlertState[];
  /** Previously notified problems that are now resolved. */
  resolved: AlertState[];
}

export function planAlerts(
  mac: string,
  existing: AlertState[],
  current: Problem[],
  now: number,
  holdMs: number,
): AlertPlan {
  const state: AlertState[] = [];
  const notify: AlertState[] = [];
  const resolved: AlertState[] = [];
  const byProblem = new Map(existing.filter((a) => a.mac === mac).map((a) => [a.problem, a]));

  for (const problem of new Set(current)) {
    const prev = byProblem.get(problem);
    const rec: AlertState = prev
      ? { ...prev, clearedSince: null }
      : { mac, problem, since: now, notifiedAt: null, clearedSince: null };
    if (rec.notifiedAt == null && now - rec.since >= holdMs) {
      rec.notifiedAt = now;
      notify.push(rec);
    }
    state.push(rec);
    byProblem.delete(problem);
  }

  for (const prev of byProblem.values()) {
    if (prev.notifiedAt == null) continue; // never alerted: just forget it
    const clearedSince = prev.clearedSince ?? now;
    if (now - clearedSince >= holdMs) resolved.push(prev);
    else state.push({ ...prev, clearedSince });
  }

  return { state, notify, resolved };
}
