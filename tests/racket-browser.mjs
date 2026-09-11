// Start a credential-free local runner first; see docs/racket.md.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { createGateway } from "../gateway.mjs";
import { provisionOwner, tokenHash } from "../src/portable-auth.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const home = await mkdtemp(path.join(tmpdir(), "racket-browser-"));
let app, browser, client;
try {
  await writeFile(
    path.join(home, "session-key"),
    randomBytes(32).toString("hex"),
  );
  await provisionOwner(home, path.join(home, "owner.token"));
  const owner = (await readFile(path.join(home, "owner.token"), "utf8")).trim();
  const agent = "wm1_" + randomBytes(32).toString("base64url");
  await writeFile(
    path.join(home, "clients.json"),
    JSON.stringify([
      {
        id: "fixture-agent",
        enabled: true,
        expiresAt: Date.now() + 600000,
        tokenHash: tokenHash(agent),
      },
    ]),
  );
  const config = {
    home,
    stateDir: home,
    secretsDir: home,
    origin: "",
    owner: "fixture@example.test",
    username: "fixture@uwaterloo.ca",
    authMode: "portable",
    racketUrl: process.env.RACKET_RUNNER_URL ?? "http://127.0.0.1:19010",
  };
  app = createGateway(config, async () => ({
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
    close: async () => {},
  }));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  config.origin = "http://127.0.0.1:" + app.address().port;
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  await page.goto(config.origin + "/racket");
  await page.getByLabel("Owner access key").fill(owner);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("link", { name: "Continue to your requested page" })
    .click();
  await page.getByLabel("Workspace ID").fill("cs135-practice");
  await page.getByLabel("Title", { exact: true }).fill("CS 135 · Practice");
  await page.getByLabel("Assignment title").fill("Practice: squared distance");
  await page
    .getByLabel("Instructions")
    .fill(
      "Write square and test its behavior. This is synthetic practice material.",
    );
  await page
    .getByLabel("Racket program")
    .fill(
      "(define (square x) (* x x))\n(check-expect (square 4) 16)\n(check-expect (square -3) 9)",
    );
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForFunction(() =>
    document
      .getElementById("revision")
      .textContent.includes("Revision 1 · saved"),
  );
  await page.getByRole("button", { name: "Run saved code" }).click();
  await page.waitForFunction(() =>
    document.getElementById("run-status").textContent.includes("completed"),
  );
  assert.match(await page.locator("#output").textContent(), /passed|test/i);
  client = new Client({ name: "browser-fixture", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.origin + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + agent } },
    }),
  );
  const read = async () =>
    JSON.parse(
      (
        await client.callTool({
          name: "read_racket_workspace",
          arguments: { id: "cs135-practice" },
        })
      ).content[0].text,
    );
  const saved = await read();
  assert.equal(saved.revision, 1);
  const update = {
    id: saved.id,
    title: saved.title,
    language: saved.language,
    assignment: saved.assignment,
    code: saved.code + "\n; Agent-reviewed example",
    expectedRevision: 1,
  };
  const pending = JSON.parse(
    (
      await client.callTool({
        name: "save_racket_workspace",
        arguments: update,
      })
    ).content[0].text,
  ).error;
  assert.equal(pending.code, "APPROVAL_REQUIRED");
  assert.equal((await read()).revision, 1);
  await page
    .getByLabel("Racket program")
    .fill(saved.code + "\n; Unsaved student edit");
  const approval = await browser.newPage(); // New page has no owner cookie; sign in normally.
  await approval.goto(pending.approvalUrl);
  await approval.getByLabel("Owner access key").fill(owner);
  await approval.getByRole("button", { name: "Sign in", exact: true }).click();
  await approval
    .getByRole("link", { name: "Continue to your requested page" })
    .click();
  await approval
    .getByRole("button", { name: "Approve this action once" })
    .click();
  const applied = await client.callTool({
    name: "save_racket_workspace",
    arguments: { ...update, authorizationId: pending.authorizationId },
  });
  assert(!applied.isError);
  await page.waitForFunction(
    () =>
      document
        .getElementById("message")
        .textContent.includes("newer saved revision"),
    {},
    { timeout: 10000 },
  );
  assert(
    (await page.getByLabel("Racket program").inputValue()).includes(
      "Unsaved student edit",
    ),
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForFunction(() =>
    document
      .getElementById("message")
      .textContent.includes("RACKET_REVISION_CONFLICT"),
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .getElementById("revision")
      .textContent.includes("Revision 2 · saved"),
  );
  await page.getByRole("button", { name: "Run saved code" }).click();
  await page.waitForFunction(() =>
    document
      .getElementById("run-status")
      .textContent.includes("Revision 2 · completed"),
  );
  if (process.env.RACKET_SCREENSHOT)
    await page.screenshot({
      path: process.env.RACKET_SCREENSHOT,
      fullPage: true,
    });
  console.log(
    "RACKET_BROWSER_PASSED: owner login, assignment display, code save/run, agent read, owner-approved edit, concurrent-edit conflict, reload, teaching tests",
  );
} finally {
  await client?.close();
  await browser?.close();
  if (app) await new Promise((r) => app.close(r));
  await rm(home, { recursive: true, force: true });
}
