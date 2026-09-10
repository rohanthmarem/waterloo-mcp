import { describe, it, expect } from "vitest";
import { mapLimit } from "../../src/utils/concurrency.js";

describe("mapLimit", () => {
  it("preserves input order even when later items finish first", async () => {
    const delays = [30, 5, 20, 1, 10];
    const result = await mapLimit(delays, 5, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${index}:${ms}`;
    });
    expect(result).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
  });

  it("keeps at most `limit` calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("propagates a rejection like Promise.all", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapLimit([], 4, async (n) => n)).toEqual([]);
    expect(await mapLimit([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });
});
