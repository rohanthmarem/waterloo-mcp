// Measures the HTTP gateway in front of a real worker: auth path, catalog, call overhead,
// the outline composite, and concurrent reads.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateway } from "../gateway.mjs";
import { startFakeLearn } from "./fake-learn.mjs";
import { prepareState } from "./session.mjs";
import { C } from "./scenarios.mjs";
import { sampler, treeRss, treeCpu, tokens, stats } from "./measure.mjs";
import { root } from "../src/config.mjs";

// BENCH_WORKER points the suite at another build, e.g. a checkout of the previous commit.
const WORKER =
  process.env.BENCH_WORKER ?? path.join(root, "upstream/build/index.js");
const responseText = (r) =>
  r.content.map((c) => (c.type === "text" ? c.text : (c.data ?? ""))).join("");
async function timed(n, fn) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    xs.push(performance.now() - t0);
  }
  return stats(xs);
}

export async function runGatewayBench({ latencyMs = 50, golden } = {}) {
  const learn = await startFakeLearn({ latencyMs });
  const state = await prepareState(learn);
  await mkdir(path.join(state.stateDir, "downloads"), { recursive: true });
  const config = {
    owner: "owner@example.test",
    origin: "https://bench.example",
    stateDir: state.stateDir,
    secretsDir: state.secretsDir,
    username: state.username,
  };
  let workerPid;
  const app = createGateway(config, async () => {
    const c = new Client({ name: "waterloo-gateway", version: "bench" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [WORKER],
      env: state.env,
      stderr: "ignore",
    });
    await c.connect(transport);
    workerPid = transport.pid;
    return c;
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.address().port;
  const headers = {
    "X-ExeDev-Email": config.owner,
    "X-ExeDev-Token-Ctx": JSON.stringify({ role: "mcp", id: "bench-client" }),
  };
  const results = { latencyMs };
  const client = new Client({ name: "bench-agent", version: "0" });
  try {
    const rss0 = process.memoryUsage().rss;
    results.status = {
      ms: await timed(300, () =>
        fetch(base + "/status", { headers }).then((r) => r.text()),
      ),
    };
    results.statusRejected = {
      ms: await timed(100, () => fetch(base + "/status").then((r) => r.text())),
    };
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers },
      }),
    );
    let catalogText = "";
    results.toolsList = {
      ms: await timed(30, async () => {
        catalogText = JSON.stringify(await client.listTools());
      }),
    };
    results.toolsList.bytes = Buffer.byteLength(catalogText);
    results.toolsList.tokensEstimate = tokens(catalogText);
    results.toolsList.tools = JSON.parse(catalogText).tools.length;
    results.toolsList.perTool = Object.fromEntries(
      JSON.parse(catalogText).tools.map((t) => [
        t.name,
        Buffer.byteLength(JSON.stringify(t)),
      ]),
    );
    results.callCheckAuth = {
      ms: await timed(20, () =>
        client.callTool({ name: "check_auth", arguments: {} }),
      ),
    };
    results.callInvalidTool = {
      ms: await timed(50, () =>
        client.callTool({ name: "delete_everything", arguments: {} }),
      ),
    };
    // Composite outline read: content tree, then the selected topic.
    const before = learn.requests.length;
    const smp = sampler(process.pid);
    const t0 = performance.now();
    const outline = await client.callTool(
      { name: "get_course_outline", arguments: { courseId: C } },
      undefined,
      { timeout: 180000 },
    );
    results.outlineCold = {
      ms: performance.now() - t0,
      requests: learn.requests.length - before,
      bytes: Buffer.byteLength(responseText(outline)),
      isError: !!outline.isError,
      peakRssBytes: smp.stop(),
    };
    if (golden) golden("gateway:get_course_outline", outline);
    results.outlineWarm = {
      ms: (
        await timed(3, () =>
          client.callTool({
            name: "get_course_outline",
            arguments: { courseId: C },
          }),
        )
      ).p50,
    };
    // Concurrency: eight agents asking for grades in different courses at once.
    const before2 = learn.requests.length;
    const t1 = performance.now();
    const concurrent = await Promise.all(
      [101, 102, 103, 104, 101, 102, 103, 104].map((courseId) =>
        client.callTool({ name: "get_my_grades", arguments: { courseId } }),
      ),
    );
    results.concurrentGrades8 = {
      ms: performance.now() - t1,
      requests: learn.requests.length - before2,
      errors: concurrent.filter((r) => r.isError).length,
    };
    // Expensive-cache concurrency ceiling: five simultaneous distinct outline reads.
    const t2 = performance.now();
    const expensive = await Promise.all(
      [102, 103, 104, 105, 106].map((courseId) =>
        client.callTool(
          { name: "get_course_outline", arguments: { courseId } },
          undefined,
          { timeout: 180000 },
        ),
      ),
    );
    results.concurrentOutline5 = {
      ms: performance.now() - t2,
      busy: expensive.filter(
        (r) => r.isError && responseText(r).includes("SERVICE_BUSY"),
      ).length,
      errors: expensive.filter((r) => r.isError).length,
    };
    // Approval round trip cost (request only; no write is performed).
    results.approvalRequest = {
      ms: await timed(10, () =>
        client.callTool({
          name: "download_file",
          arguments: {
            courseId: C,
            topicId: C * 1000 + 102,
            downloadPath: "/state/downloads",
          },
        }),
      ),
    };
    results.memory = {
      harnessAndGatewayRssBytes: process.memoryUsage().rss,
      harnessRssBeforeBytes: rss0,
      workerRssBytes: workerPid ? treeRss(workerPid) : null,
      workerCpuSeconds: workerPid ? treeCpu(workerPid) : null,
    };
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => app.close(resolve));
    await learn.close();
    await rm(state.dir, { recursive: true, force: true });
  }
  return results;
}
