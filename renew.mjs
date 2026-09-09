import "dotenv/config";
import { readConfig, workerEnv } from "./src/config.mjs";
Object.assign(process.env, workerEnv(readConfig()));
// Waterloo saved-session renewal with optional dedicated software authenticator.
// Never print private keys, passwords, cookies, or authentication URLs.
import { chromium } from "playwright";
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.argv.push("--automatic", "--headless", "--api-check");
if (
  await readFile(
    new URL("./private/DEPLOYED.txt", import.meta.url),
    "utf8",
  ).then(
    () => true,
    () => false,
  )
) {
  console.error(
    "AUTH_STATE_MOVED: renew only on the VM that owns this authenticator.",
  );
  process.exit(1);
}
const mode = "restore";
if (!["enroll", "restore"].includes(mode)) {
  console.error("Usage: node probe.mjs enroll|restore");
  process.exit(2);
}

const stateDir = process.env.WATERLOO_PROBE_STATE_DIR
  ? path.resolve(process.env.WATERLOO_PROBE_STATE_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
const stateFile = path.join(stateDir, "authenticator.encrypted.json");
const lockDir = path.join(stateDir, "probe.lock");
await mkdir(stateDir, { recursive: true, mode: 0o700 });
// No concurrent use: restoring an old signature counter can invalidate a key.
await mkdir(lockDir, { mode: 0o700 }).catch(() => {
  throw new Error(
    "Another probe may be running. Inspect state/probe.lock before retrying.",
  );
});

async function hiddenPrompt(label) {
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const c of chunk.toString("utf8")) {
        if (c === "\u0003") return done(new Error("Cancelled."));
        if (c === "\r" || c === "\n") return done();
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

function seal(credentials, passphrase) {
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("waterloo-auth-probe:v1"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials)),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    });
  } finally {
    key.fill(0);
  }
}
function unseal(raw, passphrase) {
  const record = JSON.parse(raw);
  if (record.version !== 1) throw new Error("Unsupported saved state.");
  const key = scryptSync(passphrase, Buffer.from(record.salt, "hex"), 32);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(record.iv, "hex"),
    );
    decipher.setAAD(Buffer.from("waterloo-auth-probe:v1"));
    decipher.setAuthTag(Buffer.from(record.tag, "hex"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "hex")),
        decipher.final(),
      ]),
    );
  } finally {
    key.fill(0);
  }
}

