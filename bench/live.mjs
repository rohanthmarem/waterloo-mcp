// Real-account timing sweep. Read-only tools, no content is printed or stored.
//
//   node bench/live.mjs local  [--courses N] [--browser]
//       Runs the worker on this machine with your own .env and private/ state,
//       exactly as the gateway would, against learn.uwaterloo.ca.
//   node bench/live.mjs remote private/clients/NAME.token [--courses N] [--browser]
//       Runs the same sweep through a deployed instance over HTTPS MCP, which also
//       covers study rooms, Piazza, and the outline composite.
//
// A session that needs renewal will trigger the worker's normal renewal path,
// the same as check_auth from any agent. Results go to bench/results/live-<mode>.json.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readConfig, workerEnv, root } from "../src/config.mjs";
import { stats, tokens } from "./measure.mjs";

const [mode, tokenFile] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const courseLimit = Number(flag("--courses", 2));
const outLabel = flag("--label", mode);
const withBrowser = process.argv.includes("--browser");
if (!["local", "remote"].includes(mode) || (mode === "remote" && !tokenFile)) {
  console.error(
    "Usage: node bench/live.mjs local | remote TOKEN_FILE  [--courses N] [--browser]",
  );
  process.exit(2);
}
const config = readConfig();
const client = new Client({ name: "waterloo-live-bench", version: "0" });
if (mode === "local") {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "upstream/build/index.js")],
      env: workerEnv(config),
      stderr: "ignore",
    }),
  );
} else {
  const token = (await readFile(tokenFile, "utf8")).trim();
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.origin + "/mcp"), {
      requestInit: { headers: { "X-Exedev-Authorization": "Bearer " + token } },
    }),
  );
}
const rows = [];
const text = (r) =>
  r.content.map((c) => (c.type === "text" ? c.text : (c.data ?? ""))).join("");
