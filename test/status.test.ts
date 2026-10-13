import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRange, DEFAULT_RANGES, evaluateStatus, hasAnyRange, type Ranges, type StatusInput } from '../src/lib/status';

describe('checkRange', () => {
  const r = { min: 15, max: 60 };
  it('classifies low / ok / high', () => {
    assert.equal(checkRange(10, r), 'low');
    assert.equal(checkRange(30, r), 'ok');
    assert.equal(checkRange(61, r), 'high');
  });
  it('treats the bounds as inclusive', () => {
    assert.equal(checkRange(15, r), 'ok');
    assert.equal(checkRange(60, r), 'ok');
  });
  it('supports open-ended ranges', () => {
    assert.equal(checkRange(1000, { min: 10, max: null }), 'ok');
    assert.equal(checkRange(5, { min: 10, max: null }), 'low');
    assert.equal(checkRange(-5, { min: null, max: 30 }), 'ok');
  });
  it('is unknown without a value or a range', () => {
    assert.equal(checkRange(null, r), 'unknown');
    assert.equal(checkRange(undefined, r), 'unknown');
    assert.equal(checkRange(NaN, r), 'unknown');
    assert.equal(checkRange(20, { min: null, max: null }), 'unknown');
    assert.equal(checkRange(20, undefined), 'unknown');
  });
  it('handles zero values correctly', () => {
    assert.equal(checkRange(0, r), 'low');
    assert.equal(checkRange(0, { min: 0, max: 10 }), 'ok');
  });
});

describe('hasAnyRange', () => {
  it('detects whether any bound is set', () => {
    const empty = {
      moisture: { min: null, max: null },
      conductivity: { min: null, max: null },
      lux: { min: null, max: null },
      temperature: { min: null, max: null },
    };
    assert.equal(hasAnyRange(empty), false);
    assert.equal(hasAnyRange({ ...empty, lux: { min: 0, max: null } }), true);
    assert.equal(hasAnyRange(null), false);
  });
});

describe('evaluateStatus', () => {
  const now = 1_700_000_000_000;
  const ranges: Ranges = {
    moisture: { min: 15, max: 60 },
    conductivity: { min: 350, max: 2000 },
    lux: { min: 1500, max: 40000 },
    temperature: { min: 10, max: 32 },
  };
  const base: StatusInput = {
    values: { moisture: 40, conductivity: 800, lux: 3000, temperature: 21 },
    lightPeak24h: 12000,
    ranges,
    lastReadingAt: now - 60_000,
    now,
    staleAfterMs: 3600_000,
  };
  const status = (o: Partial<StatusInput> & { values?: StatusInput['values'] }) =>
    evaluateStatus({ ...base, ...o, values: { ...base.values, ...o.values } });

  it('is OK when everything is in range', () => {
    const s = status({});
    assert.equal(s.status, 'ok');
    assert.equal(s.label, 'OK');
    assert.deepEqual(s.problems, []);
  });

  it('maps each metric to its problem', () => {
    assert.deepEqual(status({ values: { moisture: 5 } }).problems, ['needs_water']);
    assert.deepEqual(status({ values: { moisture: 80 } }).problems, ['too_wet']);
    assert.deepEqual(status({ values: { conductivity: 100 } }).problems, ['needs_fertilizer']);
    assert.deepEqual(status({ values: { conductivity: 3000 } }).problems, ['too_much_fertilizer']);
    assert.deepEqual(status({ lightPeak24h: 500 }).problems, ['too_dark']);
    assert.deepEqual(status({ lightPeak24h: 90000 }).problems, ['too_bright']);
    assert.deepEqual(status({ values: { temperature: 5 } }).problems, ['too_cold']);
    assert.deepEqual(status({ values: { temperature: 35 } }).problems, ['too_hot']);
  });

  it('labels a problem in plain words', () => {
    const s = status({ values: { moisture: 5 } });
    assert.equal(s.status, 'problem');
    assert.equal(s.label, 'Needs water');
  });

  it('reports multiple problems together', () => {
    const s = status({ values: { moisture: 5, temperature: 40 } });
    assert.deepEqual(s.problems, ['needs_water', 'too_hot']);
    assert.equal(s.label, 'Needs water, Too hot');
  });

  it('judges light on the 24 h peak, so night time is not "too dark"', () => {
    const night = status({ values: { lux: 0 }, lightPeak24h: 12000 });
    assert.equal(night.status, 'ok');
    assert.equal(night.levels.lux, 'ok');
  });

  it('falls back to the current lux when there is no peak', () => {
    assert.deepEqual(status({ values: { lux: 100 }, lightPeak24h: null }).problems, ['too_dark']);
  });

  it('is offline when there is no recent reading', () => {
    assert.equal(status({ lastReadingAt: null }).status, 'offline');
    const stale = status({ lastReadingAt: now - 2 * 3600_000, values: { moisture: 5 } });
    assert.equal(stale.status, 'offline');
    assert.deepEqual(stale.problems, ['offline']);
  });

  it('ignores missing values instead of flagging them', () => {
    const s = status({ values: { moisture: null, conductivity: null } });
    assert.equal(s.status, 'ok');
    assert.equal(s.levels.moisture, 'unknown');
  });

  it('is unknown when nothing can be judged', () => {
    const s = evaluateStatus({ ...base, values: {}, lightPeak24h: null });
    assert.equal(s.status, 'unknown');
  });

  it('works with the default ranges', () => {
    assert.equal(evaluateStatus({ ...base, ranges: DEFAULT_RANGES }).status, 'ok');
  });
});
