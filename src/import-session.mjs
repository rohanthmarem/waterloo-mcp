import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { encrypt } from "../upstream/build/auth/encrypted-store.js";
import { SessionStore } from "../upstream/build/auth/session-store.js";

// Fixed upstream origin: uploaded storage state never chooses a verification URL.
export async function importSession(config, state, request = fetch) {
  const fail = () => {
    throw new Error("SESSION_IMPORT_REJECTED");
  };
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins))
    fail();
  const allowed = (host) =>
    host === "uwaterloo.ca" ||
    host.endsWith(".uwaterloo.ca") ||
    host === "duosecurity.com" ||
    host.endsWith(".duosecurity.com");
  const cookies = state.cookies.filter(
    (c) => typeof c.domain === "string" && allowed(c.domain.replace(/^\./, "")),
  );
  for (const c of cookies)
    if (
      typeof c.name !== "string" ||
      typeof c.value !== "string" ||
      /[\r\n;]/.test(c.name + c.value)
    )
      fail();
  const learn = cookies.filter(
    (c) =>
      ["learn.uwaterloo.ca", ".learn.uwaterloo.ca", ".uwaterloo.ca"].includes(
        c.domain,
      ) && ["d2lSessionVal", "d2lSecureSessionVal"].includes(c.name),
  );
  if (learn.length !== 2 || new Set(learn.map((c) => c.name)).size !== 2)
    fail();
  const cookie = learn.map((c) => `${c.name}=${c.value}`).join("; ");
  const get = async (route) => {
    const r = await request("https://learn.uwaterloo.ca" + route, {
      headers: { Cookie: cookie },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok || !r.headers.get("content-type")?.includes("json")) fail();
    return r.json();
  };
  const versions = await get("/d2l/api/versions/");
  const version = versions.find((v) => v.ProductCode === "lp")?.LatestVersion;
  if (!/^\d+\.\d+$/.test(version ?? "")) fail();
  const who = await get(`/d2l/api/lp/${version}/users/whoami`);
  if (
    who.UniqueName?.toLowerCase() !==
    config.username.split("@")[0].toLowerCase()
  )
    fail();
  const origins = state.origins.filter((o) => {
    try {
      const u = new URL(o.origin);
      return (
        u.protocol === "https:" &&
        allowed(u.hostname) &&
        Array.isArray(o.localStorage)
      );
    } catch {
      return false;
    }
  });
  const key = Buffer.from(
    (
      await readFile(path.join(config.secretsDir, "session-key"), "utf8")
    ).trim(),
    "hex",
  );
  try {
    await mkdir(config.stateDir, { mode: 0o700, recursive: true });
    const file = path.join(config.stateDir, "browser.json");
    await writeFile(
      file + ".pending",
      JSON.stringify(
        encrypt(
          JSON.stringify({ cookies, origins }),
          key,
          "waterloo-browser:v1",
        ),
      ),
      { mode: 0o600 },
    );
    await rename(file + ".pending", file);
    // Pass the tenant's explicit key. Do not rely on process-global env in tests
    // or callers that are preparing a different user's setup.
    const store = new SessionStore(path.join(config.stateDir, "sessions"), {
      backend: {
        getPassword: async () => key.toString("hex"),
        setPassword: async () => {
          throw new Error("CONFIG_INVALID");
        },
        deletePassword: async () => {
          throw new Error("CONFIG_INVALID");
        },
      },
    });
    await store.save({
      accessToken: "cookie:" + cookie,
      capturedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      source: "browser",
      tenantOrigin: "https://learn.uwaterloo.ca",
    });
  } finally {
    key.fill(0);
  }
  return { connected: true };
}
