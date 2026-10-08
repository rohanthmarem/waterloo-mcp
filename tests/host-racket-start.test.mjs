import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  symlink,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { root } from "../src/config.mjs";
const exec = promisify(execFile);
test("optional runner failure happens after the MCP service has started", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "racket-start-"));
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
      "--racket",
    ]);
    const log = path.join(dir, "commands.jsonl");
    await writeFile(
      path.join(dir, "bin/docker"),
      "#!" +
        process.execPath +
        '\nconst fs=require("node:fs");fs.appendFileSync(' +
        JSON.stringify(log) +
        ',JSON.stringify(process.argv.slice(2))+"\\n");process.exit(process.argv.includes("racket_alice")?1:0);\n',
      { mode: 0o700 },
    );
    await assert.rejects(
      exec(process.execPath, [cli, "start"], {
        env: {
          ...process.env,
          PATH: path.join(dir, "bin") + ":" + process.env.PATH,
        },
      }),
      (e) => e.stderr.includes("HOST_RACKET_START_FAILED"),
    );
    const commands = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(commands.length, 2);
    assert.equal(commands[0].at(-1), "alice");
    assert.equal(commands[1].at(-1), "racket_alice");
    const compose = JSON.parse(
      await readFile(path.join(dir, "private/hosting/compose.json"), "utf8"),
    );
    assert.equal(compose.services.alice.depends_on, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
