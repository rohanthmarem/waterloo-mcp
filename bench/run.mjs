// Usage: node bench/run.mjs <label> [--record-golden] [--check-golden] [--skip-browser]
// Writes bench/results/<label>.json. Compare two labels with node bench/compare.mjs a b.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkerBench } from "./worker-bench.mjs";
import { runGatewayBench } from "./gateway-bench.mjs";
import { runLocalBench } from "./local-bench.mjs";
import { saveGolden, compareGolden } from "./golden.mjs";

const label = process.argv[2] ?? "run";
// BENCH_LATENCY_MS sets the fake LEARN delay per request; 80 ms matches the measured real round trip.
const latencyMs = Number(process.env.BENCH_LATENCY_MS ?? 50);
const flags = new Set(process.argv.slice(3));
const record = flags.has("--record-golden");
const check = flags.has("--check-golden");
const mismatches = [];
const pending = [];
const golden = record
  ? (l, r) => pending.push(saveGolden(l, r))
  : check
    ? (l, r) =>
        pending.push(compareGolden(l, r).then((d) => d && mismatches.push(d)))
    : undefined;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
await mkdir(dir, { recursive: true });
const file = path.join(dir, label + ".json");
if (flags.has("--browser-only")) {
  const existing = JSON.parse(
    await (await import("node:fs/promises")).readFile(file, "utf8"),
  );
  existing.browser = await (
    await import("./browser-bench.mjs")
  ).runBrowserBench();
  await writeFile(file, JSON.stringify(existing, null, 1) + "\n");
  console.error("updated browser section in", file);
  process.exit(0);
}
const out = { label, at: new Date().toISOString(), node: process.version };
const goldenOnly = flags.has("--golden-only");
console.error("worker bench...");
out.worker = await runWorkerBench(
  goldenOnly
    ? { golden, coldRuns: 1, warmRuns: 0, latencyMs }
    : { golden, latencyMs },
);
console.error("gateway bench...");
out.gateway = await runGatewayBench({ golden, latencyMs });
if (goldenOnly) {
  await Promise.all(pending);
  if (mismatches.length) {
    console.error("GOLDEN MISMATCH", JSON.stringify(mismatches, null, 1));
    process.exit(1);
  }
  console.error("golden: all tool outputs match");
  process.exit(0);
}
console.error("local bench...");
out.local = await runLocalBench();
if (!flags.has("--skip-browser")) {
  console.error("browser bench...");
  try {
    out.browser = await (await import("./browser-bench.mjs")).runBrowserBench();
  } catch (error) {
    out.browser = { skipped: String(error.message).split("\n")[0] };
  }
}
await Promise.all(pending);
await writeFile(file, JSON.stringify(out, null, 1) + "\n");
console.error("wrote", file);
if (check) {
  if (mismatches.length) {
    console.error("GOLDEN MISMATCH", JSON.stringify(mismatches, null, 1));
    process.exitCode = 1;
  } else console.error("golden: all tool outputs match");
}
