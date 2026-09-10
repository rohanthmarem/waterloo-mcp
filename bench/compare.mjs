// Usage: node bench/compare.mjs baseline after  -> Markdown tables to stdout.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const [a, b] = await Promise.all(
  process.argv
    .slice(2, 4)
    .map(async (l) =>
      JSON.parse(await readFile(path.join(dir, l + ".json"), "utf8")),
    ),
);
const ms = (x) => (x === undefined || x === null ? "-" : Math.round(x) + " ms");
const mb = (x) =>
  x === undefined || x === null ? "-" : (x / 1048576).toFixed(0) + " MiB";
const kb = (x) =>
  x === undefined || x === null ? "-" : (x / 1024).toFixed(1) + " KiB";
const pct = (x, y) =>
  typeof x === "number" && typeof y === "number" && x
    ? (((y - x) / x) * 100).toFixed(0) + "%"
    : "-";
const row = (...cells) => "| " + cells.join(" | ") + " |";
console.log(
  `## Worker tools (cold, fresh process; simulated LEARN RTT ${a.worker.latencyMs} ms)\n`,
);
console.log(
  row(
    "tool",
    `${a.label} p50`,
    `${b.label} p50`,
    "change",
    "requests",
    "bytes before",
    "bytes after",
    "bytes change",
    "peak RSS before",
    "peak RSS after",
  ),
);
console.log(row(...Array(10).fill("---")));
for (const k of Object.keys(a.worker.tools)) {
  const x = a.worker.tools[k],
    y = b.worker.tools[k];
  if (!y) continue;
  console.log(
    row(
      k,
      ms(x.cold.ms.p50),
      ms(y.cold.ms.p50),
      pct(x.cold.ms.p50, y.cold.ms.p50),
      `${x.cold.requests.p50}→${y.cold.requests.p50}`,
      kb(x.cold.bytes),
      kb(y.cold.bytes),
      pct(x.cold.bytes, y.cold.bytes),
      mb(x.cold.peakRssBytes),
      mb(y.cold.peakRssBytes),
    ),
  );
}
console.log(`\n## Worker tools (warm, same process, repeated call)\n`);
console.log(
  row("tool", `${a.label} p50`, `${b.label} p50`, "change", "requests"),
);
console.log(row(...Array(5).fill("---")));
for (const k of Object.keys(a.worker.tools)) {
  const x = a.worker.tools[k],
    y = b.worker.tools[k];
  if (!y) continue;
  console.log(
    row(
      k,
      ms(x.warm.ms.p50),
      ms(y.warm.ms.p50),
      pct(x.warm.ms.p50, y.warm.ms.p50),
      `${x.warm.requests.p50}→${y.warm.requests.p50}`,
    ),
  );
}
const s = (o) => o.startup.reduce((m, x) => m + x.ms, 0) / o.startup.length;
const r = (o) =>
  o.startup.reduce((m, x) => m + x.idleRssBytes, 0) / o.startup.length;
console.log(`\n## Worker process\n`);
console.log(row("metric", a.label, b.label, "change"));
console.log(row("---", "---", "---", "---"));
console.log(
  row(
    "startup to tools/list",
    ms(s(a.worker)),
    ms(s(b.worker)),
    pct(s(a.worker), s(b.worker)),
  ),
);
console.log(
  row(
    "idle RSS after startup",
    mb(r(a.worker)),
    mb(r(b.worker)),
    pct(r(a.worker), r(b.worker)),
  ),
);
console.log(
  row(
    "RSS after all tools (warm)",
    mb(a.worker.warmWorker.rssBytesAfterAllTools),
    mb(b.worker.warmWorker.rssBytesAfterAllTools),
    pct(
      a.worker.warmWorker.rssBytesAfterAllTools,
      b.worker.warmWorker.rssBytesAfterAllTools,
    ),
  ),
);
console.log(
  row(
    "CPU seconds, whole warm pass",
    a.worker.warmWorker.cpuSecondsTotal.toFixed(2),
    b.worker.warmWorker.cpuSecondsTotal.toFixed(2),
    pct(
      a.worker.warmWorker.cpuSecondsTotal,
      b.worker.warmWorker.cpuSecondsTotal,
    ),
  ),
);
console.log(
  row(
    "worker tools/list bytes (22 tools)",
    kb(a.worker.catalog.bytes),
    kb(b.worker.catalog.bytes),
    pct(a.worker.catalog.bytes, b.worker.catalog.bytes),
  ),
);
console.log(`\n## Gateway\n`);
console.log(row("metric", a.label, b.label, "change"));
console.log(row("---", "---", "---", "---"));
const g = (k, f = (x) => x?.ms?.p50, fmt = ms) =>
  console.log(
    row(
      k,
      fmt(f(a.gateway)),
      fmt(f(b.gateway)),
      pct(f(a.gateway), f(b.gateway)),
    ),
  );