const errorCode = (r) => {
  try {
    return JSON.parse(text(r)).error?.code ?? "error";
  } catch {
    return "error";
  }
};
async function call(label, name, args, pass) {
  const t0 = performance.now();
  let result;
  try {
    // The SDK timeout does not cover a TCP connect that never completes, so a
    // hard ceiling keeps one stalled connection from freezing the sweep.
    result = await Promise.race([
      client.callTool({ name, arguments: args }, undefined, {
        timeout: 180000,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("HARD_TIMEOUT")), 200000).unref(),
      ),
    ]);
  } catch (error) {
    const code =
      error?.message === "HARD_TIMEOUT" ? "CLIENT_TIMEOUT" : "TRANSPORT";
    result = {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: { code } }) }],
    };
  }
  const ms = performance.now() - t0;
  const body = text(result);
  rows.push({
    label,
    name,
    pass,
    ms,
    bytes: Buffer.byteLength(body),
    tokensEstimate: tokens(body),
    error: result.isError ? errorCode(result) : null,
  });
  console.error(
    `${pass.padEnd(4)} ${label.padEnd(36)} ${String(Math.round(ms)).padStart(6)} ms ${String(Buffer.byteLength(body)).padStart(8)} B ${result.isError ? errorCode(result) : ""}`,
  );
  return result;
}
const json = (r) => {
  try {
    return JSON.parse(text(r));
  } catch {
    return null;
  }
};
const sweep = async (pass) => {
  await call("check_auth", "check_auth", {}, pass);
  const courses = json(
    await call("get_my_courses", "get_my_courses", {}, pass),
  );
  const ids = (Array.isArray(courses) ? courses : [])
    .filter((c) => c.isActive !== false)
    .map((c) => c.id)
    .slice(0, courseLimit);
  await call(
    "get_upcoming_due_dates",
    "get_upcoming_due_dates",
    { daysAhead: 30 },
    pass,
  );
  await call("get_my_grades:all", "get_my_grades", {}, pass);
  await call("get_announcements:all", "get_announcements", { count: 10 }, pass);
  await call("get_assignments:all", "get_assignments", {}, pass);
  for (const courseId of ids) {
    const tree = json(
      await call(
        `get_course_content:${courseId}`,
        "get_course_content",
        { courseId },
        pass,
      ),
    );
    await call(
      `get_assignments:${courseId}`,
      "get_assignments",
      { courseId },
      pass,
    );
    await call(
      `get_my_grades:${courseId}`,
      "get_my_grades",
      { courseId },
      pass,
    );
    await call(
      `get_announcements:${courseId}`,
      "get_announcements",
      { courseId, count: 10 },
      pass,
    );
    await call(
      `get_discussions:${courseId}`,
      "get_discussions",
      { courseId },
      pass,
    );
    await call(`get_syllabus:${courseId}`, "get_syllabus", { courseId }, pass);
    await call(
      `get_course_news:${courseId}`,
      "get_course_news",
      { courseId },
      pass,
    );
    await call(
      `get_course_calendar:${courseId}`,
      "get_course_calendar",
      { courseId },
      pass,
    );
    await call(`get_roster:${courseId}`, "get_roster", { courseId }, pass);
    await call(
      `get_assignment_files:${courseId}`,
      "get_assignment_files",
      { courseId },
      pass,
    );
    const firstFile = (function find(nodes) {
      for (const n of nodes ?? []) {
        if (n.type === "topic" && n.topicType === "file") return n.id;
        const inner = n.children ? find(n.children) : null;
        if (inner) return inner;
      }
      return null;
    })(tree?.contentTree);
    if (firstFile)
      await call(
        `read_course_topic:${courseId}`,
        "read_course_topic",
        { courseId, topicId: firstFile },
        pass,
      );
    if (mode === "remote")
      await call(
        `get_course_outline:${courseId}`,
        "get_course_outline",
        { courseId },
        pass,
      );
    if (withBrowser)
      await call(
        `get_course_home:${courseId}`,
        "get_course_home",
        { courseId },
        pass,
      );
  }
  if (withBrowser)
    await call("get_odyssey_schedule", "get_odyssey_schedule", {}, pass);
  if (mode === "remote") {
    await call("list_study_rooms", "list_study_rooms", {}, pass);
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await call(
      "get_study_room_availability",
      "get_study_room_availability",
      { date, durationMinutes: 60 },
      pass,
    );
    const piazza = json(
      await call("check_piazza_auth", "check_piazza_auth", {}, pass),
    );
    if (piazza?.authenticated) {
      const classes = json(
        await call("list_piazza_classes", "list_piazza_classes", {}, pass),
      );
      const classId = classes?.classes?.[0]?.classId;
      if (classId) {
        const feed = json(
          await call("get_piazza_feed", "get_piazza_feed", { classId }, pass),
        );
        const postId = feed?.posts?.[0]?.postId;
        if (postId)
          await call(
            "get_piazza_post",
            "get_piazza_post",
            { classId, postId },
            pass,
          );
      }
    }
  }
};
try {
  await sweep("cold");
  await sweep("warm");
} finally {
  await client.close();
}
const summary = {};
for (const r of rows) {
  summary[r.label] ??= { name: r.name };
  summary[r.label][r.pass] = {
    ms: Math.round(r.ms),
    bytes: r.bytes,
    tokensEstimate: r.tokensEstimate,
    error: r.error,
  };
}
const out = {
  mode,
  at: new Date().toISOString(),
  courses: courseLimit,
  browser: withBrowser,
  calls: rows.length,
  totalColdMs: Math.round(
    rows.filter((r) => r.pass === "cold").reduce((a, r) => a + r.ms, 0),
  ),
  coldMs: stats(rows.filter((r) => r.pass === "cold").map((r) => r.ms)),
  tools: summary,
};
await mkdir(path.join(root, "bench/results"), { recursive: true });
await writeFile(
  path.join(root, "bench/results", `live-${outLabel}.json`),
  JSON.stringify(out, null, 1) + "\n",
);
console.error(
  `cold sweep total ${out.totalColdMs} ms over ${rows.length / 2} calls; wrote bench/results/live-${outLabel}.json`,
);
