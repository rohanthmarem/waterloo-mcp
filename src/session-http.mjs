import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { decrypt } from "../upstream/build/auth/encrypted-store.js";

export class SessionExpired extends Error {}
export async function loadBrowserSession(config) {
  let key;
  try {
    const [encrypted, secret] = await Promise.all([
      readFile(path.join(config.stateDir, "browser.json"), "utf8"),
      readFile(path.join(config.secretsDir, "session-key"), "utf8"),
    ]);
    key = Buffer.from(secret.trim(), "hex");
    const state = JSON.parse(
      decrypt(JSON.parse(encrypted), key, "waterloo-browser:v1"),
    );
    // Rotation or imported/renewed login invalidates in-memory service cookies.
    const version = createHash("sha256")
      .update(encrypted)
      .update(key)
      .digest("hex");
    return { state, version };
  } catch {
    throw new SessionExpired();
  } finally {
    key?.fill(0);
  }
}

// This object belongs to exactly one gateway user and one fixed service origin.
// It caches transport cookies, never page results. No disk writes or global state.
export class SessionHttp {
  constructor(
    config,
    {
      origin,
      allowed,
      bootstrap,
      authenticated,
      load = () => loadBrowserSession(config),
      createContext = async (options) =>
        (await import("playwright")).request.newContext(options),
      idleMs = 5 * 60_000,
      maxAgeMs = 30 * 60_000,
      now = Date.now,
    },
  ) {
    Object.assign(this, {
      origin,
      allowed,
      bootstrap,
      authenticated,
      load,
      createContext,
      idleMs,
      maxAgeMs,
      now,
    });
    this.queue = Promise.resolve();
    this.pending = 0;
    this.closed = false;
  }
  async dispose() {
    clearTimeout(this.timer);
    const context = this.context;
    this.context = undefined;
    await context?.dispose();
  }
  async close() {
    this.closed = true;
    await this.queue.catch(() => {});
    await this.dispose();
  }
  async install(state, version) {
    await this.dispose();
    const hostname = new URL(this.origin).hostname;
    const cookies = state.cookies.filter((c) => {
      const domain = c.domain.replace(/^\./, "");
      return (
        hostname === domain ||
        (c.domain.startsWith(".") && hostname.endsWith("." + domain))
      );
    });
    this.context = await this.createContext({
      storageState: { cookies, origins: [] },
      timeout: 25000,
      ignoreHTTPSErrors: false,
    });
    this.version = version;
    this.created = this.now();
  }
  async get(input) {
    let url = new URL(input, this.origin);
    for (let redirects = 0; redirects < 5; redirects++) {
      if (
        url.origin !== this.origin ||
        url.username ||
        url.password ||
        !this.allowed(url)
      )
        throw new SessionExpired();
      const response = await this.context.get(url.href, { maxRedirects: 0 });
      try {
        const status = response.status();
        const headers = response.headers();
        if (status >= 300 && status < 400) {
          if (!headers.location) throw new SessionExpired();
          url = new URL(headers.location, url);
          continue;
        }
        if (status === 401) throw new SessionExpired();
        if (status !== 200) throw new Error("HTTP_READ_FAILED");
        if (!/^text\/html(?:;|$)/i.test(headers["content-type"] ?? ""))
          throw new Error("HTTP_CONTENT_TYPE");
        if (Number(headers["content-length"]) > 2_000_000)
          throw new Error("HTTP_RESPONSE_TOO_LARGE");
        const html = await response.text();
        if (Buffer.byteLength(html) > 2_000_000)
          throw new Error("HTTP_RESPONSE_TOO_LARGE");
        if (!this.authenticated(html)) throw new SessionExpired();
        return { html, url: url.href };
      } finally {
        await response.dispose();
      }
    }
    throw new SessionExpired();
  }
  async run(operation) {
    if (this.closed || this.pending >= 4) throw new Error("SERVICE_BUSY");
    this.pending++;
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        clearTimeout(this.timer);
        try {
          // Always check the user's encrypted source before reusing a cookie jar.
          // Corrupt/missing state fails closed, even while a cached jar still works.
          const { state, version } = await this.load();
          if (
            !this.context ||
            this.version !== version ||
            this.now() - this.created >= this.maxAgeMs
          )
            await this.install(state, version);
          const read = async () => {
            const pages = new Map(); // Deduplicate only within this one fresh read.
            return operation(async (url) => {
              const key = new URL(url, this.origin).href;
              if (!pages.has(key)) pages.set(key, this.get(key));
              const result = await pages.get(key);
              pages.set(result.url, Promise.resolve(result));
              return result;
            });
          };
          try {
            return await read();
          } catch (error) {
            if (!(error instanceof SessionExpired)) throw error;
            // One scripted login, then exactly one replay of the read-only operation.
            await this.dispose();
            const refreshed = await this.bootstrap(state);
            await this.install(refreshed, version);
            return await read();
          }
        } catch (error) {
          if (error instanceof SessionExpired) await this.dispose();
          throw error;
        } finally {
          this.timer = setTimeout(() => {
            if (this.pending !== 0) return;
            const owned = this.context;
            this.queue
              .then(() => {
                if (this.pending === 0 && this.context === owned)
                  return this.dispose();
              })
              .catch(() => {});
          }, this.idleMs);
          this.timer.unref?.();
        }
      });
    this.queue = task;
    try {
      return await task;
    } finally {
      this.pending--;
    }
  }
}
