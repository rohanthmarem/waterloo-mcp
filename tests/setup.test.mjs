import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  cp,
  symlink,
  readFile,
  writeFile,
  stat,
  readdir,
  rm,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { root } from "../src/config.mjs";
const exec = promisify(execFile);

test("fresh setup, key preservation, signed client token and revocation through CLI", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "waterloo-onboarding-"));
  const run = (script, args = []) =>
    exec(process.execPath, [path.join(dir, "scripts", script), ...args], {
      cwd: dir,
    });
  try {
    await cp(path.join(root, "scripts"), path.join(dir, "scripts"), {
      recursive: true,
    });
    await cp(path.join(root, "src"), path.join(dir, "src"), {
      recursive: true,
    });
    await symlink(
      path.join(root, "node_modules"),
      path.join(dir, "node_modules"),
      "dir",
    );
    const args = [
      "--origin=https://example.exe.xyz",
      "--owner=owner@example.test",
      "--username=student@uwaterloo.ca",
    ];
    await run("setup.mjs", args);
    const keyFile = path.join(dir, "private/secrets/session-key");
    const key = await readFile(keyFile, "utf8");
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    await assert.rejects(run("setup.mjs", args), /SETUP_FAILED/);
    assert.equal(await readFile(keyFile, "utf8"), key);
    const signingKey = path.join(dir, "fixture-key");
    await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", signingKey]);
    const issued = await run("client.mjs", ["issue", "test-agent", signingKey]);
    assert(!issued.stdout.includes("exe0."));
    const clientDir = path.join(dir, "private/clients");
    const tokenFile = (await readdir(clientDir)).find((f) =>
      f.endsWith(".token"),
    );
    const token = await readFile(path.join(clientDir, tokenFile), "utf8");
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    assert.deepEqual(payload.cmds, []);
    assert.equal(payload.ctx.role, "mcp");
    const registry = JSON.parse(
      await readFile(path.join(dir, "private/secrets/clients.json"), "utf8"),
    );
    assert.equal(registry[0].id, payload.ctx.id);
    assert.equal(registry[0].enabled, true);
    assert.equal(
      (await stat(path.join(clientDir, tokenFile))).mode & 0o777,
      0o600,
    );
    // ssh-keygen confirms the actual output signature has the expected VM namespace.
    const signatureFile = path.join(
      clientDir,
      tokenFile.replace(".token", ".payload.sig"),
    );
    const signedPayload = path.join(
      clientDir,
      tokenFile.replace(".token", ".payload"),
    );
    await new Promise((resolve, reject) => {
      const child = execFile(
        "ssh-keygen",
        [
          "-Y",
          "check-novalidate",
          "-n",
          "v0@example.exe.xyz",
          "-s",
          signatureFile,
        ],
        (error) => (error ? reject(error) : resolve()),
      );
      readFile(signedPayload).then((bytes) => child.stdin.end(bytes), reject);
    });
    await run("client.mjs", ["revoke", "test-agent"]);
    const revoked = JSON.parse(
      await readFile(path.join(dir, "private/secrets/clients.json"), "utf8"),
    );
    assert.equal(revoked[0].enabled, false);
    await run("client.mjs", ["issue", "test-agent", signingKey]);
    assert.equal(
      JSON.parse(
        await readFile(path.join(dir, "private/secrets/clients.json"), "utf8"),
      ).length,
      2,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
