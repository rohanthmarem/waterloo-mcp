// Prepare a throwaway state/secrets directory with an encrypted worker session that
// authenticates against the fake LEARN server. Nothing here touches private/.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { encrypt } from "../upstream/build/auth/encrypted-store.js";
import { root } from "../src/config.mjs";
import { TOKEN } from "./fake-learn.mjs";
import { USERNAME } from "./fixtures.mjs";

export async function prepareState({ baseUrl, certPath }) {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-state-"));
  const stateDir = path.join(dir, "state");
  const secretsDir = path.join(dir, "secrets");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  await writeFile(path.join(secretsDir, "session-key"), key.toString("hex"), {
    mode: 0o600,
  });
  await writeFile(
    path.join(secretsDir, "clients.json"),
    JSON.stringify([
      { id: "bench-client", enabled: true, expiresAt: Date.now() + 3600000 },
    ]),
  );
  const username = `${USERNAME}@uwaterloo.ca`;
  const account = createHash("sha256")
    .update(JSON.stringify([new URL(baseUrl).origin, username]))
    .digest("hex");
  const sessionDir = path.join(stateDir, "sessions", "accounts", account);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const token = {
    accessToken: TOKEN,
    tenantOrigin: new URL(baseUrl).origin,
    capturedAt: now,
    expiresAt: now + 3600000,
    source: "browser",
  };
  await writeFile(
    path.join(sessionDir, "session.json"),
    JSON.stringify({
      version: 2,
      kind: "session",
      encrypted: encrypt(
        JSON.stringify(token),
        key,
        "brightspace-mcp-server:2:session",
      ),
    }),
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    WATERLOO_SERVICE: "1",
    D2L_BASE_URL: baseUrl,
    D2L_USERNAME: username,
    WATERLOO_PROBE_USERNAME: username,
    WATERLOO_STATE_DIR: stateDir,
    WATERLOO_SECRETS_DIR: secretsDir,
    D2L_SESSION_DIR: path.join(stateDir, "sessions"),
    WATERLOO_PROBE_STATE_DIR: path.join(stateDir, "authenticator"),
    WATERLOO_RENEW_SCRIPT: path.join(root, "renew.mjs"),
    NODE_EXTRA_CA_CERTS: certPath,
    D2L_NO_UPDATE_CHECK: "1",
    HOME: dir,
  };
  return { dir, stateDir, secretsDir, env, username };
}
