import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { readConfig, workerEnv } from "../src/config.mjs";
import { importSession } from "../src/import-session.mjs";
import { problem } from "../src/errors.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");
    return [a.slice(2, i), a.slice(i + 1)];
  }),
);
let browser, terminal;
try {
  let config, remote, headers;
  if (args.remote) {
    // Validate HTTPS (or local loopback), credentials-in-URL, and path before
    // reading the owner key. Never forward it through an HTTP redirect.
    remote = readConfig({
      WATERLOO_ORIGIN: args.remote,
      WATERLOO_OWNER_EMAIL: "setup@example.invalid",
      D2L_USERNAME: "setup@uwaterloo.ca",
      WATERLOO_AUTH_MODE: "portable",
    }).origin;
    const token = (await readFile(args["token-file"], "utf8")).trim();
    headers = { Authorization: "Bearer " + token, Origin: remote };
    const account = await fetch(remote + "/account", {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!account.ok) throw new Error("AUTH_REQUIRED");
    const info = await account.json();
    if (
      !/^[a-z0-9._-]+@uwaterloo\.ca$/i.test(info.username ?? "") ||
      info.origin !== remote
    )
      throw new Error("AUTH_REQUIRED");
    console.log(
      "Sign in as " +
        info.username +
        ". The verified session will be sent to your chosen host over this connection.",
    );
  } else {
    config = readConfig();
    Object.assign(process.env, workerEnv(config));
  }
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("https://learn.uwaterloo.ca", {
    waitUntil: "domcontentloaded",
  });
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  await terminal.question(
    "Sign in to LEARN and complete Duo in the browser. When your course homepage appears, press Enter here. ",
  );
  if (new URL(page.url()).origin !== "https://learn.uwaterloo.ca")
    throw new Error("AUTH_REAUTH_REQUIRED");
  const state = await context.storageState();
  if (remote) {
    const result = await fetch(remote + "/setup/session", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(state),
      redirect: "manual",
      signal: AbortSignal.timeout(45000),
    });
    if (!result.ok || !(await result.json()).connected)
      throw new Error("SESSION_IMPORT_REJECTED");
  } else await importSession(config, state);
  console.log(
    remote
      ? "Login verified and encrypted on your host. No session export file or server encryption key was saved to this computer."
      : "Login verified. Encrypted session saved under this user's private directory.",
  );
} catch (error) {
  console.error(
    JSON.stringify(
      problem(
        ["AUTH_REQUIRED", "SESSION_IMPORT_REJECTED"].includes(error.message)
          ? error.message
          : "AUTH_REAUTH_REQUIRED",
      ),
    ),
  );
  process.exitCode = 1;
} finally {
  terminal?.close();
  await browser?.close();
}
