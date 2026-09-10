/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Token bucket rate limiter - allows bursts up to capacity.
//
// Waiters are served first come, first served. The earlier version let every
// concurrent caller compute its own wait from the same empty bucket and then
// decrement past zero, so a parallel burst briefly exceeded the configured
// rate. A single queue keeps the promised rate exact under concurrency.

interface Waiter {
  count: number;
  resolve: () => void;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second
  private readonly queue: Waiter[] = [];
  private draining = false;

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity; // Start with full bucket
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    const elapsedSeconds = elapsedMs / 1000;

    // Add tokens based on elapsed time
    const tokensToAdd = elapsedSeconds * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  async consume(count: number = 1): Promise<void> {
    await new Promise<void>((resolve) => {
      this.queue.push({ count, resolve });
      this.drain();
    });
  }

  /** Serve the queue head as soon as the bucket can cover it, then the next. */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    const step = (): void => {
      const head = this.queue[0];
      if (!head) {
        this.draining = false;
        return;
      }
      this.refill();
      // A hair of tolerance absorbs floating point drift after a timed wait.
      if (this.tokens + 1e-9 >= head.count) {
        this.tokens = Math.max(0, this.tokens - head.count);
        this.queue.shift();
        head.resolve();
        step();
        return;
      }
      const tokensNeeded = head.count - this.tokens;
      const waitTimeMs = (tokensNeeded / this.refillRate) * 1000;
      setTimeout(step, waitTimeMs);
    };
    step();
  }

  tryConsume(count: number = 1): boolean {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }

    return false;
  }

  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}
