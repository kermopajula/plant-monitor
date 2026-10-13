import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planAlerts, type AlertState } from '../src/lib/alerts';
import type { Problem } from '../src/lib/status';

const MAC = 'C4:7C:8D:00:00:01';
const MIN = 60_000;
const HOLD = 60 * MIN;

/** Runs a sequence of checks and returns all notifications/resolutions. */
function simulate(steps: [number, Problem[]][]) {
  let state: AlertState[] = [];
  const notified: [number, Problem][] = [];
  const resolved: [number, Problem][] = [];
  for (const [t, problems] of steps) {
    const plan = planAlerts(MAC, state, problems, t, HOLD);
    state = plan.state;
    for (const a of plan.notify) notified.push([t, a.problem]);
    for (const a of plan.resolved) resolved.push([t, a.problem]);
  }
  return { state, notified, resolved };
}

describe('planAlerts', () => {
  it('waits for the hold time before notifying', () => {
    const { notified } = simulate([
      [0, ['needs_water']],
      [30 * MIN, ['needs_water']],
      [60 * MIN, ['needs_water']],
    ]);
    assert.deepEqual(notified, [[60 * MIN, 'needs_water']]);
  });

  it('does not repeat an alert while the problem persists', () => {
    const steps: [number, Problem[]][] = [];
    for (let t = 0; t <= 24 * 60 * MIN; t += 20 * MIN) steps.push([t, ['needs_water']]);
    assert.equal(simulate(steps).notified.length, 1);
  });

  it('never notifies a problem that clears before the hold time', () => {
    const { notified, state } = simulate([
      [0, ['too_hot']],
      [30 * MIN, []],
      [90 * MIN, []],
    ]);
    assert.deepEqual(notified, []);
    assert.deepEqual(state, []);
  });

  it('does not re-alert when a value flaps around the limit', () => {
    const { notified } = simulate([
      [0, ['needs_water']],
      [60 * MIN, ['needs_water']], // notified
      [80 * MIN, []], // briefly fine (e.g. a slightly higher reading)
      [100 * MIN, ['needs_water']], // back again: same problem, no new alert
      [200 * MIN, ['needs_water']],
    ]);
    assert.equal(notified.length, 1);
  });

  it('resolves after the problem has been clear for the hold time', () => {
    const { resolved, state } = simulate([
      [0, ['needs_water']],
      [60 * MIN, ['needs_water']],
      [80 * MIN, []],
      [140 * MIN, []],
    ]);
    assert.deepEqual(resolved, [[140 * MIN, 'needs_water']]);
    assert.deepEqual(state, []);
  });

  it('alerts again for a new occurrence after resolution', () => {
    const { notified } = simulate([
      [0, ['needs_water']],
      [60 * MIN, ['needs_water']],
      [80 * MIN, []],
      [140 * MIN, []], // resolved
      [200 * MIN, ['needs_water']],
      [260 * MIN, ['needs_water']],
    ]);
    assert.deepEqual(notified, [
      [60 * MIN, 'needs_water'],
      [260 * MIN, 'needs_water'],
    ]);
  });

  it('tracks problems independently', () => {
    const { notified } = simulate([
      [0, ['needs_water']],
      [30 * MIN, ['needs_water', 'too_dark']],
      [60 * MIN, ['needs_water', 'too_dark']],
      [90 * MIN, ['needs_water', 'too_dark']],
    ]);
    assert.deepEqual(notified, [
      [60 * MIN, 'needs_water'],
      [90 * MIN, 'too_dark'],
    ]);
  });

  it('notifies immediately with a hold time of 0', () => {
    const plan = planAlerts(MAC, [], ['too_cold'], 0, 0);
    assert.equal(plan.notify.length, 1);
  });

  it('ignores state rows of other sensors', () => {
    const other: AlertState = { mac: 'OTHER', problem: 'needs_water', since: 0, notifiedAt: 0, clearedSince: null };
    const plan = planAlerts(MAC, [other], [], HOLD * 2, HOLD);
    assert.deepEqual(plan, { state: [], notify: [], resolved: [] });
  });
});
