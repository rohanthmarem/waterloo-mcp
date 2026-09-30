import { request } from "playwright";
import { withBrowser } from "../upstream/build/utils/browser-pool.js";
import { loadBrowserSession } from "./session-http.mjs";
import { cmFail, CrowdmarkError } from "./crowdmark-files.mjs";

export const CROWD_ORIGIN = "https://app.crowdmark.com";
const cookieState = (state) => ({
  cookies: state.cookies.filter((c) =>
    ["app.crowdmark.com", ".crowdmark.com", "crowdmark.com"].includes(c.domain),
  ),
  origins: [],
});
// Bootstrapping never opens an assessment: doing so can start drafting or a timer.
export class CrowdmarkSession {
  constructor(
    config,
    {
      browse = withBrowser,
      load = () => loadBrowserSession(config),
      createContext = (options) => request.newContext(options),
    } = {},
  ) {
    this.config = config;
    this.browse = browse;
    this.load = load;
    this.createContext = createContext;
  }
  async close() {
    clearTimeout(this.timer);
    await this.context?.dispose();
    this.context = undefined;
  }
  async connect() {
    let source;
    try {
      source = await this.load();
    } catch {
      cmFail("CROWDMARK_AUTH_REQUIRED");
    }
    if (
      this.context &&
      this.version === source.version &&
      Date.now() - this.created < 10 * 60000
    )
      return;
    await this.close();
    const state = await this.browse(async (browser) => {
      const context = await browser.newContext({
        storageState: source.state,
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      try {
        // Prevent unexpected assessment writes during SSO bootstrap.
        await context.route("**/api/v2/student/**", (route) =>
          route.request().method() === "GET" ? route.continue() : route.abort(),
        );
        const page = await context.newPage();
        await page.goto(CROWD_ORIGIN + "/sign-in/waterloo", {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        const login = page.getByRole("link", {
          name: "Sign in with LEARN",
          exact: true,
        });
        if (await login.count()) await login.click();
        await page.waitForURL(CROWD_ORIGIN + "/student/courses", {
          timeout: 45000,
        });
        return cookieState(await context.storageState());
      } catch {
        cmFail("CROWDMARK_AUTH_REQUIRED");
      } finally {
        await context.close();
      }
    });
    this.context = await this.createContext({
      storageState: state,
      timeout: 25000,
    });
    this.version = source.version;
    this.created = Date.now();
    this.timer = setTimeout(() => this.close().catch(() => {}), 11 * 60000);
    this.timer.unref?.();
    // Validate the logged-in identity, never return session tokens or other users.
    try {
      const session = await this.get("/api/v2/session");
      const rel = session.data?.relationships?.user?.data;
      const user = session.included?.find(
        (x) => x.type === rel?.type && String(x.id) === String(rel?.id),
      );
      const email = user?.attributes?.email;
      if (
        !email ||
        email.toLowerCase() !== this.config.username.toLowerCase()
      ) {
        cmFail("CROWDMARK_IDENTITY_MISMATCH");
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async get(url, context = this.context) {
    if (
      !/^\/api\/v2\/(session|student\/assignments(?:\/[a-zA-Z0-9_-]+)?|student\/assignment-pages\/[a-zA-Z0-9_-]+\/latest_content)$/.test(
        url,
      )
    )
      cmFail("CROWDMARK_RESPONSE_CHANGED");
    const r = await context.get(CROWD_ORIGIN + url, { maxRedirects: 0 });
    try {
      if ([301, 302, 303, 307, 308, 401, 403].includes(r.status()))
        cmFail("CROWDMARK_AUTH_REQUIRED");
      if (r.status() === 404) cmFail("CROWDMARK_NOT_FOUND");
      if (
        r.status() !== 200 ||
        !/json/i.test(r.headers()["content-type"] ?? "")
      )
        cmFail("CROWDMARK_RESPONSE_CHANGED");
      if (Number(r.headers()["content-length"]) > 4_000_000)
        cmFail("CROWDMARK_RESPONSE_CHANGED");
      const bytes = await r.body();
      if (bytes.length > 4_000_000) cmFail("CROWDMARK_RESPONSE_CHANGED");
      return JSON.parse(bytes.toString());
    } finally {
      await r.dispose();
    }
  }
  async read(url) {
    await this.connect();
    try {
      return await this.get(url);
    } catch (e) {
      if (
        !(e instanceof CrowdmarkError) ||
        e.code !== "CROWDMARK_AUTH_REQUIRED"
      )
        throw e;
      await this.close();
      await this.connect();
      return this.get(url);
    }
  }
  async edit(operation) {
    // Call only after approval. No automatic replay after any possible write.
    await this.connect();
    return this.browse(async (browser) => {
      const context = await browser.newContext({
        storageState: cookieState(await this.context.storageState()),
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      let timer;
      try {
        return await Promise.race([
          operation(await context.newPage(), context),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new CrowdmarkError("CROWDMARK_OUTCOME_UNKNOWN")),
              150000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        await context.close();
      }
    });
  }
}
