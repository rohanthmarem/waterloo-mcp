import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  symlink,
  writeFile,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { root } from "../src/config.mjs";
const exec = promisify(execFile);
test("interrupting host start releases its admin lock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "host-signal-"));
  let child;
  try {
    for (const sub of ["src", "scripts", "bin"])
      await mkdir(path.join(dir, sub));
    for (const file of [
      "src/config.mjs",
      "src/hosting.mjs",
      "src/portable-auth.mjs",
      "scripts/host.mjs",
    ])
      await cp(path.join(root, file), path.join(dir, file));
    await symlink(
      path.join(root, "node_modules"),
      path.join(dir, "node_modules"),
    );
    const cli = path.join(dir, "scripts/host.mjs");
    await exec(process.execPath, [cli, "init", "--mode=single"]);
    await exec(process.execPath, [
      cli,
      "add",
      "alice",
      "--origin=https://alice.example.test",
      "--owner=alice@example.test",
      "--username=alice@uwaterloo.ca",
      "--port=8101",
    ]);
    const marker = path.join(dir, "docker-started");
    await writeFile(
      path.join(dir, "bin/docker"),
      "#!" +
        process.execPath +
        '\nrequire("node:fs").writeFileSync(' +
        JSON.stringify(marker) +
        ', "ready");setInterval(()=>{},1000);\n',
      { mode: 0o700 },
    );
    child = spawn(process.execPath, [cli, "start"], {
      env: {
        ...process.env,
        PATH: path.join(dir, "bin") + ":" + process.env.PATH,
      },
      stdio: "ignore",
    });
    const done = new Promise((r) => child.once("exit", r));
    let started = false;
    for (let i = 0; i < 100; i++) {
      if (
        await access(marker).then(
          () => true,
          () => false,
        )
      ) {
        started = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(started, "fake Docker did not start");
    child.kill("SIGINT");
    await done;
    await assert.rejects(
      access(path.join(dir, "private/hosting/.admin.lock")),
      { code: "ENOENT" },
    );
  } finally {
    child?.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
});