g("/status with token (p50)", (x) => x.status.ms.p50);
g("/status unauthenticated (p50)", (x) => x.statusRejected.ms.p50);
g("tools/list (p50)", (x) => x.toolsList.ms.p50);
g("tools/list bytes", (x) => x.toolsList.bytes, kb);
g(
  "tools/list est. tokens",
  (x) => x.toolsList.tokensEstimate,
  (x) => String(x),
);
g("tools/call check_auth via gateway (p50)", (x) => x.callCheckAuth.ms.p50);
g("tools/call unknown tool (p50)", (x) => x.callInvalidTool.ms.p50);
g("get_course_outline cold", (x) => x.outlineCold.ms);
g(
  "get_course_outline cold requests",
  (x) => x.outlineCold.requests,
  (x) => String(x),
);
g("get_course_outline warm", (x) => x.outlineWarm.ms);
g("8 concurrent get_my_grades", (x) => x.concurrentGrades8.ms);
g("5 concurrent distinct outlines", (x) => x.concurrentOutline5.ms);
g(
  "5 concurrent outlines: SERVICE_BUSY",
  (x) => x.concurrentOutline5.busy,
  (x) => String(x),
);
g("approval request (p50)", (x) => x.approvalRequest.ms.p50);
g("worker RSS at end", (x) => x.memory.workerRssBytes, mb);
g("gateway+harness RSS at end", (x) => x.memory.harnessAndGatewayRssBytes, mb);
console.log(`\n## Gateway-local tools\n`);
console.log(row("metric", a.label, b.label, "change"));
console.log(row("---", "---", "---", "---"));
const l = (k, f, fmt = ms) =>
  console.log(
    row(k, fmt(f(a.local)), fmt(f(b.local)), pct(f(a.local), f(b.local))),
  );
l("LibCal room catalog (3 libraries)", (x) => x.libcal.roomsMs);
l("LibCal availability, all libraries", (x) => x.libcal.availabilityAllMs);
l("LibCal availability, one library", (x) => x.libcal.availabilityOneLibraryMs);
l("LibCal availability bytes", (x) => x.libcal.availabilityBytes, kb);
l("Piazza thread render (341 nodes) p50", (x) => x.piazzaThread.ms.p50);
l("Piazza get_piazza_post in-memory p50", (x) => x.piazzaPost.ms.p50);
l("approval record write p50", (x) => x.approvalRequest.ms.p50);
l("read cache store 1 MiB p50", (x) => x.readCacheStore1MiB.ms.p50);
if (a.browser && b.browser && !a.browser.skipped && !b.browser.skipped) {
  console.log(`\n## Browser lifecycle\n`);
  console.log(row("metric", a.label, b.label, "change"));
  console.log(row("---", "---", "---", "---"));
  const w = (k, f, fmt = ms) =>
    console.log(
      row(
        k,
        fmt(f(a.browser)),
        fmt(f(b.browser)),
        pct(f(a.browser), f(b.browser)),
      ),
    );
  w(
    "fresh Chromium per call: total p50",
    (x) => x.freshBrowserPerCall.totalMs.p50,
  );
  w(
    "fresh Chromium per call: launch p50",
    (x) => x.freshBrowserPerCall.launchMs.p50,
  );
  w(
    "fresh Chromium per call: peak tree RSS",
    (x) => x.freshBrowserPerCall.peakTreeRssBytes,
    mb,
  );
  w(
    "shared Chromium: context+page+close p50",
    (x) => x.sharedBrowserPerCall.contextPageCloseMs.p50,
  );
  w(
    "shared Chromium: idle tree RSS",
    (x) => x.sharedBrowserPerCall.idleTreeRssBytes,
    mb,
  );
  w(
    "worker pool: first call (launch included)",
    (x) => x.workerPool?.firstCallMs,
  );
  w("worker pool: later calls p50", (x) => x.workerPool?.laterCallsMs?.p50);
}
