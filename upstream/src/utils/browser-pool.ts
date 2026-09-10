/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import type { Browser } from "playwright";

/**
 * One headless Chromium shared by the page-reading tools, with a fresh isolated
 * context per call.
 *
 * Launching a browser is the slowest thing these tools do and the largest
 * memory spike in the process, and each of them used to pay it on every call.
 * The browser process itself holds no page state: every read still gets its
 * own context with exactly the storage state it was handed, and closes that
 * context before returning, so nothing carries over between calls. After the
 * last caller finishes the browser stays warm briefly and then exits, giving
 * the memory back on an idle server.
 */
const IDLE_CLOSE_MS = 60_000;

let launching: Promise<Browser> | null = null;
let active = 0;
let idleTimer: NodeJS.Timeout | undefined;

async function acquire(): Promise<Browser> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!launching) {
      // Loaded on first use: the playwright module alone is about 70 MiB of
      // resident memory, which an API-only session never needs.
      const pending = import("playwright").then(({ chromium }) => chromium.launch({ headless: true })).then((browser) => {
        browser.on("disconnected", () => {
          if (launching === pending) launching = null;
        });
        return browser;
      });
      launching = pending;
      pending.catch(() => {
        if (launching === pending) launching = null;
      });
    }
    const browser = await launching;
    if (browser.isConnected()) return browser;
    // Crashed or closed since it was cached: drop it and launch once more.
    launching = null;
  }
  throw new Error("Browser could not be started");
}

function release(): void {
  active--;
  if (active > 0) return;
  const owned = launching;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (active > 0 || !owned || launching !== owned) return;
    launching = null;
    owned.then((browser) => browser.close()).catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

/** Run `fn` with the shared browser. Callers create and close their own context. */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  active++;
  let browser: Browser;
  try {
    browser = await acquire();
  } catch (error) {
    release();
    throw error;
  }
  try {
    return await fn(browser);
  } finally {
    release();
  }
}

/** Close the shared browser now, for shutdown or tests. */
export async function closeSharedBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  const owned = launching;
  launching = null;
  if (owned) await owned.then((browser) => browser.close()).catch(() => {});
}
