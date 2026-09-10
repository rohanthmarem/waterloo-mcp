/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

/**
 * Map items through an async function with at most `limit` calls in flight,
 * preserving input order in the result. A rejection propagates like
 * Promise.all; callers that want per-item tolerance catch inside `fn`.
 *
 * The API client's token bucket still bounds the request rate; this only lets
 * independent reads overlap their round trips instead of queueing one at a time.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
