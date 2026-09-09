import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readConfig, root } from "../src/config.mjs";

let failed = false;
const check = (code, ok, fix) => {
  console.log(
    JSON.stringify({
      code,
      status: ok ? "ok" : "needs_action",
      ...(ok ? {} : { fix }),
    }),
  );
  if (!ok) failed = true;
};
try {
  const config = readConfig();
  check("CONFIG", true);
  for (const [name, file, fix] of [
    ["BUILD", path.join(root, "upstream/build/index.js"), "Run npm run build."],
    [
      "SESSION_KEY",
      path.join(config.secretsDir, "session-key"),
      "Run npm run setup for a fresh installation. Never regenerate a key for existing state.",
    ],
    [
      "CLIENTS",
      path.join(config.secretsDir, "clients.json"),
      "Run npm run setup.",
    ],
    [
      "BROWSER_SESSION",
      path.join(config.stateDir, "browser.json"),
      "Run npm run login.",
    ],
  ])
    check(
      name,
      await access(file).then(
        () => true,
        () => false,
      ),
      fix,
    );
  const keyFile = path.join(config.secretsDir, "session-key");
  try {
    check(
      "KEY_FORMAT",
      /^[a-f0-9]{64}$/.test((await readFile(keyFile, "utf8")).trim()),
      "Restore the original 32-byte hex session key.",
    );
    check(
      "KEY_PERMISSIONS",
      ((await stat(keyFile)).mode & 0o007) === 0,
      "Remove access for other users (chmod 600 locally or 640 in Docker).",
    );
  } catch {}
  const unattended = await access(
    path.join(config.stateDir, "authenticator/authenticator.encrypted.json"),
  ).then(
    () => true,
    () => false,
  );
  console.log(
    JSON.stringify({
      code: "RENEWAL_MODE",
      status: "info",
      mode: unattended
        ? "experimental_authenticator"
        : "saved_session_then_interactive_login",
    }),
  );
  console.log(
    "Doctor does not contact Waterloo or print secrets. Use npm run smoke for live checks.",
  );
} catch {
  check("CONFIG_INVALID", false, "Run npm run setup or correct .env.");
}
process.exitCode = failed ? 1 : 0;
