import test from "node:test";
import assert from "node:assert/strict";
import { batchReads } from "../src/batch-reads.mjs";
const data = (r) => JSON.parse(r.content[0].text);
test("batches reject every write before executing any read, including conditional downloads and recursion", async () => {
  for (const request of [
    { name: "download_file", arguments: {} },
    { name: "get_syllabus", arguments: { downloadPath: "/state/downloads" } },
    { name: "read_many", arguments: { requests: [] } },
    { name: "run_racket_workspace", arguments: {} },
    { name: "check_auth", arguments: { authorizationId: "ignored" } },
  ]) {
    let calls = 0;
    const r = await batchReads(
      { requests: [{ name: "check_auth" }, request] },
      async () => {
        calls++;
      },
    );
    assert.equal(r.isError, true);
    assert.equal(calls, 0);
  }
});
test("batch concurrency is bounded, results ordered, errors isolated and large responses explicit", async () => {
  let active = 0,
    peak = 0;
  const r = await batchReads(
    {
      requests: Array.from({ length: 8 }, (_, i) => ({
        name: "get_course_news",
        arguments: { i },
      })),
    },
    async (n, a) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (a.i === 2) throw Error("private");
      return {
        content: [
          { type: "text", text: a.i === 3 ? "x".repeat(150000) : String(a.i) },
        ],
      };
    },
  );
  assert.equal(peak, 3);
  const rows = data(r).results;
  assert.deepEqual(
    rows.map((x) => x.index),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(rows[2].result.isError, true);
  assert.equal(data(rows[3].result).error.code, "BATCH_RESULT_TOO_LARGE");
  assert.equal(JSON.stringify(r).includes("private"), false);
});
