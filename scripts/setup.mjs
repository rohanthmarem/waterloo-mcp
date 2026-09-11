import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { provisionOwner } from "../src/portable-auth.mjs";
import { root, readConfig } from "../src/config.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")),
);
if (args.help !== undefined) {
  console.log(
    "npm run setup -- --origin=https://YOUR-VM.exe.xyz --owner=EXE_ACCOUNT_EMAIL --username=USERID@uwaterloo.ca",
  );
  process.exit(0);
}
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});
try {
  const existing = await access(path.join(root, ".env")).then(
    () => true,
    () => false,
  );
  if (existing)
    throw new Error(
      "Setup already exists. Edit .env directly; setup never replaces keys.",
    );
  const ask = async (key, label) =>
    args[key] ?? (await terminal.question(label + ": "));
  const origin = await ask(
    "origin",
    "Your HTTPS service URL (or http://localhost:8000 for local use)",
  );
  const authMode =
    args.auth ??
    (new URL(origin).hostname.endsWith(".exe.xyz") ? "exedev" : "portable");
  const owner = await ask(
    "owner",
    "Owner email (exe.dev account email in exedev mode)",
  );
  const username = await ask(
    "username",
    "Waterloo username (userid@uwaterloo.ca)",
  );
  const config = readConfig({
    WATERLOO_AUTH_MODE: authMode,
    WATERLOO_ORIGIN: origin,
    WATERLOO_OWNER_EMAIL: owner,
    D2L_USERNAME: username,
  });
  if (![origin, owner, username].every((v) => /^[A-Za-z0-9@.:/_+-]+$/.test(v)))
    throw new Error("Invalid configuration characters");
  await mkdir(path.join(root, "private"), { mode: 0o700 });
  for (const dir of [
    config.stateDir,
    config.secretsDir,
    path.join(root, "private/clients"),
    path.join(config.stateDir, "downloads"),
  ])
    await mkdir(dir, { mode: 0o700, recursive: true });
  await writeFile(
    path.join(config.secretsDir, "session-key"),
    randomBytes(32).toString("hex"),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(path.join(config.secretsDir, "clients.json"), "[]\n", {
    mode: 0o600,
    flag: "wx",
  });
  if (authMode === "portable")
    await provisionOwner(
      config.secretsDir,
      path.join(root, "private/owner.token"),
    );
  await writeFile(
    path.join(root, ".env"),
    `WATERLOO_AUTH_MODE=${authMode}\nWATERLOO_ORIGIN=${config.origin}\nWATERLOO_OWNER_EMAIL=${config.owner}\nD2L_USERNAME=${config.username}\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    (authMode === "portable"
      ? "Setup saved. Owner key: private/owner.token (keep it private; sign in at /login). "
      : "Setup saved for private exe.dev authentication. ") +
      "Next: npm run build, npx playwright install chromium, npm run login.",
  );
} catch (error) {
  console.error(
    JSON.stringify({ error: { code: "SETUP_FAILED", message: error.message } }),
  );
  process.exitCode = 1;
} finally {
  terminal.close();
}
