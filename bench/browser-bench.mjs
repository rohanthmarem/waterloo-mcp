// Chromium lifecycle costs behind get_course_home, read_course_link, get_odyssey_schedule,
// and study-room checkout. Measures launch, context, page, and close; no site is contacted.
import { chromium } from "playwright";
import { sampler, stats } from "./measure.mjs";

export async function runBrowserBench({ iterations = 5 } = {}) {
  const results = {};
  const launchMs = [],
    contextMs = [],
    closeMs = [],
    totalMs = [],
    peaks = [];
  for (let i = 0; i < iterations; i++) {
    const smp = sampler(process.pid, 25);
    const t0 = performance.now();
    const browser = await chromium.launch({ headless: true });
    const t1 = performance.now();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.setContent(
      "<html><body><main><h1>Bench</h1><p>text</p></main></body></html>",
    );
    await page.locator("body").innerText();
    const t2 = performance.now();
    await context.close();
    await browser.close();
    const t3 = performance.now();
    launchMs.push(t1 - t0);
    contextMs.push(t2 - t1);
    closeMs.push(t3 - t2);
    totalMs.push(t3 - t0);
    peaks.push(smp.stop());
  }
  results.freshBrowserPerCall = {
    launchMs: stats(launchMs),
    contextAndPageMs: stats(contextMs),
    closeMs: stats(closeMs),
    totalMs: stats(totalMs),
    peakTreeRssBytes: Math.max(...peaks),
  };
  // The alternative shape: one browser, a fresh isolated context per call.
  const browser = await chromium.launch({ headless: true });
  const reuse = [];
  const smp = sampler(process.pid, 25);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.setContent(
      "<html><body><main><h1>Bench</h1><p>text</p></main></body></html>",
    );
    await page.locator("body").innerText();
    await context.close();
    reuse.push(performance.now() - t0);
  }
  const idle = smp.stop();
  await browser.close();
  results.sharedBrowserPerCall = {
    contextPageCloseMs: stats(reuse),
    idleTreeRssBytes: idle,
  };
  // The worker's actual code path, when present: withBrowser from the shared pool.
  // BENCH_NO_POOL=1 skips it when measuring a build that predates the pool.
  try {
    if (process.env.BENCH_NO_POOL) throw new Error("pool skipped");
    const pool = await import("../upstream/build/utils/browser-pool.js");
    const calls = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      await pool.withBrowser(async (browser) => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.setContent(
            "<html><body><main><h1>Bench</h1><p>text</p></main></body></html>",
          );
          await page.locator("body").innerText();
        } finally {
          await context.close();
        }
      });
      calls.push(performance.now() - t0);
    }
    await pool.closeSharedBrowser();
    results.workerPool = {
      firstCallMs: calls[0],
      laterCallsMs: stats(calls.slice(1)),
    };
  } catch {
    results.workerPool = null;
  }
  return results;
}
