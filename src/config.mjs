import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
dotenv.config({
  path: path.join(process.env.WATERLOO_HOME ?? root, ".env"),
  quiet: true,
});
export function readConfig(env = process.env) {
  const home = path.resolve(env.WATERLOO_HOME ?? root);
  const authMode = env.WATERLOO_AUTH_MODE ?? "exedev";
  if (!["exedev", "portable"].includes(authMode))
    throw new Error("CONFIG_INVALID");
  const origin = new URL(env.WATERLOO_ORIGIN ?? "http://127.0.0.1:8000");
  const local = ["127.0.0.1", "localhost"].includes(origin.hostname);
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    (!local && origin.protocol !== "https:") ||
    !["https:", "http:"].includes(origin.protocol)
  )
    throw new Error("CONFIG_INVALID");
  if (!env.WATERLOO_OWNER_EMAIL?.includes("@"))
    throw new Error("CONFIG_INVALID");
  if (!/^[a-z0-9._-]+@uwaterloo\.ca$/i.test(env.D2L_USERNAME ?? ""))
    throw new Error("CONFIG_INVALID");
  const port = Number(env.PORT ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CONFIG_INVALID");
  return {
    home,
    authMode,
    origin: origin.origin,
    owner: env.WATERLOO_OWNER_EMAIL.toLowerCase(),
    port,
    bind: env.WATERLOO_BIND ?? "127.0.0.1",
    username: env.D2L_USERNAME,
    stateDir: path.resolve(
      env.WATERLOO_STATE_DIR ?? path.join(home, "private/state"),
    ),
    secretsDir: path.resolve(
      env.WATERLOO_SECRETS_DIR ?? path.join(home, "private/secrets"),
    ),
  };
}
export function workerEnv(config) {
  return {
    ...process.env,
    WATERLOO_SERVICE: "1",
    // The worker never shows its update notice in service mode; skip the
    // registry.npmjs.org request it would otherwise make on every start.
    D2L_NO_UPDATE_CHECK: "1",
    D2L_BASE_URL: "https://learn.uwaterloo.ca",
    D2L_USERNAME: config.username,
    WATERLOO_PROBE_USERNAME: config.username,
    WATERLOO_STATE_DIR: config.stateDir,
    WATERLOO_SECRETS_DIR: config.secretsDir,
    D2L_SESSION_DIR: path.join(config.stateDir, "sessions"),
    WATERLOO_PROBE_STATE_DIR: path.join(config.stateDir, "authenticator"),
    WATERLOO_RENEW_SCRIPT: path.join(root, "renew.mjs"),
  };
}
