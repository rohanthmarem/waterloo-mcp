import { unlink } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { RacketWorkspace } from "../src/racket-workspace.mjs";
import { needsApproval, describeTool } from "../authorization.mjs";
const doc = {
  id: "a01",
  title: "Assignment 1",
  language: "htdp/bsl",
  code: "(check-expect (+ 1 1) 2)",
  assignment: { title: "Practice", text: "Write a function.", url: "" },
  expectedRevision: 0,
};
test("Racket workspace encrypts per-user code, rejects stale edits, and runs exactly the saved revision", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "racket-test-"));
  try {
    const configurations = [];
    for (const name of ["alice", "bob"]) {
      const stateDir = path.join(dir, name);
      await mkdir(stateDir);
      await writeFile(
        path.join(stateDir, "session-key"),
        randomBytes(32).toString("hex"),
      );
      configurations.push({
        stateDir,
        secretsDir: stateDir,
        racketUrl: "http://racket_" + name + ":8010",
      });
    }
    let runs = 0;
    const service = new RacketWorkspace(
      configurations[0],
      async (url, options) => {
        if (url.endsWith("/health"))
          return { ok: true, json: async () => ({ ready: true, busy: false }) };
        runs++;
        assert.equal(url, "http://racket_alice:8010/run");
        assert.deepEqual(JSON.parse(options.body), {
          language: doc.language,
          code: doc.code,
        });
        return {
          ok: true,
          json: async () => ({
            status: "completed",
            code: null,
            stdout: "Test passed",
            stderr: "",
            durationMs: 10,
          }),
        };
      },
    );
    assert.deepEqual(await service.call("list_racket_workspaces", {}), {
      workspaces: [],
      unreadable: [],
    });
    const saved = await service.call("save_racket_workspace", doc);
    assert.equal(saved.revision, 1);
    const disk = await readFile(
      path.join(configurations[0].stateDir, "racket/a01.json"),
      "utf8",
    );
    assert(!disk.includes(doc.code));
    await assert.rejects(
      service.call("save_racket_workspace", doc),
      /RACKET_REVISION_CONFLICT/,
    );
    await assert.rejects(
      service.call("run_racket_workspace", { id: "a01", expectedRevision: 0 }),
      /RACKET_REVISION_CONFLICT/,
    );
    assert.equal(runs, 0);
    let approvals = 0;
    const approve = async () => {
      approvals++;
    };
    await writeFile(
      path.join(configurations[0].stateDir, "racket/.write.lock"),
      "fixture",
    );
    await assert.rejects(
      service.call(
        "run_racket_workspace",
        { id: "a01", expectedRevision: 1 },
        approve,
      ),
      /RACKET_BUSY/,
    );
    assert.equal(approvals, 0);
    await unlink(path.join(configurations[0].stateDir, "racket/.write.lock"));
    await assert.rejects(
      service.call("save_racket_workspace", doc, approve),
      /RACKET_REVISION_CONFLICT/,
    );
    assert.equal(approvals, 0);
    assert.equal(
      (
        await service.call("run_racket_workspace", {
          id: "a01",
          expectedRevision: 1,
        })
      ).lastRun.stdout,
      "Test passed",
    );
    await writeFile(
      path.join(configurations[0].stateDir, "racket/broken.json"),
      "corrupt",
    );
    const listed = await service.call("list_racket_workspaces", {});
    assert.equal(listed.workspaces.length, 1);
    assert.equal(listed.unreadable[0].id, "broken");
    const bob = new RacketWorkspace(configurations[1]);
    await assert.rejects(
      bob.call("read_racket_workspace", { id: "a01" }),
      /RACKET_NOT_FOUND/,
    );
    await mkdir(path.join(configurations[1].stateDir, "racket"));
    await writeFile(
      path.join(configurations[1].stateDir, "racket/a01.json"),
      disk,
    );
    await assert.rejects(
      bob.call("read_racket_workspace", { id: "a01" }),
      /RACKET_STATE_INVALID/,
    );
    await assert.rejects(
      service.call("save_racket_workspace", { ...doc, id: "../secrets" }),
    );
    await unlink(path.join(configurations[0].secretsDir, "session-key"));
    await assert.rejects(
      service.call("read_racket_workspace", { id: "a01" }),
      /RACKET_STATE_INVALID/,
    );
    assert(needsApproval("save_racket_workspace", doc));
    assert(needsApproval("run_racket_workspace", {}));
    assert.equal(
      describeTool({
        name: "run_racket_workspace",
        inputSchema: { properties: {} },
      }).annotations.readOnlyHint,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
