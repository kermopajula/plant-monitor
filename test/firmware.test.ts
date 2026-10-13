import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  broadcastsBattery,
  broadcastsReadings,
  compareFirmware,
  describeFirmware,
  needsModeChange,
  parseFirmware,
} from '../src/lib/firmware';

describe('parseFirmware', () => {
  it('parses plain and padded versions', () => {
    assert.deepEqual(parseFirmware('3.2.1'), { major: 3, minor: 2, patch: 1, raw: '3.2.1' });
    assert.equal(parseFirmware(' 2.7.0\u0000')?.raw, '2.7.0');
  });
  it('returns null for missing or garbage input', () => {
    assert.equal(parseFirmware(null), null);
    assert.equal(parseFirmware(''), null);
    assert.equal(parseFirmware('abc'), null);
  });
  it('compares numerically, not lexically', () => {
    assert.ok(compareFirmware(parseFirmware('3.10.0')!, parseFirmware('3.2.9')!) > 0);
    assert.equal(compareFirmware(parseFirmware('3.2.1')!, parseFirmware('3.2.1')!), 0);
  });
});

describe('firmware capabilities', () => {
  it('mode change is needed from 2.6.6 and for unknown versions', () => {
    assert.equal(needsModeChange('2.6.2'), false);
    assert.equal(needsModeChange('2.6.6'), true);
    assert.equal(needsModeChange('3.2.1'), true);
    assert.equal(needsModeChange(null), true);
  });
  it('only 3.x broadcasts readings', () => {
    assert.equal(broadcastsReadings('2.7.0'), false);
    assert.equal(broadcastsReadings('3.1.9'), true);
    assert.equal(broadcastsReadings(null), false);
  });
  it('battery is broadcast on 3.x below 3.2.1 only', () => {
    assert.equal(broadcastsBattery('2.7.0'), false);
    assert.equal(broadcastsBattery('3.1.9'), true);
    assert.equal(broadcastsBattery('3.2.0'), true);
    assert.equal(broadcastsBattery('3.2.1'), false);
    assert.equal(broadcastsBattery('3.3.5'), false);
  });
});

describe('describeFirmware', () => {
  it('recommends updating 2.x', () => {
    const info = describeFirmware('2.7.0');
    assert.equal(info.family, '2.x');
    assert.equal(info.advice?.level, 'update-recommended');
    assert.match(info.advice!.message, /passive/);
  });
  it('recommends updating very old 1.x as well', () => {
    assert.equal(describeFirmware('1.9.0').advice?.level, 'update-recommended');
  });
  it('gives no advice for a normal 3.x version', () => {
    const info = describeFirmware('3.2.1');
    assert.equal(info.family, '3.x');
    assert.equal(info.advice, null);
    assert.equal(info.broadcastsReadings, true);
    assert.equal(info.broadcastsBattery, false);
  });
  it('flags 3.2.4 as reportedly flaky', () => {
    assert.equal(describeFirmware('3.2.4').advice?.level, 'caution');
  });
  it('handles unknown firmware', () => {
    const info = describeFirmware(undefined);
    assert.equal(info.version, null);
    assert.equal(info.family, 'unknown');
    assert.equal(info.advice, null);
  });
});
