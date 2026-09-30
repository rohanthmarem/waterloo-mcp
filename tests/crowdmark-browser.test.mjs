import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { Crowdmark, normalizeAssignment } from "../src/crowdmark.mjs";
import { CrowdmarkFiles, sha256 } from "../src/crowdmark-files.mjs";
import { assignment, png, addPage, readResult } from "./fixtures/crowdmark.mjs";
const enabled = process.env.WATERLOO_TEST_BROWSER === "1";
test(
  "real Chromium saves a photo and typed answer, preserves pages, then submits only after separate approval",
  { skip: !enabled },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crowd-browser-"));
    await writeFile(
      path.join(dir, "session-key"),
      randomBytes(32).toString("hex"),
    );
    const config = {
      stateDir: dir,
      secretsDir: dir,
      origin: "https://fixture.invalid",
    };
    const files = new CrowdmarkFiles(config);
    const ticket = await files.create(
      {
        filename: "answer.png",
        mimeType: "image/png",
        size: png.length,
        sha256: sha256(png),
      },
      "test",
    );
    await files.receive(
      ticket.fileId,
      "test",
      Object.assign(Readable.from([png]), {
        headers: { "content-type": "image/png" },
      }),
    );
    const doc = assignment();
    addPage(doc, "q1", { filename: "existing.jpg" });
    let approvals = 0,
      submissions = 0,
      uploads = 0,
      browserCalls = 0;
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.CROWD_TEST_CHROMIUM_CHANNEL,
    });
    const html = `<!doctype html><title>Synthetic Crowdmark assignment</title><h1>Practice assignment — local fixture</h1>
 <div class="assignment-question"><h3>Q1(a) (1 point)</h3><p>Upload your work</p><input type="file" accept="image/png,image/jpeg"><output id="photo">Existing page retained</output></div>
 <div class="assignment-question"><h3>Q2 (1 point)</h3><p>Explain your answer</p><textarea></textarea></div>
 <button>Submit for evaluation</button><p id="status"></p>
 <script>
 document.querySelector('input').onchange=async e=>{const f=e.target.files[0];const bytes=new Uint8Array(await f.arrayBuffer());await fetch('/fixture/upload',{method:'POST',body:JSON.stringify({name:f.name,bytes:Array.from(bytes)})});document.querySelector('#photo').textContent+=' + '+f.name;};
 document.querySelector('textarea').onchange=async e=>{await fetch('/fixture/text',{method:'POST',body:JSON.stringify({text:e.target.value})});};
 document.querySelector('button').onclick=async()=>{await fetch('/fixture/submit',{method:'POST'});document.querySelector('#status').textContent='Submitted successfully';};
 </script>`;
    const get = async (url) =>
      url.endsWith("/latest_content")
        ? {
            content: doc.included.find((x) => x.id === url.split("/").at(-2))
              .attributes.content,
          }
        : structuredClone(doc);
    const session = {
      read: get,
      get,
      close: async () => {},
      edit: async (operation) => {
        browserCalls++;
        assert(
          approvals >= browserCalls,
          "browser writes cannot start before approval",
        );
        const context = await browser.newContext();
        await context.route("**/*", async (route) => {
          const req = route.request(),
            u = new URL(req.url());
          assert.equal(u.origin, "https://app.crowdmark.com");
          if (u.pathname === "/student/assessments/test-1")
            return route.fulfill({ contentType: "text/html", body: html });
          if (u.pathname === "/fixture/upload") {
            const data = req.postDataJSON();
            assert.deepEqual(Buffer.from(data.bytes), png);
            uploads++;
            addPage(doc, "q1", { filename: data.name });
          } else if (u.pathname === "/fixture/text") {
            addPage(doc, "q2", { content: req.postDataJSON().text });
          } else if (u.pathname === "/fixture/submit") {
            assert.equal(approvals, 2);
            submissions++;
            doc.data.attributes["submitted-at"] = new Date().toISOString();
          } else throw Error("Unexpected fixture request: " + u.pathname);
          return route.fulfill({ contentType: "application/json", body: "{}" });
        });
        try {
          const p = await context.newPage();
          const r = await operation(p, context);
          if (process.env.CROWD_TEST_SCREENSHOT && submissions === 0)
            await p.screenshot({
              path: process.env.CROWD_TEST_SCREENSHOT,
              fullPage: true,
            });
          return r;
        } finally {
          await context.close();
        }
      },
    };
    const cm = new Crowdmark(config, { session, files });
    try {
      const args = {
        assessmentId: "test-1",
        expectedRevision: normalizeAssignment(doc).revision,
        actionId: randomUUID(),
        answers: [
          { questionId: "q1", fileIds: [ticket.fileId] },
          { questionId: "q2", text: "These are my own worked steps." },
        ],
      };
      const saved = readResult(
        await cm.call("save_crowdmark_answers", args, "test", async () => {
          approvals++;
        }),
      );
      assert.equal(saved.status, "saved_not_submitted", JSON.stringify(saved));
      assert.equal(submissions, 0);
      assert.equal(uploads, 1);
      assert.equal(
        saved.assignment.questions[0].pages[0].filename,
        "existing.jpg",
      );
      assert.equal(
        saved.assignment.questions[0].pages[1].filename,
        "answer.png",
      );
      const submit = {
        assessmentId: "test-1",
        expectedRevision: saved.assignment.revision,
        actionId: randomUUID(),
      };
      const blocked = await cm.call(
        "submit_crowdmark_assignment",
        submit,
        "test",
      );
      assert(blocked.isError);
      assert.equal(submissions, 0);
      const sent = readResult(
        await cm.call(
          "submit_crowdmark_assignment",
          submit,
          "test",
          async () => {
            approvals++;
          },
        ),
      );
      assert.equal(sent.status, "submitted", JSON.stringify(sent));
      assert.equal(submissions, 1);
    } finally {
      await cm.close();
      await browser.close();
      await rm(dir, { recursive: true });
    }
  },
);
