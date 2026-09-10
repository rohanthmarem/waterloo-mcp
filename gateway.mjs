import http from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Authorizations,
  KNOWN_TOOLS,
  needsApproval,
  validateWriteTarget,
  describeTool,
} from "./authorization.mjs";
import { LibCal, roomTools } from "./libcal.mjs";
import { roomSchemas, parseRoomArgs, RoomError } from "./src/libcal.mjs";
import { outlineTool, getCourseOutline } from "./outlines.mjs";
import { readConfig, workerEnv, root } from "./src/config.mjs";
import { problem, toolError, normalizeToolResult } from "./src/errors.mjs";
import { ReadCache } from "./src/read-cache.mjs";
import { encrypt } from "./upstream/build/auth/encrypted-store.js";
import { PiazzaSession, PiazzaError } from "./src/piazza-session.mjs";
import { Piazza, piazzaTools, piazzaSchemas } from "./piazza.mjs";

const expensive = new Set([
  "get_course_home",
  "read_course_link",
  "get_course_outline",
  "get_odyssey_schedule",
]);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function reply(res, status, data, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}
function httpError(res, code) {
  const p = problem(code);
  reply(res, p.httpStatus, p);
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createGateway(
  config,
  createClient,
  {
    libcal = new LibCal(config),
    piazzaSession = new PiazzaSession(config),
  } = {},
) {
  const approvals = new Authorizations(path.join(config.stateDir, "approvals"));
  const cache = new ReadCache();
  const piazza = new Piazza(piazzaSession);
  let upstream;
  async function client() {
    upstream ??= createClient().catch(() => {
      upstream = undefined;
      throw new Error("UPSTREAM_UNAVAILABLE");
    });
    return upstream;
  }
  const app = http.createServer(async (req, res) => {
    try {
      // Trust only exe.dev's private authenticated proxy. Never expose this port publicly.
      if (req.headers["x-exedev-email"]?.toLowerCase() !== config.owner)
        return httpError(res, "AUTH_REQUIRED");
      const tokenContext = req.headers["x-exedev-token-ctx"];
      let caller = "owner-browser";
      if (tokenContext !== undefined) {
        let ctx;
        try {
          ctx = JSON.parse(tokenContext);
        } catch {
          return httpError(res, "CLIENT_REVOKED");
        }
        const clients = JSON.parse(
          await readFile(path.join(config.secretsDir, "clients.json"), "utf8"),
        );
        if (
          ctx.role !== "mcp" ||
          !clients.some(
            (c) => c.id === ctx.id && c.enabled && c.expiresAt > Date.now(),
          )
        )
          return httpError(res, "CLIENT_REVOKED");
        if (!["/mcp", "/status"].includes(req.url))
          return httpError(res, "CLIENT_REVOKED");
        caller = ctx.id;
      }
      if (req.headers.origin && req.headers.origin !== config.origin)
        return httpError(res, "ORIGIN_REJECTED");
      if (req.url === "/setup/piazza" && req.method === "GET")
        return reply(
          res,
          200,
          `<title>Connect Piazza</title><h1>Connect your Piazza account</h1><p>The server verifies your Piazza login, then encrypts the password and session for automatic renewal. Your agents receive course content through MCP; they cannot read this form or the saved credentials.</p><form method="post"><label>Piazza email <input type="email" name="email" value="${escape(config.username ?? "")}" required maxlength="254" autocomplete="username"></label><br><label>Piazza password <input type="password" name="password" required maxlength="512" autocomplete="current-password"></label><br><button>Verify and save encrypted Piazza login</button></form>`,
          "text/html; charset=utf-8",
        );
      if (req.url === "/setup/piazza" && req.method === "POST") {
        if (
          req.headers.origin !== config.origin ||
          !req.headers["content-type"]?.startsWith(
            "application/x-www-form-urlencoded",
          )
        )
          return httpError(res, "ORIGIN_REJECTED");
        const form = new URLSearchParams(await body(req));
        try {
          await piazzaSession.connect(form.get("email"), form.get("password"));
          return reply(
            res,
            200,
            "<h1>Piazza connected</h1><p>Login verified and saved encrypted. The saved login is ready for Piazza requests.</p>",
            "text/html; charset=utf-8",
          );
        } catch (error) {
          return httpError(
            res,
            error instanceof PiazzaError ? error.code : "UPSTREAM_UNAVAILABLE",
          );
        }
      }
      if (req.url === "/status" && req.method === "GET")
        return reply(res, 200, {
          service: "waterloo-mcp",
          version: "0.3.0",
          status: "running",
        });
      if (req.url?.startsWith("/approvals/")) {
        const id = req.url.slice("/approvals/".length);
        try {
          if (req.method === "GET")
            return reply(
              res,
              200,
              await approvals.page(id),
              "text/html; charset=utf-8",
            );
          if (
            req.method !== "POST" ||
            req.headers.origin !== config.origin ||
            !req.headers["content-type"]?.startsWith(
              "application/x-www-form-urlencoded",
            )
          )
            return httpError(res, "ORIGIN_REJECTED");
          const form = new URLSearchParams(await body(req));
          const status = await approvals.decide(
            id,
            form.get("nonce"),
            form.get("decision"),
          );
          return reply(
            res,
            200,
            `<h1>Action ${status}</h1><p>Return to your agent. An approved action can be retried once with the same arguments.</p>`,
            "text/html; charset=utf-8",
          );
        } catch {
          return httpError(res, "APPROVAL_INVALID");
        }
      }
      if (
        ["/", "/setup", "/connection"].includes(req.url) &&
        req.method === "GET"
      )
        return reply(
          res,
          200,
          `<title>Waterloo MCP</title><h1>Waterloo MCP</h1><p>Connected as ${escape(config.owner)}.</p><p>MCP URL: ${escape(config.origin)}/mcp</p><p>Use npm run client to add or revoke an agent. Use npm run login to update your Waterloo session.</p><h2>Piazza</h2><p><a href="/setup/piazza">Connect or update your Piazza login</a>. Piazza uses its own saved login and renews on this VM.</p><h2>Optional unattended renewal password</h2><p>Only needed after you set up your own separate test authenticator. This form encrypts your password on this server.</p><form method="post" action="/setup"><label>Waterloo password <input type="password" name="password" required maxlength="512" autocomplete="current-password"></label><button>Save encrypted password</button></form>`,
          "text/html; charset=utf-8",
        );
      if (req.url === "/setup" && req.method === "POST") {
        if (
          req.headers.origin !== config.origin ||
          !req.headers["content-type"]?.startsWith(
            "application/x-www-form-urlencoded",
          )
        )
          return httpError(res, "ORIGIN_REJECTED");
        const password = new URLSearchParams(await body(req)).get("password");
        if (!password || password.length > 512)
          return httpError(res, "INPUT_INVALID");
        const key = Buffer.from(
          (
            await readFile(path.join(config.secretsDir, "session-key"), "utf8")
          ).trim(),
          "hex",
        );
        try {
          const file = path.join(config.stateDir, "password.json");
          await writeFile(
            file + ".pending",
            JSON.stringify(encrypt(password, key, "waterloo-password:v1")),
            { mode: 0o600 },
          );
          await rename(file + ".pending", file);
        } finally {
          key.fill(0);
        }
        if (upstream) {
          await (await upstream).close();
          upstream = undefined;
        }
        return reply(
          res,
          200,
          "<h1>Password saved</h1><p>Run the renewal check to verify it.</p>",
          "text/html; charset=utf-8",
        );
      }
      if (req.url !== "/mcp") return httpError(res, "NOT_FOUND");
      if (req.method !== "POST")
        return reply(res, 405, problem("INPUT_INVALID"));
      let data;
      try {
        data = JSON.parse(await body(req));
      } catch (error) {
        return httpError(
          res,
          error.message === "REQUEST_TOO_LARGE"
            ? error.message
            : "INPUT_INVALID",
        );
      }
      const server = new Server(
        { name: "waterloo-mcp", version: "0.3.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          ...(await (await client()).listTools()).tools,
          outlineTool,
          ...roomTools,
          ...piazzaTools,
        ]
          .filter((t) => KNOWN_TOOLS.has(t.name))
          .map(describeTool),
      }));
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const { name } = params;
        let args = { ...params.arguments };
        const authorizationId = args.authorizationId;
        delete args.authorizationId;
        if (!KNOWN_TOOLS.has(name)) return toolError("TOOL_UNSUPPORTED");
        if (roomSchemas[name]) {
          try {
            args = parseRoomArgs(name, args);
          } catch {
            return toolError("INPUT_INVALID");
          }
        }
        if (needsApproval(name, args)) {
          try {
            if (name === "download_file" || name === "get_syllabus")
              validateWriteTarget(args);
          } catch {
            return toolError("WRITE_PATH_REJECTED");
          }
          if (!authorizationId) {
            let summary;
            if (roomSchemas[name]) {
              try {
                summary = await libcal.preview(name, args);
              } catch (error) {
                return toolError(
                  error instanceof RoomError
                    ? error.code
                    : "UPSTREAM_UNAVAILABLE",
                );
              }
            }
            const id = await approvals.request(name, args, caller, summary);
            return toolError("APPROVAL_REQUIRED", {
              ...(summary ? { summary } : {}),
              authorizationId: id,
              approvalUrl: config.origin + "/approvals/" + id,
            });
          }
          try {
            await approvals.consume(authorizationId, name, args, caller);
          } catch {
            return toolError("APPROVAL_INVALID");
          }
        }
        try {
          const run = async () =>
            normalizeToolResult(
              Object.hasOwn(piazzaSchemas, name)
                ? await piazza.call(name, args)
                : roomSchemas[name]
                  ? await libcal.call(name, args)
                  : name === "get_course_outline"
                    ? await getCourseOutline(await client(), args)
                    : await (
                        await client()
                      ).callTool({ name, arguments: args }, undefined, {
                        timeout: 180000,
                      }),
            );
          return expensive.has(name)
            ? await cache.get(JSON.stringify([name, args]), run)
            : await run();
        } catch (error) {
          return toolError(
            error.message === "SERVICE_BUSY"
              ? "SERVICE_BUSY"
              : "UPSTREAM_UNAVAILABLE",
          );
        }
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, data);
    } catch {
      if (!res.headersSent) httpError(res, "INTERNAL_ERROR");
      else res.end();
    }
  });
  app.requestTimeout = 200000;
  app.headersTimeout = 15000;
  // Start the worker as soon as the port is open so the first tool call after a
  // restart does not also pay for process start and API version discovery.
  app.on("listening", () => {
    client().catch(() => {});
  });
  app.on("close", () => {
    upstream?.then((c) => c.close()).catch(() => {});
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = readConfig();
    const app = createGateway(config, async () => {
      const c = new Client({ name: "waterloo-gateway", version: "0.3.0" });
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.join(root, "upstream/build/index.js")],
          env: workerEnv(config),
          stderr: "ignore",
        }),
      );
      return c;
    });
    app.on("error", () => {
      console.error(JSON.stringify(problem("SERVICE_UNAVAILABLE")));
      process.exitCode = 1;
    });
    app.listen(config.port, config.bind, () =>
      console.log(JSON.stringify({ event: "started", port: config.port })),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => app.close());
  } catch {
    console.error(JSON.stringify(problem("CONFIG_INVALID")));
    process.exitCode = 1;
  }
}
