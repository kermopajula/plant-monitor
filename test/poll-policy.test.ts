import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decidePoll, type PollInput } from '../src/lib/poll-policy';

const H = 3600_000;
const base: PollInput = { passive: true, batteryFresh: true, firmwareKnown: true, infoAttemptAt: null, now: 100 * H, infoRetryMs: 6 * H };

describe('decidePoll', () => {
  it('does not connect when broadcasts cover everything', () => {
    assert.equal(decidePoll(base), 'none');
  });
  it('connects for readings when nothing was broadcast', () => {
    assert.equal(decidePoll({ ...base, passive: false }), 'data');
    assert.equal(decidePoll({ ...base, passive: false, infoAttemptAt: base.now - 1 }), 'data');
  });
  it('connects for battery/firmware when missing or stale', () => {
    assert.equal(decidePoll({ ...base, firmwareKnown: false }), 'info');
    assert.equal(decidePoll({ ...base, batteryFresh: false }), 'info');
  });
  it('waits after a recent attempt, so a refusing sensor is not drained', () => {
    assert.equal(decidePoll({ ...base, firmwareKnown: false, infoAttemptAt: base.now - 20 * 60_000 }), 'none');
    assert.equal(decidePoll({ ...base, firmwareKnown: false, infoAttemptAt: base.now - 6 * H }), 'info');
  });
});
