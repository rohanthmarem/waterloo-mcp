// Process sampling helpers shared by the benches.
import { execFileSync } from "node:child_process";

/** Resident set size in bytes for a pid and all its descendants. */
export function treeRss(pid) {
  let rows;
  try {
    rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number));
  } catch {
    return 0;
  }
  const children = new Map();
  const rss = new Map();
  for (const [p, pp, r] of rows) {
    rss.set(p, r);
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp).push(p);
  }
  let total = 0;
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    total += rss.get(p) ?? 0;
    for (const c of children.get(p) ?? []) stack.push(c);
  }
  return total * 1024;
}
/** CPU seconds (user+sys) consumed so far by a pid tree. */
export function treeCpu(pid) {
  let rows;
  try {
    rows = execFileSync("ps", ["-axo", "pid=,ppid=,time="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/));
  } catch {
    return 0;
  }
  const children = new Map();
  const cpu = new Map();
  for (const [p, pp, t] of rows) {
    const parts = t.split(":").map(Number);
    const secs =
      parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    cpu.set(Number(p), secs);
    if (!children.has(Number(pp))) children.set(Number(pp), []);
    children.get(Number(pp)).push(Number(p));
  }
  let total = 0;
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    total += cpu.get(p) ?? 0;
    for (const c of children.get(p) ?? []) stack.push(c);
  }
  return total;
}
export function sampler(pid, intervalMs = 40) {
  let peak = treeRss(pid);
  const timer = setInterval(() => {
    peak = Math.max(peak, treeRss(pid));
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(peak, treeRss(pid));
    },
  };
}
/** Token estimate: whitespace-insensitive JSON is roughly 3.6 bytes/token for
 * English-heavy payloads; pretty-printed JSON with indentation trends lower. We report
 * bytes as the ground truth and a chars/4 estimate as a convention. */
export const tokens = (text) => Math.round(text.length / 4);
export const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    min: s[0],
    p50: q(0.5),
    p90: q(0.9),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
};
