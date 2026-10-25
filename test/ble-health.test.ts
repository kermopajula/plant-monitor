import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BleHealth } from '../src/lib/ble-health';

const ok = { adopted: 2, heardAdopted: 2, stopTimedOut: false };

describe('BleHealth', () => {
  it('stays quiet while sensors are heard', () => {
    const h = new BleHealth();
    for (let i = 0; i < 5; i++) assert.equal(h.record(ok), null);
  });
  it('tolerates one sensor missing (weak signal)', () => {
    const h = new BleHealth();
    for (let i = 0; i < 5; i++) assert.equal(h.record({ ...ok, heardAdopted: 1 }), null);
  });
  it('flags two silent scans in a row', () => {
    const h = new BleHealth();
    assert.equal(h.record({ ...ok, heardAdopted: 0 }), null);
    assert.match(h.record({ ...ok, heardAdopted: 0 }) ?? '', /no sensor heard/);
  });
  it('resets the count when a sensor is heard again', () => {
    const h = new BleHealth();
    h.record({ ...ok, heardAdopted: 0 });
    h.record(ok);
    assert.equal(h.record({ ...ok, heardAdopted: 0 }), null);
  });
  it('flags repeated stop-scan timeouts even while sensors still trickle in', () => {
    const h = new BleHealth();
    assert.equal(h.record({ ...ok, stopTimedOut: true }), null);
    assert.match(h.record({ ...ok, heardAdopted: 1, stopTimedOut: true }) ?? '', /stopping the scan/);
  });
  it('ignores silence when no sensor is adopted', () => {
    const h = new BleHealth();
    for (let i = 0; i < 5; i++) assert.equal(h.record({ adopted: 0, heardAdopted: 0, stopTimedOut: false }), null);
  });
});
