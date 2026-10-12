import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  Crowdmark,
  normalizeAssignment,
  requireEditable,
  crowdmarkSchemas,
  crowdmarkWriteTools,
  allowedCrowdmarkWrite,
} from "../src/crowdmark.mjs";
import { CrowdmarkFiles, sha256 } from "../src/crowdmark-files.mjs";
import { needsApproval } from "../authorization.mjs";
import { batchReads } from "../src/batch-reads.mjs";
import { assignment, png, addPage, readResult } from "./fixtures/crowdmark.mjs";
const request = (bytes = png) =>
  Object.assign(Readable.from([bytes]), {
    headers: { "content-type": "image/png" },
  });
const photo = {
  filename: "answer.png",
  mimeType: "image/png",
  size: png.length,
  sha256: sha256(png),
};

test("Crowdmark staged images are encrypted, caller bound, exact bytes, one-use and expire", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "crowd-files-"));
  await writeFile(
    path.join(dir, "session-key"),
    randomBytes(32).toString("hex"),
  );
  let now = Date.now();
  const store = new CrowdmarkFiles(
    { stateDir: dir, secretsDir: dir, origin: "https://test.invalid" },
    { now: () => now },
  );
  try {
    const t = await store.create(photo, "alice");
    await assert.rejects(store.receive(t.fileId, "bob", request()), {
      code: "CROWDMARK_FILE_INVALID",
    });
    await assert.rejects(
      store.receive(t.fileId, "alice", request(Buffer.from("wrong bytes"))),
      { code: "CROWDMARK_FILE_INVALID" },
    );
    await store.receive(t.fileId, "alice", request());
    await assert.rejects(store.receive(t.fileId, "alice", request()), {
      code: "CROWDMARK_FILE_INVALID",
    });
    await assert.rejects(store.get(t.fileId, "bob"), {
      code: "CROWDMARK_FILE_INVALID",
    });
    assert.deepEqual((await store.get(t.fileId, "alice")).bytes, png);
    assert(
      !(await readFile(path.join(store.dir, t.fileId + ".encrypted"))).includes(
        png,
      ),
    );
    await assert.rejects(store.get("../../session-key"), {
      code: "CROWDMARK_FILE_INVALID",
    });
    const other = await mkdtemp(path.join(tmpdir(), "crowd-key-"));
    try {
      await writeFile(
        path.join(other, "session-key"),
        randomBytes(32).toString("hex"),
      );
      await assert.rejects(
        new CrowdmarkFiles({ stateDir: dir, secretsDir: other }).get(t.fileId),
        { code: "CROWDMARK_FILE_INVALID" },
      );
    } finally {
      await rm(other, { recursive: true });
    }
    now += 25 * 3600000;
    await assert.rejects(store.get(t.fileId), {
      code: "CROWDMARK_FILE_INVALID",
    });
    await store.cleanup();
    assert.deepEqual(await readdir(store.dir), []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("Crowdmark reads omit signed URLs; revisions bind all answers; unsafe assignment states block writes", () => {
  const d = assignment();
  addPage(d, "q1", {
    filename: "work.jpg",
    url: "https://private.invalid/?secret=never-return",
  });
  const a = normalizeAssignment(d);
  assert(!JSON.stringify(a).includes("never-return"));
  requireEditable(a);
  for (const update of [
    { submittedAt: "now" },
    { gradedAt: "now" },
    { locked: true },
    { timed: true },
    { grouped: true },
    { due: "2000-01-01" },
  ])
    assert.throws(() => requireEditable({ ...a, ...update }), {
      code: "CROWDMARK_WRITE_BLOCKED",
    });
  const changed = structuredClone(d);
  changed.included.find(
    (x) => x.type === "assignment-pages",
  ).attributes.filename = "other.jpg";
  assert.notEqual(normalizeAssignment(changed).revision, a.revision);
  const malformed = structuredClone(d);
  malformed.included.find(
    (x) => x.type === "assignment-pages",
  ).relationships.question.data.id = "other";
  assert.throws(() => normalizeAssignment(malformed), {
    code: "CROWDMARK_RESPONSE_CHANGED",
  });
});

test("all Crowdmark writes require approval and batches reject them before any reads", async () => {
  for (const name of crowdmarkWriteTools) {
    assert(needsApproval(name, {}));
    let reads = 0;
    const r = await batchReads(
      {
        requests: [
          { name: "check_auth", arguments: {} },
          { name, arguments: {} },
        ],
      },
      async () => {
        reads++;
      },
    );
    assert(r.isError);
    assert.equal(reads, 0);
  }
  assert(
    !crowdmarkSchemas.create_crowdmark_upload.safeParse({
      ...photo,
      filename: "../answer.png",
    }).success,
  );
  assert(
    !crowdmarkSchemas.save_crowdmark_answers.safeParse({
      assessmentId: "../../other",
    }).success,
  );
});

test("stale revisions, approval rejection and ambiguous writes never replay browser actions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "crowd-write-"));
  let edits = 0;
  const doc = assignment();
  const session = {
    read: async () => structuredClone(doc),
    close: async () => {},
    edit: async () => {
      edits++;
      throw Error("private-secret");
    },
  };
  const cm = new Crowdmark({ stateDir: dir }, { session });
  const args = {
    assessmentId: "test-1",
    expectedRevision: normalizeAssignment(doc).revision,
    actionId: randomUUID(),
    answers: [{ questionId: "q2", text: "My work" }],
  };
  try {
    let approved = 0;
    assert.equal(
      readResult(
        await cm.call(
          "save_crowdmark_answers",
          { ...args, expectedRevision: "0".repeat(64) },
          "a",
          () => approved++,
        ),
      ).error.code,
      "CROWDMARK_CHANGED",
    );
    assert.equal(approved, 0);
    assert.equal(edits, 0);
    assert.equal(
      readResult(await cm.call("save_crowdmark_answers", args, "a")).error.code,
      "APPROVAL_REQUIRED",
    );
    assert.equal(edits, 0);
    const r = await cm.call(
      "save_crowdmark_answers",
      args,
      "a",
      async () => {},
    );
    assert.equal(readResult(r).error.code, "CROWDMARK_OUTCOME_UNKNOWN");
    assert(!JSON.stringify(r).includes("private-secret"));
    assert.equal(edits, 1);
    assert.equal(
      readResult(
        await cm.call("save_crowdmark_answers", args, "a", async () => {}),
      ).error.code,
      "CROWDMARK_ACTION_USED",
    );
    assert.equal(edits, 1);
    assert.equal(
      readResult(
        await cm.call(
          "submit_crowdmark_assignment",
          {
            assessmentId: "test-1",
            expectedRevision: args.expectedRevision,
            actionId: randomUUID(),
          },
          "a",
          async () => {},
        ),
      ).error.code,
      "CROWDMARK_INCOMPLETE",
    );
  } finally {
    await cm.close();
    await rm(dir, { recursive: true });
  }
});

test("browser request filter rejects unrelated writes, deletion, timers and altered final page sets", () => {
  const doc = assignment();
  addPage(doc, "q1", { filename: "work.jpg" });
  const a = normalizeAssignment(doc),
    qs = new Set(["q1"]),
    origin = "https://app.crowdmark.com";
  const allowed = (p, m, d, submit = false) =>
    allowedCrowdmarkWrite(origin + p, m, JSON.stringify(d), a, qs, submit);
  assert(
    allowed("/api/v2/student/assignment-pages", "POST", {
      data: {
        type: "assignment-pages",
        relationships: { question: { data: { id: "q1" } } },
      },
    }),
  );
  assert(
    !allowed("/api/v2/student/assignment-pages", "POST", {
      data: {
        type: "assignment-pages",
        relationships: { question: { data: { id: "q2" } } },
      },
    }),
  );
  assert(!allowed("/api/v2/student/assignment-pages/page-1", "DELETE", {}));
  assert(
    !allowed(
      "/api/v2/student/assignments/assignment-1/start_timed_assignment",
      "POST",
      {},
    ),
  );
  const p = a.questions[0].pages[0],
    payload = {
      pages: [
        {
          id: p.id,
          question_id: "q1",
          number: p.number,
          filename: p.filename,
          uuid: p.uuid,
        },
      ],
    };
  assert(
    allowed("/api/v2/student/assignments/assignment-1", "PUT", payload, true),
  );
  assert(!allowed("/api/v2/student/assignments/other", "PUT", payload, true));
  assert(
    !allowed(
      "/api/v2/student/assignments/assignment-1",
      "PUT",
      { pages: [] },
      true,
    ),
  );
});
