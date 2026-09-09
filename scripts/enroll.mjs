import { readConfig, workerEnv } from "../src/config.mjs";
Object.assign(process.env, workerEnv(readConfig()));
// A user-operated feasibility probe, not a deployed MCP login service.
// Never print private keys, passwords, cookies, or authentication URLs.
import { chromium } from "playwright";
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (
  await readFile(
    new URL("../private/DEPLOYED.txt", import.meta.url),
    "utf8",
  ).then(
    () => true,
    () => false,
  )
)
  throw new Error(
    "AUTH_STATE_MOVED: the VM owns this authenticator. Do not use a stale local copy.",
  );
const mode = process.argv[2];
if (!["enroll", "restore"].includes(mode)) {
  console.error("Usage: node scripts/enroll.mjs enroll|restore");
  process.exit(2);
}
if (!process.stdin.isTTY)
  throw new Error("Run this probe from an interactive terminal.");
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
let terminal;
try {
  let prior;
  try {
    prior = await readFile(stateFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (mode === "enroll" && prior)
    throw new Error("Saved credential already exists. Use restore.");
  if (mode === "restore" && !prior)
    throw new Error("No saved credential. Enroll first.");
  const keyFile = path.join(
    process.env.WATERLOO_SECRETS_DIR,
    "authenticator-key",
  );
  let passphrase;
  try {
    passphrase = (await readFile(keyFile, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT" || mode !== "enroll") throw error;
    passphrase = randomBytes(32).toString("hex");
    await writeFile(keyFile, passphrase, { mode: 0o600, flag: "wx" });
  }
  const saved = prior ? unseal(prior, passphrase) : [];
  const automatic = process.argv.includes("--automatic");
  if (
    automatic &&
    (mode !== "restore" || !process.env.WATERLOO_PROBE_USERNAME)
  ) {
    throw new Error(
      "Automatic mode requires restore and WATERLOO_PROBE_USERNAME.",
    );
  }
  let password = automatic
    ? await hiddenPrompt("Waterloo password for this run only (not saved): ")
    : undefined;
  browser = await chromium.launch({
    headless: process.argv.includes("--headless"),
    ...(process.env.WATERLOO_PROBE_BROWSER
      ? { executablePath: process.env.WATERLOO_PROBE_BROWSER }
      : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
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
  cdp.on("WebAuthn.credentialAdded", persist);
  cdp.on("WebAuthn.credentialAsserted", (event) => {
    assertions++;
    persist(event);
  });
  cdp.on("WebAuthn.credentialUpdated", persist);
  console.log(
    mode === "enroll"
      ? "Sign in using your existing factor. Register a separate security key only after approving that account change."
      : "Fresh browser: no cookies were restored. Sign in to LEARN and select the separate security key at Duo.",
  );
  await page.goto(
    mode === "enroll" || process.argv.includes("--device-check")
      ? "https://uwaterloo.login.duosecurity.com/devices"
      : "https://learn.uwaterloo.ca",
    { waitUntil: "domcontentloaded" },
  );
  if (process.env.WATERLOO_PROBE_USERNAME) {
    await page.waitForURL((url) => url.origin === "https://adfs.uwaterloo.ca", {
      timeout: 30000,
    });
    await page
      .locator("input[type=email]")
      .fill(process.env.WATERLOO_PROBE_USERNAME);
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  if (automatic) {
    if (new URL(page.url()).origin !== "https://adfs.uwaterloo.ca")
      throw new Error("Unexpected password destination.");
    await page.locator("input[type=password]").fill(password);
    password = undefined;
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(
      (url) =>
        process.argv.includes("--device-check")
          ? url.origin === "https://cc1.devicemanagement.duosecurity.com" &&
            url.pathname === "/frame/device-management/portal"
          : url.origin === "https://learn.uwaterloo.ca" &&
            url.pathname.startsWith("/d2l/home"),
      { timeout: 60000 },
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
  if (saveFailed || credentialsById.size === 0)
    throw new Error("No usable authenticator was saved.");
  console.log(
    `Automatic password entry: ${automatic}; headless: ${process.argv.includes("--headless")}`,
  );
  if (process.argv.includes("--api-check")) {
    const origin = "https://learn.uwaterloo.ca";
    if (new URL(page.url()).origin !== origin) {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.waitForURL(
        (url) => url.origin === origin && url.pathname.startsWith("/d2l/home"),
        { timeout: 60000 },
      );
    }
    const cookies = (await context.cookies(origin)).filter((c) =>
      ["d2lSessionVal", "d2lSecureSessionVal"].includes(c.name),
    );
    if (cookies.length !== 2)
      throw new Error("Required LEARN session cookies not found.");
    await writes;
    if (saveFailed) throw new Error("Credential persistence failed.");
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
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
    const courses = await get(
      `/d2l/api/lp/${lp}/enrollments/myenrollments/?orgUnitTypeId=3`,
    );
    if (!Array.isArray(courses.Items))
      throw new Error("Unexpected enrollment response.");
    console.log(
      `Browser closed; HTTP identity check passed; course-list page returned ${courses.Items.length} items.`,
    );
  }
  console.log(
    "Enrollment state saved locally. Transfer ownership to one VM before using it for renewal.",
  );
} catch (error) {
  // Third-party errors can contain credential-bearing URLs. Do not echo them.
  console.error(
    "Probe stopped. Inspect the browser and local setup; no raw error or authentication data was logged.",
  );
  process.exitCode = 1;
} finally {
  terminal?.close();
  await browser?.close();
  const { rmdir } = await import("node:fs/promises");
  await rmdir(lockDir);
}
