import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, unlink } from "node:fs/promises";
import {
  hostingDir,
  initializeHost,
  addHostUser,
  renderHost,
  auditHost,
  auditRunningHost,
  loadHost,
  userHome,
} from "../src/hosting.mjs";
import { root } from "../src/config.mjs";
const [command, ...args] = process.argv.slice(2);
const flags = Object.fromEntries(
  args
    .filter((v) => v.startsWith("--") && v.includes("="))
    .map((v) => {
      const i = v.indexOf("=");
      return [v.slice(2, i), v.slice(i + 1)];
    }),
);
const dir = hostingDir();
const capture = promisify(execFile);
async function runningAudit() {
  if (stopping) throw new Error("HOST_INTERRUPTED");
  const { stdout } = await capture("docker", [
    "compose",
    "-f",
    path.join(dir, "compose.json"),
    "ps",
    "-a",
    "-q",
  ]);
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
    throw new Error("HOST_INSPECT_FAILED");
  const containers = ids.length
    ? JSON.parse(
        (
          await capture("docker", ["inspect", ...ids], {
            maxBuffer: 4 * 1024 * 1024,
          })
        ).stdout,
      )
    : [];
  const report = await auditRunningHost(dir, containers);
  console.log(JSON.stringify(report));
  if (!report.passed) throw new Error("HOST_ISOLATION_FAILED");
}
let activeChild;
let stopping;
const run = (command, args, env = process.env) =>
  new Promise((resolve, reject) => {
    if (stopping) return reject(new Error("HOST_INTERRUPTED"));
    const child = spawn(command, args, {
      stdio: "inherit",
      env,
      detached: command === "docker",
    });
    activeChild = child;
    child.on("error", reject);
    child.on("exit", (code) => {
      if (activeChild === child) activeChild = undefined;
      code === 0 ? resolve() : reject(new Error("HOST_COMMAND_FAILED"));
    });
  });
let adminLock, releasePromise;
function releaseAdminLock() {
  return (releasePromise ??= (async () => {
    if (adminLock) {
      await adminLock.close();
      await unlink(path.join(dir, ".admin.lock"));
      adminLock = undefined;
    }
  })());
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = signal;
    const child = activeChild;
    if (!child) return; // Let an in-progress file operation finish before finally unlocks.
    const terminate = (signal) => {
      try {
        if (child.spawnfile === "docker") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    };
    terminate(signal);
    const timer = setTimeout(() => {
      if (activeChild === child) terminate("SIGKILL");
    }, 5000);
    timer.unref();
    // Do not exit or unlock here: run() must observe child exit, then finally unlocks.
  });

try {
  if (["init", "add", "render", "start", "stop"].includes(command)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      adminLock = await open(path.join(dir, ".admin.lock"), "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("HOST_ADMIN_BUSY");
      throw error;
    }
  }
  if (command === "init") {
    await initializeHost(dir, flags.mode ?? "single");
    console.log(
      "Host created. Add a user with npm run host -- add NAME --origin=URL --owner=EMAIL --username=USER@uwaterloo.ca --port=8001",
    );
  } else if (command === "add")
    console.log(
      JSON.stringify(
        await addHostUser(dir, {
          id: args[0],
          origin: flags.origin,
          owner: flags.owner,
          username: flags.username,
          port: Number(flags.port),
        }),
      ),
    );
  else if (command === "render") {
    await renderHost(dir);
    console.log("Compose and Caddy configuration updated.");
  } else if (command === "audit" || command === "start") {
    const audit = await auditHost(dir);
    console.log(JSON.stringify(audit));
    if (!audit.passed || !audit.users) throw new Error("HOST_ISOLATION_FAILED");
    if (command === "start")
      await run("docker", [
        "compose",
        "-f",
        path.join(dir, "compose.json"),
        "up",
        "-d",
        "--build",
      ]);
    if (command === "start" || args.includes("--running")) await runningAudit();
  } else if (command === "stop" || command === "status")
    await run("docker", [
      "compose",
      "-f",
      path.join(dir, "compose.json"),
      command === "stop" ? "stop" : "ps",
    ]);
  else if (["client", "login", "doctor", "owner"].includes(command)) {
    const m = await loadHost(dir);
    if (!m.users.some((u) => u.id === args[0]))
      throw new Error("HOST_USER_NOT_FOUND");
    // Each CLI runs in a fresh process with exactly this user's .env and data root.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          !k.startsWith("WATERLOO_") &&
          !k.startsWith("D2L_") &&
          !["PORT", "DOTENV_CONFIG_PATH"].includes(k),
      ),
    );
    await run(
      process.execPath,
      [
        path.join(root, "scripts", command + ".mjs"),
        ...(command === "login"
          ? [
              "--remote=" + m.users.find((u) => u.id === args[0]).origin,
              "--token-file=" +
                path.join(userHome(dir, args[0]), "private/owner.token"),
            ]
          : args.slice(1)),
      ],
      { ...env, WATERLOO_HOME: userHome(dir, args[0]) },
    );
  } else
    console.log(
      "npm run host -- init --mode=single|multi\n npm run host -- add NAME --origin=https://NAME.example.com --owner=EMAIL --username=USER@uwaterloo.ca --port=8001\n npm run host -- start|stop|status|audit|render\n npm run host -- client NAME issue AGENT\n npm run host -- login NAME\n npm run host -- doctor NAME\n npm run host -- audit --running\n npm run host -- owner NAME rotate",
    );
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        code: error.message?.startsWith("HOST_")
          ? error.message
          : "HOST_SETUP_FAILED",
        action:
          "Check setup arguments and private/hosting. Existing user directories and keys are never replaced. Run audit before starting.",
      },
    }),
  );
  process.exitCode = 1;
} finally {
  await releaseAdminLock();
  if (stopping) process.exitCode = stopping === "SIGINT" ? 130 : 143;
}
