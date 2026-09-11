import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readConfig } from "../src/config.mjs";
const config = readConfig();
const file = process.argv[2];
if (!file) {
  console.error(
    "Usage: npm run smoke -- private/clients/CLIENT-ID.token [--live]",
  );
  process.exit(2);
}
const token = (await readFile(file, "utf8")).trim();
const c = new Client({ name: "waterloo-smoke", version: "0.4.0" });
try {
  await c.connect(
    new StreamableHTTPClientTransport(new URL(config.origin + "/mcp"), {
      requestInit: {
        headers: {
          [config.authMode === "portable"
            ? "Authorization"
            : "X-Exedev-Authorization"]: "Bearer " + token,
        },
      },
    }),
  );
  const list = await c.listTools();
  console.log(
    JSON.stringify({
      tools: list.tools.map((t) => t.name),
      count: list.tools.length,
    }),
  );
  if (process.argv.includes("--live")) {
    for (const name of [
      "check_auth",
      "get_my_courses",
      "get_odyssey_schedule",
    ]) {
      const result = await c.callTool({ name, arguments: {} }, undefined, {
        timeout: 180000,
      });
      console.log(JSON.stringify({ tool: name, ok: !result.isError }));
      if (result.isError) {
        console.log(result.content[0].text);
        process.exitCode = 1;
      }
    }
  }
} catch {
  console.error(
    "REMOTE_CHECK_FAILED: verify private proxy, client token, and service status.",
  );
  process.exitCode = 1;
} finally {
  await c.close();
}
