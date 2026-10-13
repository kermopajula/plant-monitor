import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMiFlora, normalizeMac, parseFirmwareBattery, parseMiBeacon, parseRealtimeData } from '../src/lib/miflora';
import { rangesFromPlantbook } from '../src/lib/plantbook';

/** MiBeacon frame as sent by Mi Flora: frame control 0x2071, product 0x0098, MAC, capability, one object. */
function beacon(type: number, data: number[]): Buffer {
  const mac = [0x01, 0x02, 0x03, 0x8d, 0x7c, 0xc4]; // C4:7C:8D:03:02:01, little endian
  return Buffer.from([0x71, 0x20, 0x98, 0x00, 0x2a, ...mac, 0x0d, type & 0xff, type >> 8, data.length, ...data]);
}

describe('parseMiBeacon', () => {
  it('reads the header and MAC', () => {
    const b = parseMiBeacon(beacon(0x1008, [42]))!;
    assert.equal(b.productId, 0x0098);
    assert.equal(b.frameCounter, 0x2a);
    assert.equal(b.mac, 'C4:7C:8D:03:02:01');
    assert.equal(b.encrypted, false);
  });
  it('decodes temperature (signed, 0.1 °C)', () => {
    assert.equal(parseMiBeacon(beacon(0x1004, [0xd2, 0x00]))!.values.temperature, 21);
    assert.equal(parseMiBeacon(beacon(0x1004, [0xce, 0xff]))!.values.temperature, -5);
  });
  it('decodes light as 24-bit lux', () => {
    assert.equal(parseMiBeacon(beacon(0x1007, [0x40, 0xe2, 0x01]))!.values.lux, 123456);
  });
  it('decodes moisture, conductivity and battery', () => {
    assert.equal(parseMiBeacon(beacon(0x1008, [37]))!.values.moisture, 37);
    assert.equal(parseMiBeacon(beacon(0x1009, [0x5e, 0x01]))!.values.conductivity, 350);
    assert.equal(parseMiBeacon(beacon(0x100a, [88]))!.values.battery, 88);
  });
  it('ignores frames without an object', () => {
    const b = parseMiBeacon(Buffer.from([0x31, 0x20, 0x98, 0x00, 0x01, 1, 2, 3, 4, 5, 6, 0x0d]))!;
    assert.deepEqual(b.values, {});
  });
  it('rejects truncated frames', () => {
    assert.equal(parseMiBeacon(Buffer.from([0x71, 0x20])), null);
    assert.equal(parseMiBeacon(Buffer.from([0x71, 0x20, 0x98, 0x00, 0x01, 0x02])), null);
    // object header claims 2 bytes, only 1 present
    assert.deepEqual(parseMiBeacon(beacon(0x1004, [0xd2]).subarray(0, 15))?.values, {});
  });
});

describe('isMiFlora', () => {
  it('matches by name, product id or MAC prefix', () => {
    assert.ok(isMiFlora({ localName: 'Flower care' }));
    assert.ok(isMiFlora({ serviceData: [{ uuid: 'fe95', data: beacon(0x1008, [1]) }] }));
    assert.ok(isMiFlora({ address: 'c4:7c:8d:aa:bb:cc' }));
    assert.ok(!isMiFlora({ address: '11:22:33:44:55:66', localName: 'Speaker' }));
  });
  it('normalizes MAC formats', () => {
    assert.equal(normalizeMac('c47c8daabbcc'), 'C4:7C:8D:AA:BB:CC');
    assert.equal(normalizeMac('c4:7c:8d:aa:bb:cc'), 'C4:7C:8D:AA:BB:CC');
  });
});

describe('GATT payloads', () => {
  it('parses battery and firmware from handle 0x38', () => {
    const buf = Buffer.concat([Buffer.from([0x63, 0x15]), Buffer.from('3.2.1', 'ascii')]);
    assert.deepEqual(parseFirmwareBattery(buf), { battery: 99, firmware: '3.2.1' });
  });
  it('parses realtime data from handle 0x35', () => {
    // 22.5 °C, lux 1500, moisture 33, conductivity 420
    const buf = Buffer.from([0xe1, 0x00, 0x00, 0xdc, 0x05, 0x00, 0x00, 0x21, 0xa4, 0x01, 0x02, 0x3c, 0, 0, 0, 0]);
    assert.deepEqual(parseRealtimeData(buf), { temperature: 22.5, lux: 1500, moisture: 33, conductivity: 420 });
  });
  it('rejects placeholder data returned without the mode change', () => {
    const buf = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x99, 0x88, 0x77, 0x66, 0, 0, 0, 0, 0, 0]);
    assert.throws(() => parseRealtimeData(buf), /mode change/);
  });
  it('rejects implausible readings', () => {
    const buf = Buffer.from([0xe1, 0x00, 0x00, 0xdc, 0x05, 0x00, 0x00, 0xff, 0xa4, 0x01]);
    assert.throws(() => parseRealtimeData(buf), /implausible/);
  });
});

describe('rangesFromPlantbook', () => {
  it('maps Open Plant Book fields and drops missing ones', () => {
    const r = rangesFromPlantbook({
      pid: 'monstera deliciosa',
      display_pid: 'Monstera deliciosa',
      alias: 'monstera',
      min_soil_moist: 15,
      max_soil_moist: 60,
      min_soil_ec: 350,
      max_soil_ec: 2000,
      min_light_lux: 2500,
      max_light_lux: 30000,
      min_temp: 12,
      max_temp: null,
    });
    assert.deepEqual(r, {
      moisture: { min: 15, max: 60 },
      conductivity: { min: 350, max: 2000 },
      lux: { min: 2500, max: 30000 },
      temperature: { min: 12, max: null },
    });
  });
});
