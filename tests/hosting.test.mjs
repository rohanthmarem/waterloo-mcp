import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  initializeHost,
  addHostUser,
  auditHost,
  loadHost,
  userHome,
  renderHost,
} from "../src/hosting.mjs";
import { root, readConfig } from "../src/config.mjs";
import { importSession } from "../src/import-session.mjs";
import { decrypt } from "../upstream/build/auth/encrypted-store.js";
import { PortableAuth } from "../src/portable-auth.mjs";
const exec = promisify(execFile);
const alice = {
  id: "alice",
  origin: "https://alice.example.test",
  owner: "alice@example.test",
  username: "alice@uwaterloo.ca",
  port: 8101,
};
const bob = {
  id: "bob",
  origin: "https://bob.example.test",
  owner: "bob@example.test",
  username: "bob@uwaterloo.ca",
  port: 8102,
};
async function fixture(run, mode = "multi") {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "hosting-test-")),
  );
  try {
    await initializeHost(dir, mode);
    await addHostUser(dir, alice);
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("single-user mode refuses a second user; multi-user mode rejects shared cookie hostnames and identities", () =>
  fixture(async (dir) => {
    await assert.rejects(addHostUser(dir, bob), /HOST_SINGLE_USER_LIMIT/);
    assert.equal((await auditHost(dir)).passed, true);
    const manifest = JSON.parse(
      await readFile(path.join(dir, "host.json"), "utf8"),
    );
    manifest.mode = "multi";
    await writeFile(path.join(dir, "host.json"), JSON.stringify(manifest));
    await assert.rejects(
      addHostUser(dir, { ...bob, origin: "https://alice.example.test:9999" }),
      /HOST_SHARED_COOKIE_HOST/,
    );
    await assert.rejects(
      addHostUser(dir, { ...bob, username: alice.username }),
      /HOST_DUPLICATE_USER_CONFIG/,
    );
    await assert.rejects(
      addHostUser(dir, { ...bob, origin: "http://localhost:8001" }),
      /HOST_LOCAL_PORT_MISMATCH/,
    );
    await addHostUser(dir, bob);
    assert.equal((await loadHost(dir)).users.length, 2);
    await assert.rejects(addHostUser(dir, bob), /HOST_DUPLICATE_USER_CONFIG/);
    assert.equal((await auditHost(dir)).passed, true);
  }, "single"));
test("isolation audit catches duplicate encryption keys, shared paths, and unsafe container settings without printing secrets", () =>
  fixture(async (dir) => {
    await addHostUser(dir, bob);
    const a = path.join(userHome(dir, "alice"), "private/secrets/session-key"),
      b = path.join(userHome(dir, "bob"), "private/secrets/session-key");
    const before = await readFile(b, "utf8"),
      secret = await readFile(a, "utf8");
    await writeFile(b, secret);
    let report = await auditHost(dir);
    assert(!report.passed);
    assert(report.findings.some((x) => x.code === "DISTINCT_ENCRYPTION_KEY"));
    assert(!JSON.stringify(report).includes(secret));
    await writeFile(b, before);
    const p = path.join(userHome(dir, "bob"), "private/state");
    await rename(p, p + ".original");
    await symlink(path.join(userHome(dir, "alice"), "private/state"), p);
    report = await auditHost(dir);
    assert(!report.passed);
    assert(report.findings.some((x) => x.code === "PRIVATE_REAL_DIRECTORY"));
    await rm(p);
    await rename(p + ".original", p);
    const file = path.join(dir, "compose.json"),
      compose = JSON.parse(await readFile(file, "utf8"));
    compose.services.bob.privileged = true;
    compose.services.bob.volumes.push({
      source: "/var/run/docker.sock",
      target: "/var/run/docker.sock",
      type: "bind",
    });
    await writeFile(file, JSON.stringify(compose));
    report = await auditHost(dir);
    assert(!report.passed);
    assert(report.findings.some((x) => x.code === "EXACT_ISOLATED_COMPOSE"));
    await renderHost(dir);
    assert.equal((await auditHost(dir)).passed, true);
  }));
test("portable agent CLI uses the selected user's home, hashes tokens, and revokes only that user's client", () =>
  fixture(async (dir) => {
    await addHostUser(dir, bob);
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          !k.startsWith("WATERLOO_") && !k.startsWith("D2L_") && k !== "PORT",
      ),
    );
    for (const id of ["alice", "bob"]) {
      const result = await exec(
        process.execPath,
        [path.join(root, "scripts/client.mjs"), "issue", "agent"],
        { env: { ...clean, WATERLOO_HOME: userHome(dir, id) } },
      );
      assert(!result.stdout.includes("wm1_"));
    }
    const file = (id) =>
      path.join(userHome(dir, id), "private/secrets/clients.json");
    const a = JSON.parse(await readFile(file("alice"), "utf8")),
      b = JSON.parse(await readFile(file("bob"), "utf8"));
    assert.match(a[0].tokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(a[0].tokenHash, b[0].tokenHash);
    await exec(
      process.execPath,
      [path.join(root, "scripts/client.mjs"), "revoke", "agent"],
      { env: { ...clean, WATERLOO_HOME: userHome(dir, "alice") } },
    );
    assert.equal(
      JSON.parse(await readFile(file("alice"), "utf8"))[0].enabled,
      false,
    );
    assert.equal(
      JSON.parse(await readFile(file("bob"), "utf8"))[0].enabled,
      true,
    );
    assert.equal((await auditHost(dir)).passed, true);
  }));
