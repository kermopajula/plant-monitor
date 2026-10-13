import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retry, TimeoutError, withTimeout } from '../src/lib/retry';

describe('withTimeout', () => {
  it('resolves when the promise is fast enough', async () => {
    assert.equal(await withTimeout(Promise.resolve(5), 50, 'x'), 5);
  });
  it('rejects with a TimeoutError when too slow', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 10, 'connect'), (e) => e instanceof TimeoutError && /connect/.test(e.message));
  });
});

describe('retry', () => {
  it('retries until success', async () => {
    let calls = 0;
    const r = await retry(async () => {
      if (++calls < 3) throw new Error('flaky');
      return 'ok';
    }, { attempts: 3, baseDelayMs: 1 });
    assert.equal(r, 'ok');
    assert.equal(calls, 3);
  });
  it('gives up after the last attempt with the last error', async () => {
    const errors: number[] = [];
    await assert.rejects(
      retry(async (n) => {
        throw new Error(`fail ${n}`);
      }, { attempts: 2, baseDelayMs: 1, onError: (_, n) => errors.push(n) }),
      /fail 2/,
    );
    assert.deepEqual(errors, [1, 2]);
  });
});
