export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface RetryOptions {
  attempts: number;
  /** Delay before the 2nd attempt; doubles after each failure. */
  baseDelayMs: number;
  onError?: (err: unknown, attempt: number) => void;
  /** Return false to give up immediately (e.g. for errors that will not go away). */
  shouldRetry?: (err: unknown) => boolean;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      opts.onError?.(err, attempt);
      if (opts.shouldRetry && !opts.shouldRetry(err)) break;
      if (attempt < opts.attempts) await sleep(opts.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
