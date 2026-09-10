// Golden snapshots: parsed tool output with volatile fields removed, so a formatting
// change (compact vs pretty JSON) compares equal while a data change does not.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden");
const VOLATILE = new Set([
  "retrievedAt",
  "requestId",
  "receivedAt",
  "updatedAt",
  "confirmedAt",
  "filePath",
]);
export function normalize(result) {
  return {
    isError: !!result.isError,
    content: result.content.map((c) => {
      if (c.type !== "text")
        return {
          type: c.type,
          mimeType: c.mimeType,
          bytes: c.data?.length ?? 0,
        };
      try {
        return { type: "text", json: scrub(JSON.parse(c.text)) };
      } catch {
        return { type: "text", text: c.text };
      }
    }),
  };
}
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, x]) => [k, scrub(x)]),
    );
  return v;
}
const file = (label) =>
  path.join(dir, label.replace(/[^a-z0-9_:-]/gi, "_") + ".json");
export async function saveGolden(label, result) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    file(label),
    JSON.stringify(normalize(result), null, 1) + "\n",
  );
}
export async function compareGolden(label, result) {
  const expected = JSON.parse(await readFile(file(label), "utf8"));
  const actual = normalize(result);
  // The fake LEARN listens on an ephemeral port that shows up in deep links.
  const port = (text) =>
    text
      .replace(/https:\/\/127\.0\.0\.1:\d+/g, "https://127.0.0.1:PORT")
      .replace(/[^"\\ ]*bench-state-[A-Za-z0-9]+/g, "BENCH_STATE");
  const a = port(JSON.stringify(expected)),
    b = port(JSON.stringify(actual));
  if (a === b) return null;
  return {
    label,
    expected: a.slice(0, 400),
    actual: b.slice(0, 400),
    diffAt: firstDiff(a, b),
  };
}
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return {
    index: i,
    expected: a.slice(Math.max(0, i - 60), i + 120),
    actual: b.slice(Math.max(0, i - 60), i + 120),
  };
}
