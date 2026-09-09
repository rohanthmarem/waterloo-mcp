import test from "node:test";
import assert from "node:assert/strict";
import { ReadCache } from "../src/read-cache.mjs";
import { readConfig } from "../src/config.mjs";
import { normalizeToolResult } from "../src/errors.mjs";
import { findOutlines } from "../outlines.mjs";

test("configuration rejects insecure public URLs and malformed accounts", () => {
  const env = {
    WATERLOO_ORIGIN: "https://example.exe.xyz",
    WATERLOO_OWNER_EMAIL: "owner@example.test",
    D2L_USERNAME: "student@uwaterloo.ca",
  };
  assert.equal(readConfig(env).origin, env.WATERLOO_ORIGIN);
  for (const url of [
    "http://public.example",
    "https://example.exe.xyz/path",
    "https://user:secret@example.exe.xyz",
    "https://example.exe.xyz/?key=value",
  ])
    assert.throws(() => readConfig({ ...env, WATERLOO_ORIGIN: url }));
  assert.throws(() => readConfig({ ...env, D2L_USERNAME: "missing-domain" }));
});

test("concurrent identical reads share work, errors are not cached, and capacity is bounded", async () => {
  const cache = new ReadCache({ maxEntries: 1, concurrency: 1 });
  let calls = 0;
  let finish;
  const run = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const one = cache.get("one", run),
    same = cache.get("one", run);
  await Promise.resolve();
  await assert.rejects(cache.get("two", run), /SERVICE_BUSY/);
  finish({ content: [] });
  await Promise.all([one, same]);
  assert.equal(calls, 1);
  await cache.get("one", run);
  assert.equal(calls, 1);
  await cache.get("bad", async () => {
    calls++;
    return { isError: true };
  });
  await cache.get("bad", async () => {
    calls++;
    return { isError: true };
  });
  assert.equal(calls, 3);
  await cache.get("two", async () => ({ content: [] }));
  assert.equal(cache.entries.size, 1);
});

test("upstream errors get stable safe codes", () => {
  const r = normalizeToolResult({
    isError: true,
    content: [{ type: "text", text: "Access denied. sensitive debug data" }],
  });
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.error.code, "UPSTREAM_FORBIDDEN");
  assert(!JSON.stringify(p).includes("sensitive"));
});

test("outline discovery skips locked modules and reports unread children", () => {
  const d = findOutlines([
    {
      type: "module",
      title: "Syllabus",
      children: [{ type: "topic", id: 1, title: "Welcome", topicType: "file" }],
    },
    {
      type: "module",
      title: "Outline",
      isLocked: true,
      children: [{ type: "topic", id: 2 }],
    },
    { type: "module", id: 3, childrenReadError: "Denied" },
  ]);
  assert.deepEqual(
    d.candidates.map((x) => x.topicId),
    [1],
  );
  assert.equal(d.warnings.length, 1);
});
