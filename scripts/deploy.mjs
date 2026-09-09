import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "../src/config.mjs";

const [host, mode = "init"] = process.argv.slice(2);
if (
  !/^[a-z0-9-]+\.exe\.xyz$/.test(host ?? "") ||
  !["init", "code", "session", "clients"].includes(mode)
) {
  console.log(
    "Usage: npm run deploy -- YOUR-VM.exe.xyz [init|code|session|clients]",
  );
  process.exit(2);
}
const remote = "/home/exedev/workspace/waterloo-mcp";
const run = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("DEPLOY_FAILED")),
    );
  });
async function upload(files, excludes = []) {
  await new Promise((resolve, reject) => {
    const tar = spawn(
      "tar",
      [
        "-C",
        root,
        ...excludes.map((x) => "--exclude=" + x),
        "-czf",
        "-",
        ...files,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const ssh = spawn(
      "ssh",
      [host, `sudo -n tar -xzf - -C ${remote} --no-same-owner`],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    tar.stdout.pipe(ssh.stdin);
    ssh.stdin.on("error", () => {});
    let remaining = 2;
    let failed = false;
    for (const child of [tar, ssh]) {
      child.on("error", (error) => {
        failed = true;
        reject(error);
      });
      child.on("exit", (code) => {
        failed ||= code !== 0;
        if (--remaining === 0)
          failed ? reject(new Error("DEPLOY_FAILED")) : resolve();
      });
    }
  });
}
try {
  if (mode === "init") {
    await access(path.join(root, "private/state/browser.json"));
    await run("ssh", [
      host,
      `mkdir -p /home/exedev/workspace; test ! -e ${remote} && mkdir -m 700 ${remote}`,
    ]);
  } else await run("ssh", [host, `test -d ${remote}/private`]);
  if (mode === "init" || mode === "code")
    await upload(
      ["."],
      [
        ".git",
        "node_modules",
        "upstream/build",
        "private",
        ".env",
        "*.zip",
        "*.log",
      ],
    );
  if (mode === "init") {
    // Claim ownership before sending any credentials, even if deployment later fails.
    await writeFile(
      path.join(root, "private/DEPLOYED.txt"),
      "Authenticator ownership transferred or transfer attempted. Never use or redeploy a stale local authenticator copy.\n",
      { mode: 0o600, flag: "wx" },
    );
    await upload([".env", "private/state", "private/secrets"]);
  }
  if (mode === "session") {
    // Never copies or rewinds the dedicated authenticator counter.
    await run("ssh", [host, `cd ${remote} && sudo -n docker compose stop mcp`]);
    await upload(["private/state/browser.json", "private/state/sessions"]);
  }
  if (mode === "clients") await upload(["private/secrets/clients.json"]);
  await run("ssh", [
    host,
    `sudo -n chown -R 1001:1001 ${remote}/private/state; sudo -n chmod 700 ${remote}/private/state; sudo -n chown -R root:1001 ${remote}/private/secrets; sudo -n chmod 750 ${remote}/private/secrets; sudo -n find ${remote}/private/secrets -type f -exec chmod 640 {} +`,
  ]);
  if (mode !== "clients")
    await run("ssh", [
      host,
      `cd ${remote} && sudo -n docker compose up -d --build`,
    ]);
  console.log(
    "Deployment complete. Confirm the exe.dev preview is private and routes to port 8000. Then run npm run smoke.",
  );
} catch {
  console.error(
    "DEPLOY_FAILED: check SSH, sudo, Docker, and disk space. init refuses to replace an existing installation.",
  );
  process.exitCode = 1;
}
