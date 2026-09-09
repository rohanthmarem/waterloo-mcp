import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGateway } from "../gateway.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("private MCP, exact approvals, client revocation, and error redaction", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "waterloo-test-"));
  const config = {
    owner: "owner@example.test",
    origin: "https://example.exe.xyz",
    stateDir: dir,
    secretsDir: dir,
  };
  await writeFile(
    path.join(dir, "clients.json"),
    JSON.stringify([
      { id: "test-client", enabled: true, expiresAt: Date.now() + 60000 },
    ]),
  );
  let writes = 0;
  const worker = {
    listTools: async () => ({
      tools: [
        "get_my_courses",
        "get_course_home",
        "download_file",
        "delete_everything",
      ].map((name) => ({
        name,
        inputSchema: { type: "object", properties: {} },
      })),
    }),
    callTool: async ({ name }) => {
      if (name === "download_file") writes++;
      if (name === "get_course_home")
        throw new Error("private-token-must-not-appear");
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      };
    },
    close: async () => {},
  };
  let roomWrites = 0;
  const app = createGateway(config, async () => worker, {
    libcal: {
      preview: async () => ({
        room: "Room Test",
        library: "Davis Centre Library",
        start: "2026-09-10 13:00",
        end: "2026-09-10 14:00",
      }),
      call: async () => {
        roomWrites++;
        return { content: [{ type: "text", text: '{"status":"confirmed"}' }] };
      },
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.address().port;
  const owner = { "X-ExeDev-Email": config.owner };
  const token = {
    ...owner,
    "X-ExeDev-Token-Ctx": JSON.stringify({ role: "mcp", id: "test-client" }),
  };
  const c = new Client({ name: "integration-test", version: "1" });
  try {
    assert.equal((await fetch(base + "/status")).status, 401);
    assert.equal(
      (
        await fetch(base + "/status", {
          headers: { ...owner, Origin: "https://other.example" },
        })
      ).status,
      403,
    );
    await c.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: token },
      }),
    );
    const catalog = await c.listTools();
    assert(!catalog.tools.some((t) => t.name === "delete_everything"));
    assert(catalog.tools.some((t) => t.name === "get_course_outline"));
    const unknown = await c.callTool({
      name: "delete_everything",
      arguments: { approved: true },
    });
    assert.equal(
      JSON.parse(unknown.content[0].text).error.code,
      "TOOL_UNSUPPORTED",
    );
    const bookingArgs = {
      roomId: 10,
      date: "2026-09-10",
      startTime: "13:00",
      durationMinutes: 60,
      bookingRequestId: "b3271bc4-5ab2-4a7b-82a3-26b7c702595c",
    };
    const bookingPending = JSON.parse(
      (await c.callTool({ name: "book_study_room", arguments: bookingArgs }))
        .content[0].text,
    ).error;
    assert.equal(bookingPending.code, "APPROVAL_REQUIRED");
    assert.equal(roomWrites, 0);
    const bookingPath = new URL(bookingPending.approvalUrl).pathname;
    const bookingHtml = await (
      await fetch(base + bookingPath, { headers: owner })
    ).text();
    assert(bookingHtml.includes("Davis Centre Library"));
    assert(bookingHtml.includes("13:00"));
    const bookingNonce = bookingHtml.match(
      /name="nonce" value="([a-f0-9]+)"/,
    )[1];
    await fetch(base + bookingPath, {
      method: "POST",
      headers: {
        ...owner,
        Origin: config.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce: bookingNonce, decision: "approve" }),
    });
    assert(
      (
        await c.callTool({
          name: "book_study_room",
          arguments: {
            ...bookingArgs,
            startTime: "14:00",
            authorizationId: bookingPending.authorizationId,
          },
        })
      ).isError,
    );
    assert.equal(roomWrites, 0);
    assert(
      !(
        await c.callTool({
          name: "book_study_room",
          arguments: {
            ...bookingArgs,
            authorizationId: bookingPending.authorizationId,
          },
        })
      ).isError,
    );
    assert.equal(roomWrites, 1);
    assert(
      (
        await c.callTool({
          name: "book_study_room",
          arguments: {
            ...bookingArgs,
            authorizationId: bookingPending.authorizationId,
          },
        })
      ).isError,
    );
    assert.equal(roomWrites, 1);
    const cancelPending = JSON.parse(
      (
        await c.callTool({
          name: "cancel_study_room_booking",
          arguments: { bookingId: bookingArgs.bookingRequestId },
        })
      ).content[0].text,
    ).error;
    assert.equal(cancelPending.code, "APPROVAL_REQUIRED");
    assert.equal(roomWrites, 1);
    const args = {
      courseId: 1,
      topicId: 2,
      downloadPath: "/state/downloads",
      customFilename: "test.txt",
    };
    const required = await c.callTool({
      name: "download_file",
      arguments: args,
    });
    const pending = JSON.parse(required.content[0].text).error;
    assert.equal(pending.code, "APPROVAL_REQUIRED");
    assert.equal(writes, 0);
    const approvalPath = new URL(pending.approvalUrl).pathname;
    assert.equal(
      (await fetch(base + approvalPath, { headers: token })).status,
      403,
    );
    const html = await (
      await fetch(base + approvalPath, { headers: owner })
    ).text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]+)"/)[1];
    assert.equal(
      (
        await fetch(base + approvalPath, {
          method: "POST",
          headers: {
            ...owner,
            Origin: config.origin,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ nonce, decision: "approve" }),
        })
      ).status,
      200,
    );
    const changed = await c.callTool({
      name: "download_file",
      arguments: {
        ...args,
        topicId: 3,
        authorizationId: pending.authorizationId,
      },
    });
    assert(changed.isError);
    assert.equal(writes, 0);
    const request = {
      name: "download_file",
      arguments: { ...args, authorizationId: pending.authorizationId },
    };
    assert(!(await c.callTool(request)).isError);
    assert.equal(writes, 1);
    assert((await c.callTool(request)).isError);
    assert.equal(writes, 1);
    const failure = await c.callTool({
      name: "get_course_home",
      arguments: { courseId: 1 },
    });
    assert(failure.isError);
    assert(!JSON.stringify(failure).includes("private-token"));
    assert.equal(
      JSON.parse(failure.content[0].text).error.code,
      "UPSTREAM_UNAVAILABLE",
    );
    await writeFile(path.join(dir, "clients.json"), "[]");
    assert.equal(
      (await fetch(base + "/status", { headers: token })).status,
      403,
    );
  } finally {
    await c.close();
    await new Promise((resolve) => app.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
