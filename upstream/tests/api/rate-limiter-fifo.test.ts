import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TokenBucket } from "../../src/api/rate-limiter.js";

/**
 * Concurrent callers used to compute their own wait from the same empty bucket
 * and all proceed at once, briefly exceeding the configured rate. The queue
 * serves them in order at exactly the refill rate.
 */
describe("TokenBucket under concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a burst within capacity immediately", async () => {
    const bucket = new TokenBucket(10, 4);
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => bucket.consume(1).then(() => done.push(i))),
    );
    expect(done).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bucket.availableTokens).toBe(0);
  });

  it("releases waiters one per refill interval, in arrival order", async () => {
    const bucket = new TokenBucket(10, 4); // one token every 250 ms
    await bucket.consume(10);
    const order: number[] = [];
    const waiters = Array.from({ length: 6 }, (_, i) =>
      bucket.consume(1).then(() => order.push(i)),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);

    for (let step = 1; step <= 6; step++) {
      await vi.advanceTimersByTimeAsync(250);
      expect(order).toHaveLength(step);
    }
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    await Promise.all(waiters);
    expect(bucket.availableTokens).toBeCloseTo(0, 5);
  });

  it("never lets the bucket go negative", async () => {
    const bucket = new TokenBucket(2, 8);
    await bucket.consume(2);
    const waiters = Array.from({ length: 5 }, () => bucket.consume(1));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(125);
      expect(bucket.availableTokens).toBeGreaterThanOrEqual(0);
    }
    await Promise.all(waiters);
  });
});
