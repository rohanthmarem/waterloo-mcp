import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Authorizations,
  needsApproval,
  validateWriteTarget,
  KNOWN_TOOLS,
} from "../authorization.mjs";
test("exact action, user nonce, expiry, caller, replay and concurrency are enforced", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "waterloo-approval-test-"));
  const a = new Authorizations(dir);
  const args = { downloadPath: "/state/downloads", topicId: 1, courseId: 1 };
  try {
    const id = await a.request("download_file", args, "client1");
    await assert.rejects(a.consume(id, "download_file", args, "client1"));
    await assert.rejects(a.decide(id, "forged", "approve"));
    const row = await a.read(id);
    await a.decide(id, row.nonce, "approve");
    await assert.rejects(
      a.consume(id, "download_file", { ...args, topicId: 2 }, "client1"),
    );
    await assert.rejects(a.consume(id, "download_file", args, "client2"));
    const attempts = await Promise.allSettled([
      a.consume(id, "download_file", args, "client1"),
      a.consume(id, "download_file", args, "client1"),
    ]);
    assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
    await assert.rejects(a.consume(id, "download_file", args, "client1"));
    const denied = await a.request("download_file", args, "client1");
    await a.decide(denied, (await a.read(denied)).nonce, "deny");
    await assert.rejects(a.consume(denied, "download_file", args, "client1"));
    const expired = await a.request("download_file", args, "client1");
    const old = await a.read(expired);
    old.expiresAt = 0;
    await a.save(old);
    await assert.rejects(a.decide(expired, old.nonce, "approve"));
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("writes are classified and cannot target service files", () => {
  assert(needsApproval("download_file", {}));
  assert(needsApproval("get_syllabus", { downloadPath: "/state/downloads" }));
  assert(!needsApproval("get_syllabus", {}));
  for (const p of [
    "/state/password.json",
    "/state/downloads/../../etc",
    "/app",
    "/tmp",
  ])
    assert.throws(() => validateWriteTarget({ downloadPath: p }));
  validateWriteTarget({ downloadPath: "/state/downloads" });
  assert(!KNOWN_TOOLS.has("send_message"));
  assert(!KNOWN_TOOLS.has("delete_assignment"));
});
