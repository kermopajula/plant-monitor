import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/db';
import type { Notification, Notifier } from '../src/lib/notifiers';
import { formatQuietHours, isQuietTime, parseQuietHours } from '../src/lib/quiet-hours';
import { Alerter } from '../src/web/alerter';

const at = (h: number, m = 0, day = 20) => new Date(2026, 9, day, h, m).getTime(); // local time

describe('quiet hours', () => {
  it('parses ranges and "off"', () => {
    assert.deepEqual(parseQuietHours('21:00-08:00'), { start: { hour: 21, minute: 0 }, end: { hour: 8, minute: 0 } });
    assert.equal(parseQuietHours(' 21:00 - 7:30 ') && formatQuietHours(parseQuietHours(' 21:00 - 7:30 ')), '21:00-07:30');
    assert.equal(parseQuietHours('off'), null);
    assert.equal(parseQuietHours(''), null);
    assert.equal(formatQuietHours(null), 'off');
  });
  it('rejects invalid input', () => {
    for (const s of ['21-8', '25:00-08:00', '21:00', '08:00-08:00']) assert.throws(() => parseQuietHours(s), Error, s);
  });
  it('handles ranges across midnight (start inclusive, end exclusive)', () => {
    const q = parseQuietHours('21:00-08:00');
    assert.equal(isQuietTime(at(20, 59), q), false);
    assert.equal(isQuietTime(at(21, 0), q), true);
    assert.equal(isQuietTime(at(23, 30), q), true);
    assert.equal(isQuietTime(at(3), q), true);
    assert.equal(isQuietTime(at(7, 59), q), true);
    assert.equal(isQuietTime(at(8, 0), q), false);
    assert.equal(isQuietTime(at(12), q), false);
  });
  it('handles same-day ranges', () => {
    const q = parseQuietHours('13:00-15:00');
    assert.equal(isQuietTime(at(14), q), true);
    assert.equal(isQuietTime(at(16), q), false);
    assert.equal(isQuietTime(at(14), null), false);
  });
});

describe('Alerter during quiet hours', () => {
  class Recorder implements Notifier {
    sent: Notification[] = [];
    constructor(readonly name: string, readonly digest = false) {}
    async send(n: Notification) {
      this.sent.push(n);
    }
  }
  const dry = { moisture: 5, conductivity: 800, lux: 5000, temperature: 21 };

  function setup() {
    const store = new Store(':memory:');
    store.setSetting('alert_after_minutes', 0);
    store.setSetting('quiet_hours', '21:00-08:00');
    for (const [mac, name] of [['A', 'Monstera'], ['B', 'Fern']]) {
      store.markSeen(mac, at(20), -60, null);
      store.updateSensor(mac, { adopted: 1, name });
    }
    return store;
  }

  it('holds alerts at night and sends one summary when quiet hours end', async () => {
    const store = setup();
    const ntfy = new Recorder('ntfy');
    const alerter = new Alerter(store, [ntfy]);

    store.insertReading('A', at(22, 50), dry, 'passive');
    store.insertReading('B', at(22, 50), { ...dry, moisture: 40 }, 'passive');
    await alerter.check(at(23)); // Monstera needs water, at night
    store.insertReading('A', at(2, 50, 21), dry, 'passive');
    store.insertReading('B', at(2, 50, 21), { ...dry, moisture: 40, temperature: 40 }, 'passive');
    await alerter.check(at(3, 0, 21)); // Fern too hot, still night
    assert.equal(ntfy.sent.length, 0, 'nothing sent during quiet hours');

    store.insertReading('A', at(7, 55, 21), dry, 'passive');
    store.insertReading('B', at(7, 55, 21), { ...dry, moisture: 40 }, 'passive'); // Fern fine again
    await alerter.check(at(8, 0, 21));
    assert.equal(ntfy.sent.length, 1, 'one summary in the morning');
    assert.match(ntfy.sent[0].title, /^🌅 While you slept: 2 problems on 2 plants \(1 still ongoing\)/);
    assert.match(ntfy.sent[0].message, /Monstera\n• Needs water: 5%.*still ongoing/);
    assert.match(ntfy.sent[0].message, /Fern\n• Too hot: 40.*resolved now/);

    await alerter.check(at(8, 5, 21));
    assert.equal(ntfy.sent.length, 1, 'held alerts are sent only once');

    store.insertReading('A', at(9, 55, 21), { ...dry, temperature: 40 }, 'passive');
    store.insertReading('B', at(9, 55, 21), { ...dry, moisture: 40 }, 'passive');
    await alerter.check(at(10, 0, 21));
    assert.equal(ntfy.sent.length, 2, 'daytime alerts go out right away again');
    assert.match(ntfy.sent[1].title, /Monstera: Too hot/);
    store.close();
  });

  it('does not delay the daily email digest', async () => {
    const store = setup();
    const ntfy = new Recorder('ntfy');
    const email = new Recorder('resend', true);
    const alerter = new Alerter(store, [ntfy, email]);
    store.setSetting('digest_last_day', '2026-10-20'); // today's email already went out this morning
    store.insertReading('A', at(22, 50), dry, 'passive');
    store.insertReading('B', at(22, 50), { ...dry, moisture: 40 }, 'passive');
    await alerter.check(at(23));
    assert.equal(store.digestQueue('daily').length, 1, 'queued for the email digest as usual');
    assert.equal(store.digestQueue('quiet').length, 1, 'held for ntfy');
    store.close();
  });

  it('sends right away when quiet hours are off', async () => {
    const store = setup();
    store.setSetting('quiet_hours', 'off');
    const ntfy = new Recorder('ntfy');
    store.insertReading('A', at(22, 50), dry, 'passive');
    store.insertReading('B', at(22, 50), { ...dry, moisture: 40 }, 'passive');
    await new Alerter(store, [ntfy]).check(at(23));
    assert.equal(ntfy.sent.length, 1);
    store.close();
  });
});
