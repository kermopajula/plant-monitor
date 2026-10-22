import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { currentSensorError, isInfoError, type SensorErrorRow } from '../src/lib/sensor-error';

const row = (p: Partial<SensorErrorRow>): SensorErrorRow => ({
  last_error: null,
  last_error_at: null,
  battery_at: null,
  device_info_at: null,
  ...p,
});

describe('currentSensorError', () => {
  it('returns nothing without an error', () => {
    assert.equal(currentSensorError(row({})), null);
  });
  it('shows a battery/firmware error as low-key while no later read worked', () => {
    const e = currentSensorError(
      row({ last_error: 'Battery/firmware read failed (next try in 6 h): timed out', last_error_at: 100, battery_at: 50, device_info_at: 50 }),
    );
    assert.equal(e?.kind, 'info');
  });
  it('drops a battery/firmware error once a later read worked', () => {
    const msg = 'Battery/firmware read failed (next try in 6 h): timed out';
    assert.equal(currentSensorError(row({ last_error: msg, last_error_at: 100, device_info_at: 120, battery_at: 120 })), null);
    assert.equal(currentSensorError(row({ last_error: msg, last_error_at: 100, device_info_at: 100 })), null);
  });
  it('recognises the older battery/firmware wording', () => {
    assert.ok(isInfoError('Could not read battery/firmware: timed out'));
    assert.equal(currentSensorError(row({ last_error: 'Could not read battery/firmware: x', last_error_at: 100, battery_at: 150 })), null);
  });
  it('keeps other errors as read problems', () => {
    const e = currentSensorError(row({ last_error: 'Active read failed: connect timed out', last_error_at: 100, device_info_at: 200 }));
    assert.equal(e?.kind, 'read');
  });
});
