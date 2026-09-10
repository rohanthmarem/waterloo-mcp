// Usage: node bench/live-compare.mjs old new [stats-old.log stats-new.log]
// Prints Markdown tables from two bench/results/live-<label>.json files and, when
// given, summarizes `docker stats` samples ("<epoch> <mem>MiB / <limit> <cpu>%").
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const [oldLabel, newLabel, statsOld, statsNew] = process.argv.slice(2);
const load = async (l) =>
  JSON.parse(await readFile(path.join(dir, `live-${l}.json`), "utf8"));
const [a, b] = await Promise.all([load(oldLabel), load(newLabel)]);
const ms = (x) => (x === undefined || x === null ? "-" : `${Math.round(x)} ms`);
const pct = (x, y) =>
  typeof x === "number" && typeof y === "number" && x
    ? `${(((y - x) / x) * 100).toFixed(0)}%`
    : "-";
const kb = (x) => (x === undefined ? "-" : `${(x / 1024).toFixed(1)} KiB`);
const row = (...c) => `| ${c.join(" | ")} |`;
console.log(
  `## Real account through the private preview (${a.mode}, ${a.courses} courses${a.browser ? ", browser tools" : ""})\n`,
);
console.log(
  row(
    "tool",
    `${oldLabel} cold`,
    `${newLabel} cold`,
    "change",
    `${oldLabel} warm`,
    `${newLabel} warm`,
    "bytes before",
    "bytes after",
    "error",
  ),
);
console.log(row(...Array(9).fill("---")));
let coldA = 0,
  coldB = 0,
  n = 0;
for (const label of Object.keys(a.tools)) {
  const x = a.tools[label],
    y = b.tools[label];
  if (!y) continue;
  n++;
  coldA += x.cold?.ms ?? 0;
  coldB += y.cold?.ms ?? 0;
  console.log(
    row(
      label,
      ms(x.cold?.ms),
      ms(y.cold?.ms),
      pct(x.cold?.ms, y.cold?.ms),
      ms(x.warm?.ms),
      ms(y.warm?.ms),
      kb(x.cold?.bytes),
      kb(y.cold?.bytes),
      [x.cold?.error, y.cold?.error].filter(Boolean).join("/") || "",
    ),
  );
}
console.log(
  row(
    "**cold sweep total**",
    ms(coldA),
    ms(coldB),
    pct(coldA, coldB),
    "",
    "",
    "",
    "",
    "",
  ),
);
const summarize = async (file) => {
  if (!file) return null;
  const lines = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
  const mem = [],
    cpu = [];
  for (const line of lines) {
    const m = line.match(/^\d+ ([\d.]+)(MiB|GiB) \/ \S+ ([\d.]+)%/);
    if (!m) continue;
    mem.push(parseFloat(m[1]) * (m[2] === "GiB" ? 1024 : 1));
    cpu.push(parseFloat(m[3]));
  }
  if (!mem.length) return null;
  const sorted = [...mem].sort((x, y) => x - y);
  return {
    samples: mem.length,
    memPeakMiB: Math.max(...mem),
    memP50MiB: sorted[Math.floor(sorted.length / 2)],
    cpuMeanPct: cpu.reduce((s, v) => s + v, 0) / cpu.length,
    cpuPeakPct: Math.max(...cpu),
  };
};
const [sa, sb] = await Promise.all([summarize(statsOld), summarize(statsNew)]);
if (sa && sb) {
  console.log(
    `\n## Container on the VM during the sweep (docker stats, 2 s samples)\n`,
  );
  console.log(row("metric", oldLabel, newLabel, "change"));
  console.log(row("---", "---", "---", "---"));
  console.log(
    row(
      "memory peak",
      `${sa.memPeakMiB.toFixed(0)} MiB`,
      `${sb.memPeakMiB.toFixed(0)} MiB`,
      pct(sa.memPeakMiB, sb.memPeakMiB),
    ),
  );
  console.log(
    row(
      "memory median",
      `${sa.memP50MiB.toFixed(0)} MiB`,
      `${sb.memP50MiB.toFixed(0)} MiB`,
      pct(sa.memP50MiB, sb.memP50MiB),
    ),
  );
  console.log(
    row(
      "CPU mean",
      `${sa.cpuMeanPct.toFixed(1)}%`,
      `${sb.cpuMeanPct.toFixed(1)}%`,
      pct(sa.cpuMeanPct, sb.cpuMeanPct),
    ),
  );
  console.log(
    row(
      "CPU peak",
      `${sa.cpuPeakPct.toFixed(0)}%`,
      `${sb.cpuPeakPct.toFixed(0)}%`,
      pct(sa.cpuPeakPct, sb.cpuPeakPct),
    ),
  );
  console.log(row("samples", String(sa.samples), String(sb.samples), ""));
}
