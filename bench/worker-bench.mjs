// Measures the upstream Brightspace worker directly over stdio against the fake LEARN.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeLearn } from "./fake-learn.mjs";
import { prepareState } from "./session.mjs";
import { workerScenarios } from "./scenarios.mjs";
import { sampler, treeRss, treeCpu, tokens, stats } from "./measure.mjs";
import { root } from "../src/config.mjs";

// BENCH_WORKER points the suite at another build, e.g. a checkout of the previous commit.
const WORKER =
  process.env.BENCH_WORKER ?? path.join(root, "upstream/build/index.js");
const responseText = (r) =>
  r.content.map((c) => (c.type === "text" ? c.text : (c.data ?? ""))).join("");

async function spawnWorker(env) {
  const started = performance.now();
  const c = new Client({ name: "bench", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [WORKER],
    env,
    stderr: "ignore",
  });
  await c.connect(transport);
  const list = await c.listTools();
  return {
    client: c,
    pid: transport.pid,
    startupMs: performance.now() - started,
    list,
  };
}

export async function runWorkerBench({
  latencyMs = 50,
  coldRuns = 2,
  warmRuns = 3,
  golden,
} = {}) {
  const learn = await startFakeLearn({ latencyMs });
  const state = await prepareState(learn);
  const downloadDir = path.join(state.dir, "downloads");
  await mkdir(downloadDir, { recursive: true });
  const scenarios = workerScenarios(downloadDir);
  const results = { latencyMs, startup: [], tools: {}, catalog: {} };
  try {
    // Startup and catalog, measured on fresh processes.
    for (let i = 0; i < 3; i++) {
      const w = await spawnWorker(state.env);
      await new Promise((r) => setTimeout(r, 300));
      results.startup.push({
        ms: w.startupMs,
        idleRssBytes: treeRss(w.pid),
        requests: learn.requests.length,
      });
      if (i === 0) {
        const text = JSON.stringify(w.list);
        results.catalog = {
          tools: w.list.tools.length,
          bytes: Buffer.byteLength(text),
          tokensEstimate: tokens(text),
        };
      }
      await w.client.close();
      learn.requests.length = 0;
    }
    // Cold: a fresh worker per scenario so every read misses the client cache.
    for (const s of scenarios) {
      const runs = [];
      for (let i = 0; i < coldRuns; i++) {
        const w = await spawnWorker(state.env);
        await rm(downloadDir, { recursive: true, force: true });
        await mkdir(downloadDir, { recursive: true });
        const before = learn.requests.length;
        const cpu0 = treeCpu(w.pid);
        const smp = sampler(w.pid);
        const t0 = performance.now();
        const r = await w.client.callTool(
          { name: s.name, arguments: s.args },
          undefined,
          { timeout: 180000 },
        );
        const ms = performance.now() - t0;
        const peak = smp.stop();
        const cpu = treeCpu(w.pid) - cpu0;
        const text = responseText(r);
        runs.push({
          ms,
          requests: learn.requests.length - before,
          bytes: Buffer.byteLength(text),
          tokensEstimate: tokens(text),
          peakRssBytes: peak,
          cpuSeconds: cpu,
          isError: !!r.isError,
        });
        if (i === 0 && golden) golden(s.label, r);
        await w.client.close();
      }
      results.tools[s.label] = { name: s.name, cold: summarize(runs) };
    }
    // Warm: one worker, repeated calls; the second and later calls hit the client cache.
    if (warmRuns < 1) return results;
    const w = await spawnWorker(state.env);
    for (const s of scenarios) {
      const runs = [];
      for (let i = 0; i < warmRuns + 1; i++) {
        await rm(downloadDir, { recursive: true, force: true });
        await mkdir(downloadDir, { recursive: true });
        const before = learn.requests.length;
        const t0 = performance.now();
        const r = await w.client.callTool(
          { name: s.name, arguments: s.args },
          undefined,
          { timeout: 180000 },
        );
        const ms = performance.now() - t0;
        if (i > 0)
          runs.push({
            ms,
            requests: learn.requests.length - before,
            bytes: Buffer.byteLength(responseText(r)),
            isError: !!r.isError,
          });
      }
      results.tools[s.label].warm = summarize(runs);
    }
    results.warmWorker = {
      rssBytesAfterAllTools: treeRss(w.pid),
      cpuSecondsTotal: treeCpu(w.pid),
    };
    await w.client.close();
  } finally {
    await learn.close();
    await rm(state.dir, { recursive: true, force: true });
  }
  return results;
}
function summarize(runs) {
  const pick = (k) =>
    runs.map((r) => r[k]).filter((v) => typeof v === "number");
  const out = {
    ms: stats(pick("ms")),
    requests: stats(pick("requests")),
    bytes: runs[0].bytes,
    isError: runs.some((r) => r.isError),
  };
  if (runs[0].tokensEstimate !== undefined)
    out.tokensEstimate = runs[0].tokensEstimate;
  if (runs[0].peakRssBytes !== undefined)
    out.peakRssBytes = Math.max(...pick("peakRssBytes"));
  if (runs[0].cpuSeconds !== undefined)
    out.cpuSeconds = stats(pick("cpuSeconds")).mean;
  return out;
}
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  const r = await runWorkerBench({ coldRuns: 1, warmRuns: 1 });
  console.log(JSON.stringify(r, null, 1).slice(0, 3000));
}
