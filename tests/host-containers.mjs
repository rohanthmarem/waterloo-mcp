// Opt-in: builds/runs TWO isolated containers with fresh synthetic credentials.
// No real Waterloo login or production state is copied into this test.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  rm,
  chown,
} from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { root } from "../src/config.mjs";
import {
  initializeHost,
  addHostUser,
  userHome,
  auditHost,
  auditRunningHost,
  loadHost,
} from "../src/hosting.mjs";
import { tokenHash } from "../src/portable-auth.mjs";
import { encrypt } from "../upstream/build/auth/encrypted-store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const exec = promisify(execFile);
const port = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
await mkdir(path.join(root, "private"), { recursive: true, mode: 0o700 });
const dir = await realpath(
  await mkdtemp(path.join(root, "private/hosting-test-")),
);
const compose = (...args) =>
  exec("docker", ["compose", "-f", path.join(dir, "compose.json"), ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
const people = [],
  clients = [];
let configured = false;
try {
  await initializeHost(dir, "multi");
  for (const id of ["alice", "bob"]) {
    const u = {
      id,
      origin: `https://${id}.example.invalid`,
      username: `fixture${id}@uwaterloo.ca`,
      owner: `${id}@example.invalid`,
      port: await port(),
    };
    await addHostUser(dir, u);
    const home = userHome(dir, id),
      token = "wm1_" + randomBytes(32).toString("base64url");
    const owner = (
      await readFile(path.join(home, "private/owner.token"), "utf8")
    ).trim();
    await writeFile(
      path.join(home, "private/secrets/clients.json"),
      JSON.stringify([
        {
          id: "agent",
          enabled: true,
          expiresAt: Date.now() + 600000,
          tokenHash: tokenHash(token),
        },
      ]),
      { mode: 0o600 },
    );
    const key = Buffer.from(
      (
        await readFile(path.join(home, "private/secrets/session-key"), "utf8")
      ).trim(),
      "hex",
    );
    const state = path.join(home, "private/state/libcal");
    await mkdir(state, { mode: 0o700 });
    const file = path.join(state, "bookings.encrypted.json");
    await writeFile(
      file,
      JSON.stringify(
        encrypt(
          JSON.stringify([
            {
              bookingId: randomUUID(),
              details: { room: id + "-private-fixture" },
              status: "confirmed",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ]),
          key,
          "waterloo-libcal-bookings:v1",
        ),
      ),
      { mode: 0o600 },
    );
    key.fill(0);
    if (process.getuid?.() === 0) {
      const m = await loadHost(dir);
      await chown(state, m.uid, m.gid);
      await chown(file, m.uid, m.gid);
    }
    people.push({ ...u, token, owner });
  }
  configured = true;
  const files = await auditHost(dir);
  assert(files.passed);
  console.log(JSON.stringify(files));
  console.log(
    "Building isolated test containers; the existing deployment is not used.",
  );
  await compose("up", "-d", "--build");
  const ids = (await compose("ps", "-a", "-q")).stdout.trim().split(/\s+/);
  const containers = JSON.parse(
    (await exec("docker", ["inspect", ...ids], { maxBuffer: 4 * 1024 * 1024 }))
      .stdout,
  );
  const running = await auditRunningHost(dir, containers);
  console.log(JSON.stringify(running));
  assert(running.passed);
  // Model the TLS proxy's HTTP hop, including the original Host. No DNS or
  // certificate is installed by a test. Production requires a real HTTPS proxy.
  const proxyFetch =
    (u) =>
    async (input, init = {}) =>
      new Promise((resolve, reject) => {
        const url = new URL(input),
          headers = Object.fromEntries(new Headers(init.headers));
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: u.port,
            path: url.pathname + url.search,
            method: init.method ?? "GET",
            headers: { ...headers, Host: new URL(u.origin).host },
            signal: init.signal,
          },
          (res) => {
            const chunks = [];
            res.on("data", (b) => chunks.push(b));
            res.on("end", () =>
              resolve(
                new Response(
                  [204, 304].includes(res.statusCode)
                    ? null
                    : Buffer.concat(chunks),
                  { status: res.statusCode, headers: res.headers },
                ),
              ),
            );
          },
        );
        req.on("error", reject);
        req.end(init.body);
      });
  for (const u of people) {
    const request = proxyFetch(u);
    for (let i = 0; i < 30; i++) {
      try {
        if ((await request(u.origin + "/health")).status === 200) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    const c = new Client({ name: "container-isolation", version: "1" });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(u.origin + "/mcp"), {
        fetch: request,
        requestInit: { headers: { Authorization: "Bearer " + u.token } },
      }),
    );
    const r = await c.callTool({
      name: "get_study_room_bookings",
      arguments: {},
    });
    assert(!r.isError);
    assert.equal(
      JSON.parse(r.content[0].text).bookings[0].details.room,
      u.id + "-private-fixture",
    );
    const other = people.find((p) => p.id !== u.id);
    assert.equal(
      (
        await request(u.origin + "/status", {
          headers: { Authorization: "Bearer " + other.token },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(u.origin + "/account", {
          headers: { Authorization: "Bearer " + other.owner },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(u.origin + "/setup/piazza", {
          headers: { Authorization: "Bearer " + u.token },
        })
      ).status,
      403,
    );
    const login = await request(u.origin + "/login", {
      method: "POST",
      headers: {
        Origin: u.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: u.owner }).toString(),
    });
    assert.equal(login.status, 200);
    assert(login.headers.get("set-cookie").includes("Secure"));
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await proxyFetch(other)(other.origin + "/account", {
          headers: { Cookie: cookie },
        })
      ).status,
      401,
    );
    console.log(
      JSON.stringify({
        user: u.id,
        isolatedRead: true,
        foreignTokensRejected: true,
        foreignCookieRejected: true,
        agentBlockedFromOwnerPage: true,
      }),
    );
  }
  console.log("CONTAINER_ISOLATION_PASSED");
} catch (error) {
  console.error(
    JSON.stringify({
      code: "CONTAINER_ISOLATION_FAILED",
      message: error.code ?? error.message?.split("\n")[0],
    }),
  );
  process.exitCode = 1;
} finally {
  for (const c of clients) await c.close();
  if (configured) await compose("down", "--rmi", "all", "--remove-orphans");
  await rm(dir, { recursive: true, force: true });
}
