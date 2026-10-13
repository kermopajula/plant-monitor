// Range checks and plant status.

export type Metric = 'moisture' | 'conductivity' | 'lux' | 'temperature';
export const METRICS: readonly Metric[] = ['moisture', 'conductivity', 'lux', 'temperature'];

export interface Range {
  min: number | null;
  max: number | null;
}
export type Ranges = Record<Metric, Range>;

export type Level = 'low' | 'ok' | 'high' | 'unknown';

export type Problem =
  | 'needs_water'
  | 'too_wet'
  | 'needs_fertilizer'
  | 'too_much_fertilizer'
  | 'too_dark'
  | 'too_bright'
  | 'too_cold'
  | 'too_hot'
  | 'offline';

export const PROBLEM_LABELS: Record<Problem, string> = {
  needs_water: 'Needs water',
  too_wet: 'Too wet',
  needs_fertilizer: 'Needs fertilizer',
  too_much_fertilizer: 'Too much fertilizer',
  too_dark: 'Too dark',
  too_bright: 'Too bright',
  too_cold: 'Too cold',
  too_hot: 'Too hot',
  offline: 'No recent data',
};

const PROBLEM_BY_LEVEL: Record<Metric, { low: Problem; high: Problem }> = {
  moisture: { low: 'needs_water', high: 'too_wet' },
  conductivity: { low: 'needs_fertilizer', high: 'too_much_fertilizer' },
  lux: { low: 'too_dark', high: 'too_bright' },
  temperature: { low: 'too_cold', high: 'too_hot' },
};

/** Generic houseplant ranges, used until a species or custom ranges are set. */
export const DEFAULT_RANGES: Ranges = {
  moisture: { min: 15, max: 60 },
  conductivity: { min: 350, max: 2000 },
  lux: { min: 1500, max: 40000 },
  temperature: { min: 10, max: 32 },
};

export function checkRange(value: number | null | undefined, range: Range | undefined): Level {
  if (value == null || Number.isNaN(value) || !range) return 'unknown';
  if (range.min == null && range.max == null) return 'unknown';
  if (range.min != null && value < range.min) return 'low';
  if (range.max != null && value > range.max) return 'high';
  return 'ok';
}

export function hasAnyRange(r: Partial<Ranges> | null | undefined): boolean {
  return !!r && METRICS.some((m) => r[m]?.min != null || r[m]?.max != null);
}

export interface StatusInput {
  values: Partial<Record<Metric, number | null>>;
  /**
   * Highest lux of the last 24 h. Light is judged on this instead of the
   * current value, otherwise every plant would be "too dark" at night.
   */
  lightPeak24h?: number | null;
  ranges: Ranges;
  /** Timestamp (ms) of the latest reading, or null if there is none. */
  lastReadingAt: number | null;
  now: number;
  staleAfterMs: number;
}

export interface StatusResult {
  status: 'ok' | 'problem' | 'offline' | 'unknown';
  problems: Problem[];
  levels: Record<Metric, Level>;
  label: string;
}

export function evaluateStatus(input: StatusInput): StatusResult {
  const levels = {} as Record<Metric, Level>;
  for (const m of METRICS) {
    const v = m === 'lux' && input.lightPeak24h != null ? input.lightPeak24h : input.values[m];
    levels[m] = checkRange(v, input.ranges[m]);
  }

  if (input.lastReadingAt == null || input.now - input.lastReadingAt > input.staleAfterMs) {
    return { status: 'offline', problems: ['offline'], levels, label: PROBLEM_LABELS.offline };
  }

  const problems: Problem[] = [];
  for (const m of METRICS) {
    const l = levels[m];
    if (l === 'low' || l === 'high') problems.push(PROBLEM_BY_LEVEL[m][l]);
  }
  if (problems.length) {
    return { status: 'problem', problems, levels, label: problems.map((p) => PROBLEM_LABELS[p]).join(', ') };
  }
  if (METRICS.every((m) => levels[m] === 'unknown')) {
    return { status: 'unknown', problems, levels, label: 'Unknown' };
  }
  return { status: 'ok', problems, levels, label: 'OK' };
}