let browser;
let page;
let terminal;
try {
  let prior;
  try {
    prior = await readFile(stateFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    !prior &&
    !(await access(
      path.join(process.env.WATERLOO_STATE_DIR, "browser.json"),
    ).then(
      () => true,
      () => false,
    ))
  )
    throw new Error("AUTH_REAUTH_REQUIRED");
  if (mode === "enroll" && prior)
    throw new Error("Saved credential already exists. Use restore.");

  const passphrase = prior
    ? (
        await readFile(
          path.join(process.env.WATERLOO_SECRETS_DIR, "authenticator-key"),
          "utf8",
        )
      ).trim()
    : undefined;
  const saved = prior ? unseal(prior, passphrase) : [];
  if (saved.length > 0) process.argv.push("--device-check");
  const automatic = process.argv.includes("--automatic");
  if (
    automatic &&
    (mode !== "restore" || !process.env.WATERLOO_PROBE_USERNAME)
  ) {
    throw new Error(
      "Automatic mode requires restore and WATERLOO_PROBE_USERNAME.",
    );
  }
  const { loadConfig } = await import("./upstream/build/utils/config.js");
  const config = await loadConfig();
  let password = config.password;

  const lastAttempt = path.join(stateDir, "last-attempt");
  let last = 0;
  try {
    last = Number(await readFile(lastAttempt, "utf8"));
  } catch {}
  if (Date.now() - last < 120000)
    throw new Error("Authentication cooldown active.");
  await writeFile(lastAttempt, String(Date.now()), { mode: 0o600 });
  browser = await chromium.launch({
    headless: process.argv.includes("--headless"),
    ...(process.env.WATERLOO_PROBE_BROWSER
      ? { executablePath: process.env.WATERLOO_PROBE_BROWSER }
      : {}),
  });
  const { encrypt, decrypt } = await import(
    "./upstream/build/auth/encrypted-store.js"
  );
  const browserKey = Buffer.from(
    (
      await readFile(
        path.join(process.env.WATERLOO_SECRETS_DIR, "session-key"),
        "utf8",
      )
    ).trim(),
    "hex",
  );
  let storageState;
  if (!process.argv.includes("--fresh")) {
    try {
      storageState = JSON.parse(
        decrypt(
          JSON.parse(
            await readFile(
              path.join(process.env.WATERLOO_STATE_DIR, "browser.json"),
              "utf8",
            ),
          ),
          browserKey,
          "waterloo-browser:v1",
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Saved browser state unavailable");
    }
  }
  const context = await browser.newContext(
    storageState ? { storageState } : {},
  );
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  for (const credential of saved) {
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  }
  let writes = Promise.resolve();
  let saveFailed = false;
  let assertions = 0;
  const credentialsById = new Map(saved.map((c) => [c.credentialId, c]));
  const persist = (event) => {
    // Capture the event before Duo redirects. Querying the old page's
    // authenticator afterward can race with a browser process change.
    const previous = credentialsById.get(event.credential.credentialId) ?? {};
    credentialsById.set(event.credential.credentialId, {
      ...previous,
      ...event.credential,
      privateKey: event.credential.privateKey || previous.privateKey,
      rpId: event.credential.rpId || previous.rpId,
    });
    const credentials = [...credentialsById.values()].map((c) => ({ ...c }));
    writes = writes
      .then(async () => {
        if (!credentials.length) return;
        // Save only credentials for the observed Duo service, never unrelated sites.
        if (
          credentials.some(
            (c) =>
              c.rpId !== "duosecurity.com" &&
              !c.rpId.endsWith(".duosecurity.com"),
          )
        ) {
          throw new Error(
            "Unexpected relying-party domain; no credential saved.",
          );
        }
        const temporary = `${stateFile}.pending`;
        await writeFile(temporary, seal(credentials, passphrase), {
          mode: 0o600,
        });
        await rename(temporary, stateFile);
        console.log("Encrypted authenticator state saved.");
      })
      .catch(() => {
        saveFailed = true;
        console.error(
          "Could not save authenticator state. Keep this browser open.",
        );
      });
  };
  async function waitForSignedIn(predicate, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const url = new URL(page.url());
      if (predicate(url)) return;
      if (url.hostname.endsWith(".duosecurity.com")) {
        // Only select this choice when the owner opted in through configuration.
        const shared = page.getByRole("button", {
          name: "Yes, this is my device",
          exact: true,
        });
        if (
          process.env.WATERLOO_REMEMBER_DEVICE === "true" &&
          (await shared.isVisible())
        ) {
          await shared.click();
          console.log("Confirmed: Yes, this is my device.");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Sign-in continuation timed out");
  }
  cdp.on("WebAuthn.credentialAdded", persist);
  cdp.on("WebAuthn.credentialAsserted", (event) => {
    assertions++;
    persist(event);
  });
  cdp.on("WebAuthn.credentialUpdated", persist);
  console.log(
    mode === "enroll"
      ? "Sign in using your existing factor. Register a separate security key only after approving that account change."
      : storageState
        ? "Restoring encrypted remembered browser state."
        : "Fresh browser without saved cookies.",
  );
  await page.goto(
    mode === "enroll" || process.argv.includes("--device-check")
      ? "https://uwaterloo.login.duosecurity.com/devices"
      : "https://learn.uwaterloo.ca",
    { waitUntil: "domcontentloaded" },
  );
  if (
    new URL(page.url()).origin === "https://adfs.uwaterloo.ca" &&
    (await page.locator("input[type=email]").isVisible())
  ) {
    await page.waitForURL((url) => url.origin === "https://adfs.uwaterloo.ca", {
      timeout: 30000,
    });
    await page
      .locator("input[type=email]")
      .fill(process.env.WATERLOO_PROBE_USERNAME);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page
      .locator("input[type=password]")
      .waitFor({ state: "visible", timeout: 15000 });
  }
  if (automatic) {
    if (
      new URL(page.url()).origin === "https://adfs.uwaterloo.ca" &&
      (await page.locator("input[type=password]").isVisible())
    ) {
      if (new URL(page.url()).origin !== "https://adfs.uwaterloo.ca")
        throw new Error("Unexpected password destination.");
      if (!password) throw new Error("AUTH_REAUTH_REQUIRED");
      await page.locator("input[type=password]").fill(password);
      password = undefined;
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }
    await waitForSignedIn((url) =>
      process.argv.includes("--device-check")
        ? url.origin === "https://cc1.devicemanagement.duosecurity.com" &&
          url.pathname === "/frame/device-management/portal"
        : url.origin === "https://learn.uwaterloo.ca" &&
          url.pathname.startsWith("/d2l/home"),
    );
  } else {
    terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await terminal.question(
      "After the site shows the result, press Enter here to record the limited check: ",
    );
  }
  await writes;
  const finalUrl = new URL(page.url());
  console.log(`Authenticator assertions observed: ${assertions}`);
  console.log(
    `Returned to LEARN home: ${finalUrl.origin === "https://learn.uwaterloo.ca" && finalUrl.pathname.startsWith("/d2l/home")}`,
  );
  console.log(
    `Returned to device management: ${finalUrl.origin === "https://cc1.devicemanagement.duosecurity.com" && finalUrl.pathname === "/frame/device-management/portal"}`,
  );
  console.log(`State persistence passed: ${!saveFailed}`);
  if (saveFailed)
    throw new Error(
      "State persistence failed; do not treat this run as successful.",
    );
  console.log(
    `Automatic password entry: ${automatic}; headless: ${process.argv.includes("--headless")}`,
  );
  if (process.argv.includes("--api-check")) {
    const origin = "https://learn.uwaterloo.ca";
    if (new URL(page.url()).origin !== origin) {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForSignedIn(
        (url) => url.origin === origin && url.pathname.startsWith("/d2l/home"),
      );
    }
    const cookies = (await context.cookies(origin)).filter((c) =>
      ["d2lSessionVal", "d2lSecureSessionVal"].includes(c.name),
    );
    if (cookies.length !== 2)
      throw new Error("Required LEARN session cookies not found.");
    await writes;
    if (saveFailed) throw new Error("Credential persistence failed.");
    if (process.argv.includes("--fresh") && assertions < 1)
      throw new Error("No authenticator assertion observed.");
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const remembered = await context.storageState();
    await writeFile(
      path.join(process.env.WATERLOO_STATE_DIR, "browser.pending"),
      JSON.stringify(
        encrypt(JSON.stringify(remembered), browserKey, "waterloo-browser:v1"),
      ),
      { mode: 0o600 },
    );
    await rename(
      path.join(process.env.WATERLOO_STATE_DIR, "browser.pending"),
      path.join(process.env.WATERLOO_STATE_DIR, "browser.json"),
    );
    browserKey.fill(0);
    await browser.close();
    browser = undefined;
    const get = async (route) => {
      const response = await fetch(origin + route, {
        headers: { Cookie: cookie, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("json")
      )
        throw new Error("API request did not return successful JSON.");
      return response.json();
    };
    const versions = await get("/d2l/api/versions/");
    const lp = versions.find((v) => v.ProductCode === "lp")?.LatestVersion;
    if (!/^\d+\.\d+$/.test(lp ?? "")) throw new Error("No valid LP version.");
    const identity = await get(`/d2l/api/lp/${lp}/users/whoami`);
    if (!identity.Identifier)
      throw new Error("Identity response did not identify a user.");
    if (
      identity.UniqueName?.toLowerCase() !==
      process.env.D2L_USERNAME.split("@")[0].toLowerCase()
    )
      throw new Error("Wrong Waterloo account");
    const courses = await get(
      `/d2l/api/lp/${lp}/enrollments/myenrollments/?orgUnitTypeId=3`,
    );
    if (!Array.isArray(courses.Items))
      throw new Error("Unexpected enrollment response.");
    const { SessionStore } = await import(
      "./upstream/build/auth/session-store.js"
    );
    await new SessionStore(config.sessionDir).save({
      accessToken: "cookie:" + cookie,
      capturedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      source: "browser",
      tenantOrigin: origin,
    });
    console.log(
      `Browser closed; HTTP identity check passed; course-list page returned ${courses.Items.length} items.`,
    );
  }
  console.log("Session renewal and browser-free API check passed.");
} catch (error) {
  // Third-party errors can contain credential-bearing URLs. Do not echo them.
  console.error(
    JSON.stringify({
      error: {
        code: "AUTH_REAUTH_REQUIRED",
        message:
          "Waterloo login needs attention. Run npm run login, or inspect your optional authenticator setup.",
      },
    }),
  );
  process.exitCode = 1;
} finally {
  terminal?.close();
  await browser?.close();
  const { rmdir } = await import("node:fs/promises");
  await rmdir(lockDir);
}
