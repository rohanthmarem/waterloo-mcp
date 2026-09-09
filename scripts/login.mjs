import { chromium } from "playwright";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { readConfig, workerEnv } from "../src/config.mjs";
import { problem } from "../src/errors.mjs";

const config = readConfig();
Object.assign(process.env, workerEnv(config));
const { encrypt } = await import("../upstream/build/auth/encrypted-store.js");
const { SessionStore } = await import(
  "../upstream/build/auth/session-store.js"
);
let browser;
let terminal;
try {
  // A normal fresh browser: users enter their password and complete their own MFA.
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("https://learn.uwaterloo.ca", {
    waitUntil: "domcontentloaded",
  });
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  await terminal.question(
    "Sign in to LEARN in the browser. When your course homepage appears, press Enter here. ",
  );
  if (new URL(page.url()).origin !== "https://learn.uwaterloo.ca")
    throw new Error("Not signed in");
  const cookies = (await context.cookies("https://learn.uwaterloo.ca")).filter(
    (c) => ["d2lSessionVal", "d2lSecureSessionVal"].includes(c.name),
  );
  if (cookies.length !== 2) throw new Error("Session missing");
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const get = async (route) => {
    const res = await fetch("https://learn.uwaterloo.ca" + route, {
      headers: { Cookie: cookie },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("json"))
      throw new Error("API rejected login");
    return res.json();
  };
  const versions = await get("/d2l/api/versions/");
  const lp = versions.find((v) => v.ProductCode === "lp")?.LatestVersion;
  if (!/^\d+\.\d+$/.test(lp ?? "")) throw new Error("Invalid version");
  const who = await get(`/d2l/api/lp/${lp}/users/whoami`);
  const expected = config.username.split("@")[0].toLowerCase();
  if (who.UniqueName?.toLowerCase() !== expected)
    throw new Error("Wrong Waterloo account");
  const key = Buffer.from(
    (
      await readFile(path.join(config.secretsDir, "session-key"), "utf8")
    ).trim(),
    "hex",
  );
  try {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(config.stateDir, "browser.json");
    await writeFile(
      file + ".pending",
      JSON.stringify(
        encrypt(
          JSON.stringify(await context.storageState()),
          key,
          "waterloo-browser:v1",
        ),
      ),
      { mode: 0o600 },
    );
    await rename(file + ".pending", file);
    await new SessionStore(process.env.D2L_SESSION_DIR).save({
      accessToken: "cookie:" + cookie,
      capturedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      source: "browser",
      tenantOrigin: "https://learn.uwaterloo.ca",
    });
  } finally {
    key.fill(0);
  }
  console.log(
    "Login verified. Encrypted session saved under private/. Deploy it through SSH; never commit it.",
  );
} catch {
  console.error(JSON.stringify(problem("AUTH_REAUTH_REQUIRED")));
  process.exitCode = 1;
} finally {
  terminal?.close();
  await browser?.close();
}
