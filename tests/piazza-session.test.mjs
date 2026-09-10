import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiazzaSession } from "../src/piazza-session.mjs";

async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "piazza-session-"));
  await writeFile(
    path.join(dir, "session-key"),
    randomBytes(32).toString("hex"),
  );
  try {
    await run({ stateDir: dir, secretsDir: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const status = {
  id: "test-user",
  networks: [{ id: "test-class", name: "Example class" }],
};
const cookie = (value) => ({
  name: "session_id",
  value,
  domain: "piazza.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
});
function server() {
  const calls = [];
  let logins = 0,
    failLogin = false,
    denyRead = false,
    missingPost = false;
  return {
    calls,
    get logins() {
      return logins;
    },
    set failLogin(value) {
      failLogin = value;
    },
    set denyRead(value) {
      denyRead = value;
    },
    set missingPost(value) {
      missingPost = value;
    },
    createContext: async (options) => {
      let cookies = structuredClone(options.storageState?.cookies ?? []);
      const response = (data, code = 200) => ({
        status: () => code,
        ok: () => code === 200,
        body: async () => Buffer.from(JSON.stringify(data)),
        text: async () => String(data),
      });
      return {
        get: async (url, opts) => {
          assert.equal(url, "https://piazza.com/main/csrf_token");
          assert.equal(opts.maxRedirects, 0);
          return response('window.CSRF_TOKEN="fixture-csrf";');
        },
        post: async (url, opts) => {
          calls.push({ url, ...opts });
          assert.equal(new URL(url).origin, "https://piazza.com");
          assert.equal(opts.maxRedirects, 0);
          if (url.endsWith("/class")) {
            logins++;
            assert.equal(opts.form.csrf_token, "fixture-csrf");
            if (!failLogin) cookies = [cookie("working-cookie")];
            return response("", 302);
          }
          const data = JSON.parse(opts.data);
          assert.equal(opts.headers["CSRF-Token"], cookies[0]?.value);
          if (denyRead)
            return response({ error: "private forbidden diagnostic" }, 403);
          if (cookies[0]?.value !== "working-cookie")
            return response({ error: "Not logged in" });
          if (missingPost && data.method === "content.get")
            return response({
              result: null,
              error: "The post you are looking for cannot be found",
            });
          return response({
            result: data.method === "user.status" ? status : { feed: [] },
          });
        },
        storageState: async () => ({ cookies, origins: [] }),
        dispose: async () => {},
      };
    },
  };
}
test("Piazza credentials stay encrypted and work after a process restart without a browser", () =>
  fixture(async (config) => {
    const remote = server();
    const session = new PiazzaSession(config, remote);
    await session.connect("student@example.test", "private-password");
    const disk = await readFile(session.file, "utf8");
    for (const secret of [
      "private-password",
      "working-cookie",
      "student@example.test",
    ])
      assert(!disk.includes(secret));
    const restarted = new PiazzaSession(config, remote);
    assert.deepEqual(await restarted.run((rpc) => rpc("user.status")), status);
    assert.equal(remote.logins, 1);
    assert.equal((await restarted.load()).email, "student@example.test");
    remote.missingPost = true;
    await assert.rejects(
      restarted.run((rpc) =>
        rpc("content.get", { nid: "test-class", cid: 999999999 }),
      ),
      /PIAZZA_NOT_FOUND/,
    );
    assert.equal(remote.logins, 1);
  }));
test("Piazza renews an expired cookie once and limits failed automatic logins", () =>
  fixture(async (config) => {
    const remote = server();
    const session = new PiazzaSession(config, remote);
    await session.connect("student@example.test", "private-password");
    const stale = await session.load();
    stale.storageState.cookies = [cookie("expired-cookie")];
    await session.save(stale);
    assert.deepEqual(await session.run((rpc) => rpc("user.status")), status);
    assert.equal(remote.logins, 2);
    await session.save(stale);
    remote.failLogin = true;
    await assert.rejects(
      session.run((rpc) => rpc("user.status")),
      /PIAZZA_AUTH_REQUIRED/,
    );
    const attempts = remote.logins;
    await assert.rejects(
      session.run((rpc) => rpc("user.status")),
      /PIAZZA_AUTH_REQUIRED/,
    );
    assert.equal(remote.logins, attempts);
  }));
test("Piazza rejects writes, denied resources, corrupted state and failed replacement credentials", () =>
  fixture(async (config) => {
    const remote = server();
    const session = new PiazzaSession(config, remote);
    await assert.rejects(session.load(), /PIAZZA_AUTH_REQUIRED/);
    await session.connect("student@example.test", "private-password");
    const before = remote.calls.length;
    await assert.rejects(
      session.run((rpc) => rpc("content.create", { content: "Do not send" })),
      /TOOL_UNSUPPORTED/,
    );
    assert.equal(remote.calls.length, before);
    remote.denyRead = true;
    await assert.rejects(
      session.run((rpc) => rpc("user.status")),
      /PIAZZA_FORBIDDEN/,
    );
    assert.equal(remote.logins, 1);
    remote.denyRead = false;
    remote.failLogin = true;
    await assert.rejects(
      session.connect("other@example.test", "wrong-password"),
      /PIAZZA_AUTH_REQUIRED/,
    );
    assert.equal((await session.load()).email, "student@example.test");
    await writeFile(session.file, "invalid ciphertext");
    await assert.rejects(session.load(), /PIAZZA_STATE_INVALID/);
  }));
