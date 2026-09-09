import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import path from "node:path";
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
  const origin = await ask("origin", "Your private exe.dev HTTPS URL");
  const owner = await ask("owner", "Email used to sign in to exe.dev");
  const username = await ask(
    "username",
    "Waterloo username (userid@uwaterloo.ca)",
  );
  const config = readConfig({
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
  await writeFile(
    path.join(root, ".env"),
    `WATERLOO_ORIGIN=${config.origin}\nWATERLOO_OWNER_EMAIL=${config.owner}\nD2L_USERNAME=${config.username}\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Setup saved. Next: npm run build, npx playwright install chromium, npm run login.",
  );
} catch (error) {
  console.error(
    JSON.stringify({ error: { code: "SETUP_FAILED", message: error.message } }),
  );
  process.exitCode = 1;
} finally {
  terminal.close();
}
