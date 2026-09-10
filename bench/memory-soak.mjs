// Usage: node bench/memory-soak.mjs [worker.js] [rounds]. Repeats three multi-request tools
// against the fake LEARN and prints worker RSS every five rounds. Set NODE_ARGS to pass
// flags such as --max-old-space-size=64, which separates a leak from lazy heap growth.
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeLearn } from "./fake-learn.mjs";
import { prepareState } from "./session.mjs";
import { treeRss } from "./measure.mjs";
const worker =
  process.argv[2] ??
  new URL("../upstream/build/index.js", import.meta.url).pathname;
const rounds = Number(process.argv[3] ?? 40);
const learn = await startFakeLearn({ latencyMs: 2 });
const state = await prepareState(learn);
const c = new Client({ name: "leak", version: "0" });
const t = new StdioClientTransport({
  command: process.execPath,
  args: [
    ...(process.env.NODE_ARGS ? process.env.NODE_ARGS.split(" ") : []),
    worker,
  ],
  env: state.env,
  stderr: "ignore",
});
await c.connect(t);
const rss = [];
for (let i = 0; i < rounds; i++) {
  const course = 101 + (i % 4);
  await c.callTool(
    { name: "get_assignments", arguments: { courseId: course } },
    undefined,
    { timeout: 180000 },
  );
  await c.callTool(
    { name: "get_course_content", arguments: { courseId: course } },
    undefined,
    { timeout: 180000 },
  );
  await c.callTool(
    {
      name: "get_discussions",
      arguments: { courseId: course, forumId: course * 10 },
    },
    undefined,
    { timeout: 180000 },
  );
  if (i % 5 === 4) {
    await new Promise((r) => setTimeout(r, 200));
    rss.push(Math.round(treeRss(t.pid) / 1048576));
  }
}
console.log(
  path.basename(path.dirname(path.dirname(path.dirname(worker)))),
  "RSS MiB every 5 rounds:",
  rss.join(" "),
  "requests:",
  learn.requests.length,
);
await c.close();
await learn.close();
