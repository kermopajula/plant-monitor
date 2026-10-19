import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

// Stand-in for @abandonware/noble: like the real one, the module exports an
// instance whose methods are on the prototype, not own properties.
class FakeNoble extends EventEmitter {
  _state = 'poweredOn';
  async startScanningAsync() {}
  async stopScanningAsync() {}
}
const fake = new FakeNoble();
const nobleId = require.resolve('@abandonware/noble');
require.cache[nobleId] = { id: nobleId, filename: nobleId, loaded: true, exports: fake } as unknown as NodeModule;

describe('ble module', () => {
  it('uses the noble instance itself, including prototype methods', async () => {
    const ble = require('../src/collector/ble') as typeof import('../src/collector/ble');
    await ble.waitForPoweredOn(100);
    let lost = '';
    ble.onAdapterLost((s) => (lost = s));
    fake.emit('stateChange', 'poweredOff');
    assert.equal(lost, 'poweredOff');

    const scanner = new ble.FloraBle({ connectMs: 100, gattMs: 100 });
    const seen: string[] = [];
    const scan = scanner.scan(1000, (a) => {
      seen.push(a.mac);
      return true; // stop after the first advert
    });
    await new Promise((r) => setImmediate(r));
    fake.emit('discover', { address: 'c4:7c:8d:01:02:03', rssi: -60, advertisement: { localName: 'Flower care', serviceData: [] } });
    await scan;
    assert.deepEqual(seen, ['C4:7C:8D:01:02:03']);
  });
});