test("remote session import verifies account before saving and encrypts with only the selected user's key", () =>
  fixture(async (dir) => {
    await addHostUser(dir, bob);
    const config = readConfig({
      WATERLOO_HOME: userHome(dir, "alice"),
      WATERLOO_AUTH_MODE: "portable",
      WATERLOO_ORIGIN: alice.origin,
      WATERLOO_OWNER_EMAIL: alice.owner,
      D2L_USERNAME: alice.username,
    });
    const state = {
      cookies: ["d2lSessionVal", "d2lSecureSessionVal"].map((name) => ({
        name,
        value: "fixture-cookie",
        domain: "learn.uwaterloo.ca",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      })),
      origins: [{ origin: "https://unrelated.example.test", localStorage: [] }],
    };
    let identity = "bob";
    const request = async (url, options) => {
      assert.equal(new URL(url).origin, "https://learn.uwaterloo.ca");
      assert.equal(options.redirect, "manual");
      return {
        ok: true,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: async () =>
          url.endsWith("versions/")
            ? [{ ProductCode: "lp", LatestVersion: "1.0" }]
            : { UniqueName: identity },
      };
    };
    await assert.rejects(
      importSession(config, state, request),
      /SESSION_IMPORT_REJECTED/,
    );
    await assert.rejects(readFile(path.join(config.stateDir, "browser.json")), {
      code: "ENOENT",
    });
    identity = "alice";
    await importSession(config, state, request);
    const saved = await readFile(
      path.join(config.stateDir, "browser.json"),
      "utf8",
    );
    assert(!saved.includes("fixture-cookie"));
    const key = Buffer.from(
      (
        await readFile(path.join(config.secretsDir, "session-key"), "utf8")
      ).trim(),
      "hex",
    );
    assert.equal(
      JSON.parse(decrypt(JSON.parse(saved), key, "waterloo-browser:v1")).origins
        .length,
      0,
    );
    const bKey = Buffer.from(
      (
        await readFile(
          path.join(userHome(dir, "bob"), "private/secrets/session-key"),
          "utf8",
        )
      ).trim(),
      "hex",
    );
    assert.throws(() =>
      decrypt(JSON.parse(saved), bKey, "waterloo-browser:v1"),
    );
    const api = await readFile(
      path.join(config.stateDir, "sessions/session.json"),
      "utf8",
    );
    assert(!api.includes("fixture-cookie"));
    assert.throws(() =>
      decrypt(
        JSON.parse(api).encrypted,
        bKey,
        "brightspace-mcp-server:2:session",
      ),
    );
    await assert.rejects(
      readFile(path.join(userHome(dir, "bob"), "private/state/browser.json")),
      { code: "ENOENT" },
    );
  }));

test("owner rotation invalidates old owner keys and cookies without changing school encryption keys", () =>
  fixture(async (dir) => {
    const home = userHome(dir, "alice");
    const config = readConfig({
      WATERLOO_HOME: home,
      WATERLOO_AUTH_MODE: "portable",
      WATERLOO_ORIGIN: alice.origin,
      WATERLOO_OWNER_EMAIL: alice.owner,
      D2L_USERNAME: alice.username,
    });
    const auth = new PortableAuth(config);
    const token = (
      await readFile(path.join(home, "private/owner.token"), "utf8")
    ).trim();
    const cookie = (await auth.login(token)).split(";")[0];
    const key = await readFile(
      path.join(config.secretsDir, "session-key"),
      "utf8",
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          !k.startsWith("WATERLOO_") && !k.startsWith("D2L_") && k !== "PORT",
      ),
    );
    await exec(
      process.execPath,
      [path.join(root, "scripts/owner.mjs"), "rotate"],
      { env: { ...env, WATERLOO_HOME: home } },
    );
    assert.equal(await auth.authenticate({ headers: { cookie } }), null);
    assert.equal(
      await auth.authenticate({
        headers: { authorization: "Bearer " + token },
      }),
      null,
    );
    const next = (
      await readFile(path.join(home, "private/owner.token"), "utf8")
    ).trim();
    assert.equal(
      (
        await auth.authenticate({
          headers: { authorization: "Bearer " + next },
        })
      ).role,
      "owner",
    );
    assert.equal(
      await readFile(path.join(config.secretsDir, "session-key"), "utf8"),
      key,
    );
    assert.equal((await auditHost(dir)).passed, true);
  }));
