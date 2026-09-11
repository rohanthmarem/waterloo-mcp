import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
  stat,
  chown,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tokenHash } from "../src/portable-auth.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readConfig, root } from "../src/config.mjs";

const exec = promisify(execFile);
const [command, name, signingKey] = process.argv.slice(2);
if (
  !["issue", "revoke", "list"].includes(command) ||
  (command !== "list" && !/^[a-z0-9-]{1,40}$/.test(name ?? ""))
) {
  console.log(
    "Usage: npm run client -- issue NAME [legacy-exe-SSH-key]\n       npm run client -- revoke NAME\n       npm run client -- list",
  );
  process.exit(2);
}
let release;
try {
  const config = readConfig();
  const file = path.join(config.secretsDir, "clients.json");
  const lock = await open(file + ".lock", "wx", 0o600);
  release = async () => {
    await lock.close();
    await unlink(file + ".lock");
  };
  const clients = JSON.parse(await readFile(file, "utf8"));
  if (command === "list") {
    console.log(
      JSON.stringify(
        clients.map(({ name, enabled, expiresAt }) => ({
          name,
          enabled,
          expiresAt,
        })),
        null,
        2,
      ),
    );
  } else if (command === "revoke") {
    if (!clients.some((c) => c.name === name))
      throw new Error("Unknown client name");
    clients
      .filter((c) => c.name === name)
      .forEach((c) => {
        c.enabled = false;
      });
  } else if (command === "issue") {
    if (
      config.authMode === "exedev" &&
      (!signingKey || !path.isAbsolute(signingKey))
    )
      throw new Error("Use an absolute SSH signing key path.");
    if (clients.some((c) => c.name === name && c.enabled))
      throw new Error(
        "Client already exists. Revoke it before issuing a replacement.",
      );
    const id = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 90 * 86400000;
    const dir = path.join(config.home, "private/clients");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let token;
    if (config.authMode === "portable")
      token = "wm1_" + randomBytes(32).toString("base64url");
    else {
      const payload = Buffer.from(
        JSON.stringify({
          exp: Math.floor(expiresAt / 1000),
          cmds: [],
          ctx: { role: "mcp", id },
        }),
      );
      // ssh-keygen signs a file, so no secret is interpolated into a shell command.
      const payloadFile = path.join(dir, name + "-" + id + ".payload");
      await writeFile(payloadFile, payload, { mode: 0o600, flag: "wx" });
      await exec("ssh-keygen", [
        "-Y",
        "sign",
        "-f",
        signingKey,
        "-n",
        "v0@" + new URL(config.origin).hostname,
        payloadFile,
      ]);
      const signature = (await readFile(payloadFile + ".sig", "utf8"))
        .trim()
        .split("\n")
        .slice(1, -1)
        .join("");
      token =
        "exe0." +
        payload.toString("base64url") +
        "." +
        Buffer.from(signature, "base64").toString("base64url");
    }
    const tokenFile = path.join(dir, name + "-" + id + ".token");
    await writeFile(tokenFile, token, { mode: 0o600, flag: "wx" });
    clients.push({
      name,
      id,
      enabled: true,
      expiresAt,
      ...(config.authMode === "portable"
        ? { tokenHash: tokenHash(token) }
        : {}),
    });
    console.log(
      "Token saved to " +
        tokenFile +
        ". Import it into your agent secret store; do not paste it into chat.",
    );
  }
  if (command !== "list") {
    await writeFile(file + ".pending", JSON.stringify(clients, null, 2), {
      mode: 0o600,
    });
    if (process.getuid?.() === 0) {
      const { uid, gid } = await stat(file);
      await chown(file + ".pending", uid, gid);
    }
    await rename(file + ".pending", file);
    console.log(
      "Client registry updated. A locally hosted instance reads it immediately. For a remote deployment, transfer only this user’s registry through your secure administration channel.",
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        code: error.code === "EEXIST" ? "CLIENT_BUSY" : "CLIENT_SETUP_FAILED",
        message: "Client operation did not complete.",
        action:
          "Check the client name, setup files, and SSH signing key. If clients.json.lock exists, confirm no client command is running before removing it.",
      },
    }),
  );
  process.exitCode = 1;
} finally {
  await release?.();
}
