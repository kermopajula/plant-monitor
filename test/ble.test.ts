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

import type * as BleModule from '../src/collector/ble';
const ble = require('../src/collector/ble') as typeof BleModule;

const FW_BATTERY = Buffer.concat([Buffer.from([87, 0x15]), Buffer.from('3.3.5', 'ascii')]);
// 22.5 °C, 1500 lx, 33 %, 420 µS/cm
const DATA = Buffer.from([0xe1, 0x00, 0x00, 0xdc, 0x05, 0x00, 0x00, 0x21, 0xa4, 0x01, 0x02, 0x3c, 0, 0, 0, 0]);

/** Fake Mi Flora. `handlesWork: false` behaves like a sensor that answers handle reads with an error. */
function fakeSensor(mac: string, opts: { handlesWork: boolean; chars?: Record<string, Buffer>; serviceUuid?: string }) {
  const calls: string[] = [];
  const chars = Object.entries(opts.chars ?? { '1a00': Buffer.alloc(0), '1a01': DATA, '1a02': FW_BATTERY }).map(([uuid, value]) => ({
    uuid,
    properties: ['read', 'write'],
    readAsync: async () => (calls.push(`char:${uuid}`), value),
    writeAsync: async () => void calls.push(`write:${uuid}`),
  }));
  const handles: Record<number, Buffer> = { 0x35: DATA, 0x38: FW_BATTERY };
  const p = {
    address: mac.toLowerCase(),
    rssi: -55,
    advertisement: { localName: 'Flower care', serviceData: [] },
    connectAsync: async () => void calls.push('connect'),
    disconnectAsync: async () => void calls.push('disconnect'),
    cancelConnect: () => {},
    readHandleAsync: async (h: number) => (calls.push(`handle:${h}`), opts.handlesWork ? handles[h] : Buffer.alloc(0)),
    writeHandleAsync: async (h: number) => void calls.push(`whandle:${h}`),
    discoverAllServicesAndCharacteristicsAsync: async () => {
      calls.push('discover');
      return { services: [{ uuid: opts.serviceUuid ?? '1204', characteristics: chars }], characteristics: chars };
    },
  };
  return { p, calls };
}

/** Runs a short scan during which the given peripherals advertise. */
async function discovered(scanner: BleModule.FloraBle, ...ps: object[]) {
  const scan = scanner.scan(50, () => false);
  await new Promise((r) => setImmediate(r));
  for (const p of ps) fake.emit('discover', p);
  await scan;
}

describe('ble module', () => {
  it('uses the noble instance itself, including prototype methods', async () => {
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

describe('FloraBle.poll', () => {
  it('reads battery and firmware by handle when that works', async () => {
    const scanner = new ble.FloraBle({ connectMs: 100, gattMs: 100 });
    const s = fakeSensor('C4:7C:8D:00:00:01', { handlesWork: true });
    await discovered(scanner, s.p);
    const r = await scanner.poll('C4:7C:8D:00:00:01', false, null);
    assert.deepEqual(r, { battery: 87, firmware: '3.3.5', infoError: null, values: null });
    assert.deepEqual(s.calls, ['connect', 'handle:56', 'disconnect']);
  });

  it('falls back to characteristics when a handle returns no data, and remembers it', async () => {
    const scanner = new ble.FloraBle({ connectMs: 100, gattMs: 100 });
    const s = fakeSensor('C4:7C:8D:00:00:02', { handlesWork: false });
    await discovered(scanner, s.p);
    const r = await scanner.poll('C4:7C:8D:00:00:02', true, null);
    assert.equal(r.battery, 87);
    assert.equal(r.firmware, '3.3.5');
    assert.deepEqual(r.values, { temperature: 22.5, lux: 1500, moisture: 33, conductivity: 420 });
    assert.deepEqual(s.calls, ['connect', 'handle:56', 'discover', 'char:1a02', 'write:1a00', 'char:1a01', 'disconnect']);

    s.calls.length = 0;
    await scanner.poll('C4:7C:8D:00:00:02', false, '3.3.5');
    assert.deepEqual(s.calls, ['connect', 'discover', 'char:1a02', 'disconnect'], 'goes straight to characteristics');
  });

  it('reports what the sensor exposes when the characteristic is missing', async () => {
    const scanner = new ble.FloraBle({ connectMs: 100, gattMs: 100 });
    const s = fakeSensor('C4:7C:8D:00:00:03', { handlesWork: false, chars: { '1a11': Buffer.from([1]) } });
    await discovered(scanner, s.p);
    await assert.rejects(scanner.poll('C4:7C:8D:00:00:03', false, null), /1a02 not found in service 1204 \(found: 1a11\)/);
    assert.equal(s.calls.at(-1), 'disconnect');
  });

  it('explains a sensor without the Mi Flora data service, without retrying pointlessly', async () => {
    const { GattLayoutError } = require('../src/lib/miflora') as typeof import('../src/lib/miflora');
    const scanner = new ble.FloraBle({ connectMs: 100, gattMs: 100 });
    const s = fakeSensor('5C:85:7E:00:00:05', { handlesWork: false, serviceUuid: 'fe95', chars: { '0004': Buffer.from([1]) } });
    await discovered(scanner, s.p);
    await assert.rejects(scanner.poll('5C:85:7E:00:00:05', false, null), (e: Error) => {
      assert.ok(e instanceof GattLayoutError);
      assert.match(e.message, /no Mi Flora data service 1204; it offers: fe95 \[0004\(read\/write\)\]/);
      return true;
    });
  });

  it('still returns readings when only battery/firmware fail', async () => {
    const scanner = new ble.FloraBle({ connectMs: 100, gattMs: 100 });
    const s = fakeSensor('C4:7C:8D:00:00:04', { handlesWork: false, chars: { '1a00': Buffer.alloc(0), '1a01': DATA } });
    await discovered(scanner, s.p);
    const r = await scanner.poll('C4:7C:8D:00:00:04', true, '2.7.0');
    assert.equal(r.battery, null);
    assert.match(r.infoError ?? '', /1a02 not found/);
    assert.equal(r.values?.moisture, 33);
  });
});
