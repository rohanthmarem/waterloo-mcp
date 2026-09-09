import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
    "Usage: npm run client -- issue NAME /absolute/path/to/exe-ssh-key\n       npm run client -- revoke NAME\n       npm run client -- list",
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
    if (!signingKey || !path.isAbsolute(signingKey))
      throw new Error("Use an absolute SSH signing key path.");
    if (clients.some((c) => c.name === name && c.enabled))
      throw new Error(
        "Client already exists. Revoke it before issuing a replacement.",
      );
    const id = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 90 * 86400000;
    const payload = Buffer.from(
      JSON.stringify({
        exp: Math.floor(expiresAt / 1000),
        cmds: [],
        ctx: { role: "mcp", id },
      }),
    );
    const dir = path.join(root, "private/clients");
    await mkdir(dir, { recursive: true, mode: 0o700 });
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
    const token =
      "exe0." +
      payload.toString("base64url") +
      "." +
      Buffer.from(signature, "base64").toString("base64url");
    const tokenFile = path.join(dir, name + "-" + id + ".token");
    await writeFile(tokenFile, token, { mode: 0o600, flag: "wx" });
    clients.push({ name, id, enabled: true, expiresAt });
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
    await rename(file + ".pending", file);
    console.log(
      "Client registry updated. Deploy private/secrets/clients.json to apply the change on the VM.",
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
