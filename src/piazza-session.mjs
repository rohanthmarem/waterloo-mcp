import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../upstream/build/auth/encrypted-store.js";

export const PIAZZA_ORIGIN = "https://piazza.com";
export class PiazzaError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const piazzaFail = (code) => {
  throw new PiazzaError(code);
};
// Every method here must be reviewed as a read. Never accept arbitrary RPC names from MCP.
export const PIAZZA_READ_METHODS = new Set([
  "user.status",
  "network.get_my_feed",
  "network.search",
  "content.get",
]);
const AAD = "waterloo-piazza-session:v1";

export class PiazzaSession {
  constructor(
    config,
    {
      // Loaded on first use: playwright alone costs about 70 MiB of resident memory.
      createContext = async (options) =>
        (await import("playwright")).request.newContext(options),
    } = {},
  ) {
    this.config = config;
    this.createContext = createContext;
    this.file = path.join(config.stateDir, "piazza", "session.encrypted.json");
    this.queue = Promise.resolve();
    this.queued = 0;
    this.retryAfter = 0;
  }
  async exclusive(run) {
    if (this.queued >= 4) piazzaFail("SERVICE_BUSY");
    this.queued++;
    const task = this.queue.catch(() => {}).then(run);
    this.queue = task;
    try {
      return await task;
    } finally {
      this.queued--;
    }
  }
  async key() {
    const raw = (
      await readFile(path.join(this.config.secretsDir, "session-key"), "utf8")
    ).trim();
    if (!/^[a-f0-9]{64}$/i.test(raw)) piazzaFail("CONFIG_INVALID");
    return Buffer.from(raw, "hex");
  }
  async load() {
    let key;
    try {
      const raw = await readFile(this.file, "utf8");
      key = await this.key();
      const state = JSON.parse(decrypt(JSON.parse(raw), key, AAD));
      if (
        !state.email ||
        !state.password ||
        !state.uid ||
        !Array.isArray(state.storageState?.cookies)
      )
        piazzaFail("PIAZZA_STATE_INVALID");
      return state;
    } catch (error) {
      if (error.code === "ENOENT") piazzaFail("PIAZZA_AUTH_REQUIRED");
      piazzaFail("PIAZZA_STATE_INVALID");
    } finally {
      key?.fill(0);
    }
  }
  async save(state) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const key = await this.key();
    try {
      await writeFile(
        this.file + ".pending",
        JSON.stringify(encrypt(JSON.stringify(state), key, AAD)),
        { mode: 0o600 },
      );
      await rename(this.file + ".pending", this.file);
    } finally {
      key.fill(0);
    }
  }
  async context(storageState) {
    return this.createContext({
      baseURL: PIAZZA_ORIGIN,
      ...(storageState ? { storageState } : {}),
      timeout: 25000,
      extraHTTPHeaders: {
        Origin: PIAZZA_ORIGIN,
        Referer: PIAZZA_ORIGIN + "/class",
      },
    });
  }
  async rpc(context, method, params = {}) {
    if (!PIAZZA_READ_METHODS.has(method)) piazzaFail("TOOL_UNSUPPORTED");
    const state = await context.storageState();
    const sessionId = state.cookies.find(
      (c) =>
        c.name === "session_id" &&
        ["piazza.com", ".piazza.com"].includes(c.domain),
    )?.value;
    if (!sessionId) piazzaFail("PIAZZA_AUTH_REQUIRED");
    const aid = Date.now().toString(36) + randomBytes(4).toString("hex");
    let response;
    try {
      response = await context.post(
        PIAZZA_ORIGIN +
          "/logic/api?method=" +
          encodeURIComponent(method) +
          "&aid=" +
          aid,
        {
          data: JSON.stringify({ method, params }),
          headers: {
            "Content-Type": "application/json",
            "CSRF-Token": sessionId,
          },
          maxRedirects: 0,
        },
      );
    } catch {
      piazzaFail("UPSTREAM_UNAVAILABLE");
    }
    if (response.status() === 429) piazzaFail("UPSTREAM_RATE_LIMITED");
    if ([301, 302, 303, 307, 308, 401].includes(response.status()))
      piazzaFail("PIAZZA_AUTH_REQUIRED");
    if (response.status() === 403) piazzaFail("PIAZZA_FORBIDDEN");
    if (!response.ok()) piazzaFail("UPSTREAM_UNAVAILABLE");
    const buffer = await response.body();
    if (buffer.length > 8 * 1024 * 1024) piazzaFail("PIAZZA_RESPONSE_CHANGED");
    let value;
    try {
      value = JSON.parse(buffer.toString("utf8"));
    } catch {
      piazzaFail("PIAZZA_RESPONSE_CHANGED");
    }
    if (value.error) {
      const message =
        typeof value.error === "string"
          ? value.error
          : JSON.stringify(value.error);
      if (
        /not.?logged|not.?authenticated|session|login|log in|authentication/i.test(
          message,
        )
      )
        piazzaFail("PIAZZA_AUTH_REQUIRED");
      if (/denied|permission|not.*member|forbidden/i.test(message))
        piazzaFail("PIAZZA_FORBIDDEN");
      if (
        /not found|cannot be found|does not exist|invalid.*(content|network|post)/i.test(
          message,
        )
      )
        piazzaFail("PIAZZA_NOT_FOUND");
      piazzaFail("PIAZZA_RESPONSE_CHANGED");
    }
    if (!Object.hasOwn(value, "result") || value.result == null)
      piazzaFail("PIAZZA_RESPONSE_CHANGED");
    return value.result;
  }
  async authenticate(email, password) {
    const context = await this.context();
    try {
      const csrfResponse = await context.get(
        PIAZZA_ORIGIN + "/main/csrf_token",
        { maxRedirects: 0 },
      );
      if (csrfResponse.status() === 429) piazzaFail("UPSTREAM_RATE_LIMITED");
      if (!csrfResponse.ok()) piazzaFail("UPSTREAM_UNAVAILABLE");
      const csrf = (await csrfResponse.text()).match(
        /(?:window\.)?CSRF_TOKEN\s*=\s*["']([^"']+)["']/,
      )?.[1];
      if (!csrf) piazzaFail("PIAZZA_RESPONSE_CHANGED");
      const response = await context.post(PIAZZA_ORIGIN + "/class", {
        form: {
          from: "/signup",
          email,
          password,
          remember: "on",
          csrf_token: csrf,
        },
        maxRedirects: 0,
      });
      if (response.status() === 429) piazzaFail("UPSTREAM_RATE_LIMITED");
      if (![200, 302, 303].includes(response.status()))
        piazzaFail("PIAZZA_AUTH_REQUIRED");
      const status = await this.rpc(context, "user.status");
      if (typeof status.id !== "string" || !Array.isArray(status.networks))
        piazzaFail("PIAZZA_AUTH_REQUIRED");
      return {
        email,
        password,
        uid: status.id,
        storageState: await context.storageState(),
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof PiazzaError) throw error;
      piazzaFail("UPSTREAM_UNAVAILABLE");
    } finally {
      await context.dispose();
    }
  }
  async connect(email, password) {
    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      typeof password !== "string" ||
      !password ||
      password.length > 512
    )
      piazzaFail("INPUT_INVALID");
    return this.exclusive(async () => {
      const state = await this.authenticate(
        email.trim().toLowerCase(),
        password,
      );
      await this.save(state);
      this.retryAfter = 0;
      return { connected: true, email: state.email };
    });
  }
  async run(operation) {
    return this.exclusive(async () => {
      let state = await this.load();
      for (let attempt = 0; attempt < 2; attempt++) {
        const context = await this.context(state.storageState);
        try {
          const rpc = (method, params) => this.rpc(context, method, params);
          return await operation(rpc, { email: state.email, uid: state.uid });
        } catch (error) {
          if (error.code !== "PIAZZA_AUTH_REQUIRED" || attempt !== 0)
            throw error;
        } finally {
          await context.dispose();
        }
        if (this.retryAfter > Date.now()) piazzaFail("PIAZZA_AUTH_REQUIRED");
        this.retryAfter = Date.now() + 120000;
        state = await this.authenticate(state.email, state.password);
        await this.save(state);
        this.retryAfter = 0;
      }
    });
  }
}
