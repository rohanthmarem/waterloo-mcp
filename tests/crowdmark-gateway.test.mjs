import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateway } from "../gateway.mjs";
import { Authorizations } from "../authorization.mjs";
import { Crowdmark, normalizeAssignment } from "../src/crowdmark.mjs";
import { sha256 } from "../src/crowdmark-files.mjs";
import { assignment, png, readResult } from "./fixtures/crowdmark.mjs";

test("real HTTP MCP requires owner approval for exact photos, isolates clients, previews and rejects changed answers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "crowd-gateway-"));
  const config = {
    owner: "owner@example.test",
    origin: "https://fixture.exe.xyz",
    stateDir: dir,
    secretsDir: dir,
  };
  await writeFile(
    path.join(dir, "session-key"),
    randomBytes(32).toString("hex"),
  );
  await writeFile(
    path.join(dir, "clients.json"),
    JSON.stringify(
      ["alice", "bob"].map((id) => ({
        id,
        enabled: true,
        expiresAt: Date.now() + 60000,
      })),
    ),
  );
  const doc = assignment();
  let edits = 0;
  const cm = new Crowdmark(config, {
    session: {
      read: async () => structuredClone(doc),
      close: async () => {},
      edit: async () => {
        edits++;
        throw Error("fixture stops before website");
      },
    },
  });
  const app = createGateway(
    config,
    async () => ({
      listTools: async () => ({ tools: [] }),
      close: async () => {},
    }),
    { crowdmark: cm },
  );
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.address().port;
  const owner = { "X-Exedev-Email": config.owner };
  const headers = (id) => ({
    ...owner,
    "X-Exedev-Token-Ctx": JSON.stringify({ id, role: "mcp" }),
  });
  const clients = ["alice", "bob"].map(
    () => new Client({ name: "test", version: "1" }),
  );
  const approvals = new Authorizations(path.join(dir, "approvals"));
  try {
    await Promise.all(
      clients.map((c, i) =>
        c.connect(
          new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
            requestInit: { headers: headers(["alice", "bob"][i]) },
          }),
        ),
      ),
    );
    const [a, b] = clients;
    const catalog = (await a.listTools()).tools;
    assert.equal(catalog.filter((t) => t.name.includes("crowdmark")).length, 6);
    assert.equal(
      catalog.find((t) => t.name === "save_crowdmark_answers").annotations
        .readOnlyHint,
      false,
    );
    const args = {
      filename: "proof.png",
      mimeType: "image/png",
      size: png.length,
      sha256: sha256(png),
    };
    const approval = readResult(
      await a.callTool({ name: "create_crowdmark_upload", arguments: args }),
    );
    assert.equal(approval.error.code, "APPROVAL_REQUIRED");
    const aid = approval.authorizationId ?? approval.error?.authorizationId;
    assert(aid, JSON.stringify(approval));
    const row = await approvals.read(aid);
    await approvals.decide(aid, row.nonce, "approve");
    const wrong = await b.callTool({
      name: "create_crowdmark_upload",
      arguments: { ...args, authorizationId: aid },
    });
    assert(wrong.isError);
    const ticket = readResult(
      await a.callTool({
        name: "create_crowdmark_upload",
        arguments: { ...args, authorizationId: aid },
      }),
    );
    assert(ticket.fileId);
    const url = base + "/crowdmark/uploads/" + ticket.fileId;
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...headers("bob"), "Content-Type": "image/png" },
          body: png,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...headers("alice"), "Content-Type": "image/png" },
          body: png,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...headers("alice"), "Content-Type": "image/png" },
          body: png,
        })
      ).status,
      400,
    );
    const preview = base + "/crowdmark/files/" + ticket.fileId;
    assert.equal(
      (await fetch(preview, { headers: headers("alice") })).status,
      403,
    );
    assert.deepEqual(
      Buffer.from(
        await (await fetch(preview, { headers: owner })).arrayBuffer(),
      ),
      png,
    );
    const save = {
      assessmentId: "test-1",
      expectedRevision: normalizeAssignment(doc).revision,
      actionId: randomUUID(),
      answers: [{ questionId: "q1", fileIds: [ticket.fileId] }],
    };
    const proposed = readResult(
      await a.callTool({ name: "save_crowdmark_answers", arguments: save }),
    );
    const sid = proposed.authorizationId ?? proposed.error?.authorizationId;
    assert(sid, JSON.stringify(proposed));
    const page = await (
      await fetch(base + "/approvals/" + sid, { headers: owner })
    ).text();
    assert(page.includes("/crowdmark/files/" + ticket.fileId));
    const sr = await approvals.read(sid);
    await approvals.decide(sid, sr.nonce, "approve");
    doc.included.find((x) => x.id === "q1").attributes.body =
      "Changed question";
    const stale = readResult(
      await a.callTool({
        name: "save_crowdmark_answers",
        arguments: { ...save, authorizationId: sid },
      }),
    );
    assert.equal(stale.error.code, "CROWDMARK_CHANGED");
    assert.equal(edits, 0);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise((resolve) => app.close(resolve));
    await cm.close();
    await rm(dir, { recursive: true });
  }
});
