import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/db';

describe('Store', () => {
  it('merges partial readings into the latest value per metric', () => {
    const s = new Store(':memory:');
    s.markSeen('AA', 0, -50, null);
    s.insertReading('AA', 1000, { temperature: 20, moisture: 30, conductivity: 400, lux: 100 }, 'active');
    s.insertReading('AA', 2000, { temperature: 21 }, 'passive');
    const latest = s.latestValues('AA', 0);
    assert.deepEqual(latest.values, { temperature: 21, moisture: 30, conductivity: 400, lux: 100 });
    assert.equal(latest.at, 2000);
    assert.equal(s.lastReadingAt('AA'), 2000);
    assert.deepEqual(s.latestValues('AA', 3000).values, { temperature: null, moisture: null, conductivity: null, lux: null });
    s.close();
  });

  it('buckets history and keeps settings', () => {
    const s = new Store(':memory:');
    s.insertReading('AA', 0, { moisture: 10, lux: 5 }, 'passive');
    s.insertReading('AA', 500, { moisture: 20, lux: 50 }, 'passive');
    s.insertReading('AA', 1500, { moisture: 30 }, 'passive');
    const h = s.history('AA', 0, 1000);
    assert.deepEqual(h.map((p) => [p.ts, p.moisture, p.lux]), [[0, 15, 50], [1000, 30, null]]);
    assert.equal(s.getNumberSetting('x', 7), 7);
    s.setSetting('x', 12);
    assert.equal(s.getNumberSetting('x', 7), 12);
    s.close();
  });
});
