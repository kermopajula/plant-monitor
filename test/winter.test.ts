import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/db';
import type { Notification, Notifier } from '../src/lib/notifiers';
import { DEFAULT_RANGES, evaluateStatus, type StatusInput } from '../src/lib/status';
import { formatWinterSeason, isWinter, parseWinterSeason } from '../src/lib/winter';
import { Alerter } from '../src/web/alerter';

const on = (month: number, day: number, h = 12) => new Date(2026, month - 1, day, h).getTime(); // local time

describe('winter season', () => {
  it('parses ranges and "off"', () => {
    assert.deepEqual(parseWinterSeason('10-01..03-01'), { start: { month: 10, day: 1 }, end: { month: 3, day: 1 } });
    assert.equal(formatWinterSeason(parseWinterSeason(' 9-15 .. 3-1 ')), '09-15..03-01');
    assert.equal(parseWinterSeason('off'), null);
    assert.equal(parseWinterSeason(''), null);
    assert.equal(formatWinterSeason(null), 'off');
  });
  it('rejects invalid input', () => {
    for (const s of ['10-01', '13-01..03-01', '02-30..03-01', '10-01..10-01', 'oct..mar']) assert.throws(() => parseWinterSeason(s), Error, s);
  });
  it('handles ranges across New Year (start inclusive, end exclusive)', () => {
    const w = parseWinterSeason('10-01..03-01');
    assert.equal(isWinter(on(9, 30), w), false);
    assert.equal(isWinter(on(10, 1, 0), w), true);
    assert.equal(isWinter(on(12, 31), w), true);
    assert.equal(isWinter(on(2, 28), w), true);
    assert.equal(isWinter(on(3, 1, 0), w), false);
    assert.equal(isWinter(on(7, 1), w), false);
    assert.equal(isWinter(on(12, 1), null), false);
  });
  it('handles same-year ranges', () => {
    const w = parseWinterSeason('11-01..12-15');
    assert.equal(isWinter(on(11, 20), w), true);
    assert.equal(isWinter(on(1, 10), w), false);
  });
});

describe('evaluateStatus in winter', () => {
  const base: StatusInput = {
    values: { moisture: 40, conductivity: 800, lux: 3000, temperature: 21 },
    lightPeak24h: 3000,
    ranges: DEFAULT_RANGES,
    lastReadingAt: 1000,
    now: 1000,
    staleAfterMs: 3600_000,
  };
  const winter = { lightFactor: 0.3 };

  it('does not report low conductivity', () => {
    const s = evaluateStatus({ ...base, values: { ...base.values, conductivity: 100 }, winter });
    assert.equal(s.status, 'ok');
    assert.equal(s.levels.conductivity, 'low');
    assert.deepEqual(evaluateStatus({ ...base, values: { ...base.values, conductivity: 100 } }).problems, ['needs_fertilizer']);
  });
  it('still reports too much fertilizer', () => {
    assert.deepEqual(evaluateStatus({ ...base, values: { ...base.values, conductivity: 3000 }, winter }).problems, ['too_much_fertilizer']);
  });
  it('lowers the light minimum but still reports very dark spots', () => {
    assert.deepEqual(evaluateStatus({ ...base, lightPeak24h: 600 }).problems, ['too_dark']);
    assert.equal(evaluateStatus({ ...base, lightPeak24h: 600, winter }).status, 'ok'); // 600 >= 1500 * 0.3
    assert.deepEqual(evaluateStatus({ ...base, lightPeak24h: 300, winter }).problems, ['too_dark']);
  });
  it('leaves moisture alone', () => {
    assert.deepEqual(evaluateStatus({ ...base, values: { ...base.values, moisture: 5 }, winter }).problems, ['needs_water']);
  });
});

describe('Alerter in winter', () => {
  class Recorder implements Notifier {
    sent: Notification[] = [];
    constructor(readonly name: string, readonly digest = false) {}
    async send(n: Notification) {
      this.sent.push(n);
    }
  }

  function setup() {
    const store = new Store(':memory:');
    store.setSetting('alert_after_minutes', 0);
    store.setSetting('quiet_hours', 'off');
    store.markSeen('A', on(9, 1), -60, null);
    store.updateSensor('A', { adopted: 1, name: 'Monstera' });
    return store;
  }

  it('skips fertilizer and normal winter light, alerts on water and real darkness', async () => {
    const store = setup();
    const ntfy = new Recorder('ntfy');
    const alerter = new Alerter(store, [ntfy]);

    store.insertReading('A', on(11, 20, 11), { moisture: 40, conductivity: 100, lux: 700, temperature: 20 }, 'passive');
    await alerter.check(on(11, 20));
    assert.equal(ntfy.sent.length, 0, 'low fertility and 700 lx are fine in November');

    store.insertReading('A', on(11, 21, 11), { moisture: 5, conductivity: 100, lux: 200, temperature: 20 }, 'passive');
    await alerter.check(on(11, 21));
    assert.equal(ntfy.sent.length, 1);
    assert.equal(ntfy.sent[0].title, '🪴 Monstera: Needs water, Too dark');
    assert.match(ntfy.sent[0].message, /Too dark: 200 lx brightest in 24 h \(ideal 450–40000 lx, winter\)/);
  });

  it('drops an open fertilizer alert when winter starts without a "resolved" message', async () => {
    const store = setup();
    store.setSetting('winter_season', '10-01..03-01');
    const ntfy = new Recorder('ntfy');
    const alerter = new Alerter(store, [ntfy]);

    store.insertReading('A', on(9, 30, 11), { moisture: 40, conductivity: 100, lux: 5000, temperature: 20 }, 'passive');
    await alerter.check(on(9, 30));
    assert.equal(ntfy.sent[0].title, '🪴 Monstera: Needs fertilizer');

    store.insertReading('A', on(10, 1, 11), { moisture: 40, conductivity: 100, lux: 5000, temperature: 20 }, 'passive');
    await alerter.check(on(10, 1));
    assert.deepEqual(store.alertStates('A'), []);
    assert.equal(ntfy.sent.length, 1);
  });
});
