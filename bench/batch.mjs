// Compare serial client calls, concurrent client calls, and one read_many call.
// Local HTTP MCP + fixed 80 ms read latency; no school traffic or credentials.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateway } from "../gateway.mjs";
const dir = await mkdtemp(path.join(tmpdir(), "batch-bench-"));
await writeFile(
  path.join(dir, "clients.json"),
  JSON.stringify([
    { id: "bench", enabled: true, expiresAt: Date.now() + 60000 },
  ]),
);
const config = {
  owner: "bench@example.test",
  origin: "https://bench.exe.xyz",
  stateDir: dir,
  secretsDir: dir,
};
const app = createGateway(config, async () => ({
  listTools: async () => ({
    tools: [{ name: "get_my_grades", inputSchema: { type: "object" } }],
  }),
  callTool: async ({ arguments: args }) => {
    await new Promise((r) => setTimeout(r, 80));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ courseId: args.courseId, grade: 95 }),
        },
      ],
    };
  },
  close: async () => {},
}));
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const c = new Client({ name: "batch-benchmark", version: "1" });
try {
  await c.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${app.address().port}/mcp`),
      {
        requestInit: {
          headers: {
            "X-ExeDev-Email": config.owner,
            "X-ExeDev-Token-Ctx": JSON.stringify({ role: "mcp", id: "bench" }),
          },
        },
      },
    ),
  );
  const requests = Array.from({ length: 8 }, (_, i) => ({
    name: "get_my_grades",
    arguments: { courseId: 100 + i },
  }));
  for (let pass = 0; pass < 3; pass++)
    for (const mode of ["serial", "parallel-client", "batch"]) {
      const start = performance.now();
      let results;
      if (mode === "serial") {
        results = [];
        for (const request of requests) results.push(await c.callTool(request));
      } else if (mode === "parallel-client")
        results = await Promise.all(requests.map((r) => c.callTool(r)));
      else {
        const r = await c.callTool({
          name: "read_many",
          arguments: { requests },
        });
        if (r.isError) throw Error("BATCH_FAILED");
        results = JSON.parse(r.content[0].text).results.map((x) => x.result);
      }
      if (
        results.some((r) => r.isError) ||
        results.some(
          (r, i) => JSON.parse(r.content[0].text).courseId !== 100 + i,
        )
      )
        throw Error("RESULT_MISMATCH");
      console.log(
        JSON.stringify({
          pass,
          mode,
          ms: Math.round(performance.now() - start),
          mcpCalls: mode === "batch" ? 1 : 8,
          results: results.length,
        }),
      );
    }
} finally {
  await c.close();
  await new Promise((r) => app.close(r));
  await rm(dir, { recursive: true, force: true });
}
