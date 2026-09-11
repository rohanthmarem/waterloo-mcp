import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createGateway } from "../gateway.mjs";
import {
  provisionOwner,
  tokenHash,
  PortableAuth,
} from "../src/portable-auth.mjs";
import { Authorizations } from "../authorization.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("two real HTTP MCP instances isolate tokens, owner cookies, read caches, approvals, and revocation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "portable-mcp-"));
  const instances = [],
    clients = [];
  try {
    for (const id of ["alice", "bob"]) {
      const home = path.join(dir, id);
      await mkdir(home);
      const config = {
        home,
        stateDir: home,
        secretsDir: home,
        username: id + "@uwaterloo.ca",
        owner: id + "@example.test",
        authMode: "portable",
        origin: "",
      };
      await provisionOwner(home, path.join(home, "owner.token"));
      const owner = (
        await readFile(path.join(home, "owner.token"), "utf8")
      ).trim();
      const token = "wm1_" + id.repeat(16);
      await writeFile(
        path.join(home, "clients.json"),
        JSON.stringify([
          {
            id: "same-id-in-both-users",
            tokenHash: tokenHash(token),
            enabled: true,
            expiresAt: Date.now() + 60000,
          },
        ]),
      );
      let writes = 0;
      const app = createGateway(config, async () => ({
        listTools: async () => ({
          tools: ["get_course_home", "download_file"].map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
          })),
        }),
        callTool: async ({ name }) => {
          if (name === "download_file") writes++;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ marker: id + "-private-course" }),
              },
            ],
          };
        },
        close: async () => {},
      }));
      await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
      config.origin = "http://127.0.0.1:" + app.address().port;
      instances.push({ app, config, owner, token, writes: () => writes });
    }
    const [a, b] = instances;
    const fetchAs = (instance, route, token, init = {}) =>
      fetch(instance.config.origin + route, {
        ...init,
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...init.headers,
        },
      });
    for (const [mine, other] of [
      [a, b],
      [b, a],
    ]) {
      assert.equal((await fetchAs(other, "/status", mine.token)).status, 401);
      assert.equal((await fetchAs(other, "/account", mine.owner)).status, 401);
      assert.equal((await fetchAs(mine, "/account", mine.token)).status, 403);
      assert.equal(
        (
          await fetchAs(mine, "/setup/session", mine.token, {
            method: "POST",
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetchAs(mine, "/status", null, {
            headers: {
              "X-Exedev-Email": mine.config.owner,
              "X-Exedev-Token-Ctx": '{"role":"owner"}',
            },
          })
        ).status,
        401,
      );
      const wrongHost = await new Promise((resolve, reject) => {
        const req = http.get(
          mine.config.origin + "/status",
          {
            headers: {
              Host: "attacker.example",
              Authorization: "Bearer " + mine.token,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
      });
      assert.equal(wrongHost, 400);
    }
    const approvalPath = "/approvals/" + "a".repeat(48);
    const unauthenticated = await fetchAs(a, approvalPath, null, {
      redirect: "manual",
    });
    assert.equal(unauthenticated.status, 303);
    const loginPath = unauthenticated.headers.get("location");
    assert.equal(loginPath, "/login?next=" + encodeURIComponent(approvalPath));
    const login = await fetchAs(a, loginPath, null, {
      method: "POST",
      headers: {
        Origin: a.config.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: a.owner }),
    });
    assert.equal(login.status, 200);
    assert((await login.text()).includes(`href="${approvalPath}"`));
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert(login.headers.get("set-cookie").includes("HttpOnly"));
    assert(login.headers.get("set-cookie").includes("SameSite=Strict"));
    assert.equal(
      (await fetchAs(a, "/account", null, { headers: { Cookie: cookie } }))
        .status,
      200,
    );
    assert.equal(
      (await fetchAs(b, "/account", null, { headers: { Cookie: cookie } }))
        .status,
      401,
    );
    assert.equal(
      (await fetchAs(a, "/account", b.token, { headers: { Cookie: cookie } }))
        .status,
      401,
    );
    assert.equal(
      (
        await fetchAs(a, "/login", null, {
          method: "POST",
          headers: { Origin: b.config.origin },
          body: new URLSearchParams({ token: a.owner }),
        })
      ).status,
      403,
    );
    for (const instance of instances) {
      const c = new Client({ name: "isolation-test", version: "1" });
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(
          new URL(instance.config.origin + "/mcp"),
          {
            requestInit: {
              headers: { Authorization: "Bearer " + instance.token },
            },
          },
        ),
      );
      for (let i = 0; i < 2; i++) {
        const read = await c.callTool({
          name: "get_course_home",
          arguments: { courseId: 1 },
        });
        assert.equal(
          JSON.parse(read.content[0].text).marker,
          instance.config.username.split("@")[0] + "-private-course",
        );
      }
    }
    const args = { courseId: 1, topicId: 2, downloadPath: "/state/downloads" };
    const pending = JSON.parse(
      (await clients[0].callTool({ name: "download_file", arguments: args }))
        .content[0].text,
    ).error;
    assert.equal(pending.code, "APPROVAL_REQUIRED");
    assert.equal(a.writes(), 0);
    const approvals = new Authorizations(
      path.join(a.config.stateDir, "approvals"),
    );
    const record = await approvals.read(pending.authorizationId);
    await approvals.decide(record.id, record.nonce, "approve");
    const foreign = await clients[1].callTool({
      name: "download_file",
      arguments: { ...args, authorizationId: record.id },
    });
    assert.equal(
      JSON.parse(foreign.content[0].text).error.code,
      "APPROVAL_INVALID",
    );
    assert.equal(b.writes(), 0);
    assert(
      !(
        await clients[0].callTool({
          name: "download_file",
          arguments: { ...args, authorizationId: record.id },
        })
      ).isError,
    );
    assert.equal(a.writes(), 1);
    assert(
      (
        await clients[0].callTool({
          name: "download_file",
          arguments: { ...args, authorizationId: record.id },
        })
      ).isError,
    );
    await writeFile(path.join(a.config.secretsDir, "clients.json"), "[]");
    assert.equal((await fetchAs(a, "/status", a.token)).status, 401);
    assert.equal((await fetchAs(b, "/status", b.token)).status, 200);
    const auth = new PortableAuth(a.config);
    for (let i = 0; i < 10; i++)
      await assert.rejects(auth.login("wrong"), /AUTH_REQUIRED/);
    await assert.rejects(auth.login(a.owner), /LOGIN_RATE_LIMITED/);
    const owner = await auth.owner();
    const expired = Buffer.from(
      JSON.stringify({ exp: Date.now() - 1 }),
    ).toString("base64url");
    assert.equal(
      await auth.authenticate({
        headers: {
          cookie:
            "waterloo_owner=" +
            expired +
            "." +
            auth.sign(expired, owner.sessionKey),
        },
      }),
      null,
    );
  } finally {
    for (const c of clients) await c.close();
    for (const { app } of instances)
      await new Promise((resolve) => app.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
