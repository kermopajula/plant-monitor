import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/db';
import { buildDigest, digestDue, localDayKey, parseTimeOfDay, type DigestEntry } from '../src/lib/digest';
import type { Notification, Notifier } from '../src/lib/notifiers';
import { Alerter } from '../src/web/alerter';

const at = (h: number, m = 0, day = 13) => new Date(2026, 9, day, h, m).getTime(); // local time

describe('parseTimeOfDay', () => {
  it('parses HH:MM', () => {
    assert.deepEqual(parseTimeOfDay('08:00'), { hour: 8, minute: 0 });
    assert.deepEqual(parseTimeOfDay(' 7:45 '), { hour: 7, minute: 45 });
  });
  it('rejects invalid times', () => {
    for (const s of ['24:00', '8', '08:60', 'eight', '']) assert.throws(() => parseTimeOfDay(s), /HH:MM/, s);
  });
});

describe('digestDue', () => {
  const eight = { hour: 8, minute: 0 };
  it('is not due before the configured time', () => {
    assert.equal(digestDue(at(7, 59), null, eight), false);
  });
  it('is due from the configured time until sent that day', () => {
    assert.equal(digestDue(at(8, 0), null, eight), true);
    assert.equal(digestDue(at(15, 30), localDayKey(at(1)), eight), false === false && localDayKey(at(1)) === localDayKey(at(15, 30)) ? false : true);
    assert.equal(digestDue(at(15, 30), localDayKey(at(8, 1, 12)), eight), true); // yesterday's was sent
  });
  it('catches up later in the day if the Pi was off at that time', () => {
    assert.equal(digestDue(at(14, 0), localDayKey(at(9, 0, 12)), eight), true);
  });
});

describe('buildDigest', () => {
  const e = (id: number, mac: string, plant: string, problem: DigestEntry['problem'], detail: string, h: number): DigestEntry => ({
    id, mac, plant, problem, detail, createdAt: at(h),
  });
  const fmt = (ts: number) => `${new Date(ts).getHours()}h`;

  it('returns null when nothing is queued', () => {
    assert.equal(buildDigest([], () => true), null);
  });

  it('groups problems by plant and marks their current state', () => {
    const d = buildDigest(
      [
        e(1, 'A', 'Monstera', 'needs_water', 'Needs water: 12%', 9),
        e(2, 'B', 'Fern', 'too_dark', 'Too dark: 900 lx', 10),
        e(3, 'A', 'Monstera', 'too_hot', 'Too hot: 34 °C', 11),
      ],
      (mac, p) => !(mac === 'A' && p === 'too_hot'),
      fmt,
    )!;
    assert.equal(d.title, '🪴 Plant digest: 3 problems on 2 plants (2 still ongoing)');
    assert.equal(
      d.message,
      'Monstera\n• Needs water: 12% (since 9h; still ongoing)\n• Too hot: 34 °C (since 11h; resolved now)\n\nFern\n• Too dark: 900 lx (since 10h; still ongoing)',
    );
  });

  it('merges repeats of the same problem', () => {
    const d = buildDigest(
      [e(1, 'A', 'Basil', 'needs_water', 'Needs water: 14%', 9), e(2, 'A', 'Basil', 'needs_water', 'Needs water: 11%', 18)],
      () => false,
      fmt,
    )!;
    assert.equal(d.title, '🪴 Plant digest: 1 problem on 1 plant (all resolved)');
    assert.equal(d.message, 'Basil\n• Needs water: 11% (2 times, first 9h; resolved now)');
  });
});

describe('Alerter with a daily digest channel', () => {
  class Recorder implements Notifier {
    sent: Notification[] = [];
    constructor(readonly name: string, readonly digest = false) {}
    async send(n: Notification) {
      this.sent.push(n);
    }
  }

  it('sends ntfy/webhook immediately and email once a day with everything aggregated', async () => {
    const store = new Store(':memory:');
    store.setSetting('alert_after_minutes', 0);
    for (const [mac, name] of [['A', 'Monstera'], ['B', 'Fern']]) {
      store.markSeen(mac, at(6), -60, null);
      store.updateSensor(mac, { adopted: 1, name });
    }
    const instant = new Recorder('ntfy');
    const email = new Recorder('resend', true);
    const alerter = new Alerter(store, [instant, email]);
    const dry = { moisture: 5, conductivity: 800, lux: 5000, temperature: 21 };

    store.insertReading('A', at(6, 50), dry, 'passive');
    store.insertReading('B', at(6, 50), { ...dry, moisture: 40 }, 'passive'); // Fern fine for now
    await alerter.check(at(7)); // before 08:00: Monstera needs water
    store.insertReading('B', at(7, 20), { ...dry, temperature: 40 }, 'passive');
    await alerter.check(at(7, 30)); // Fern needs water and is too hot

    assert.equal(instant.sent.length, 2, 'one immediate message per plant');
    assert.equal(email.sent.length, 0, 'no email before the digest time');
    assert.equal(store.digestQueue().length, 3);

    store.insertReading('A', at(8, 0), dry, 'passive');
    store.insertReading('B', at(8, 0), { ...dry, temperature: 40 }, 'passive');
    await alerter.check(at(8, 5));
    assert.equal(email.sent.length, 1, 'one digest email');
    assert.match(email.sent[0].title, /3 problems on 2 plants/);
    assert.match(email.sent[0].message, /Monstera\n• Needs water: 5%/);
    assert.match(email.sent[0].message, /Fern\n• Needs water: 5%.*\n• Too hot: 40/);
    assert.equal(store.digestQueue().length, 0);

    // Same problems persisting, later that day: nothing new anywhere.
    store.insertReading('A', at(12), dry, 'passive');
    store.insertReading('B', at(12), { ...dry, temperature: 40 }, 'passive');
    await alerter.check(at(12, 5));
    assert.equal(email.sent.length, 1);
    assert.equal(instant.sent.length, 2);
    store.close();
  });

  it('keeps the queue and retries when the email fails', async () => {
    const store = new Store(':memory:');
    store.setSetting('alert_after_minutes', 0);
    store.markSeen('A', at(6), -60, null);
    store.updateSensor('A', { adopted: 1, name: 'Monstera' });
    store.insertReading('A', at(8, 50), { moisture: 5, conductivity: 800, lux: 5000, temperature: 21 }, 'passive');
    let fail = true;
    const sent: Notification[] = [];
    const email: Notifier = { name: 'resend', digest: true, send: async (n) => { if (fail) throw new Error('down'); sent.push(n); } };
    const alerter = new Alerter(store, [email]);

    await alerter.check(at(9));
    assert.equal(sent.length, 0);
    assert.equal(store.digestQueue().length, 1, 'still queued after a failed send');
    fail = false;
    await alerter.check(at(9, 5));
    assert.equal(sent.length, 1);
    assert.equal(store.digestQueue().length, 0);
    store.close();
  });
});
