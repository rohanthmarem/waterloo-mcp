import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { D2LApiClient } from "../api/index.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { officeDocumentText } from "../utils/zip-extract.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { parseContentDispositionFilename } from "./download-file.js";
import { isPublishedNewsItem } from "./get-announcements.js";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { decrypt } from "../auth/encrypted-store.js";
import { chromium } from "playwright";
const id = z.number().int().positive();
const paging = {
  offset: z.number().int().min(0).default(0),
  maxChars: z.number().int().min(100).max(100000).default(20000),
};
const clean = (html: string) =>
  convertHtmlToMarkdown(
    html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ""),
  ).markdown;
async function bounded(response: Response) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body as any) {
    bytes += chunk.length;
    if (bytes > 25 * 1024 * 1024)
      throw new Error("File exceeds 25 MB read limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function chunk(text: string, offset: number, maxChars: number) {
  return {
    text: text.slice(offset, offset + maxChars),
    totalChars: text.length,
    offset,
    nextOffset: offset + maxChars < text.length ? offset + maxChars : null,
  };
}
export function registerReadCoverage(server: McpServer, api: D2LApiClient) {
  server.registerTool(
    "read_course_link",
    {
      description:
        "Read a public Waterloo webpage linked from a course topic, including published Course Outline Tool pages. Published Waterloo outlines can reuse saved Waterloo SSO cookies; other public pages use a fresh browser. Never enters a password or sends LEARN credentials to an external provider. Private external systems such as Piazza are reported as separate integrations, not silently treated as read.",
      inputSchema: z.object({ courseId: id, topicId: id, ...paging }),
    },
    async (args) => {
      let browser;
      try {
        const topic: any = await api.get(
          api.le(args.courseId, `/content/topics/${args.topicId}`),
        );
        if (!topic.Url)
          return toolResponse({
            status: "not_a_web_link",
            note: "The topic does not expose a web URL.",
          });
        const url = new URL(topic.Url, "https://learn.uwaterloo.ca");
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.hostname === "learn.uwaterloo.ca" ||
          !(
            url.hostname === "uwaterloo.ca" ||
            url.hostname.endsWith(".uwaterloo.ca")
          )
        )
          return toolResponse({
            status: "separate_access_required",
            url: url.href,
            note: "This is an external service or LEARN action link. Its contents have not been read.",
          });
        if (
          url.hostname === "outline.uwaterloo.ca" &&
          url.pathname.startsWith("/author")
        )
          return toolResponse({
            status: "authoring_link",
            url: url.href,
            note: "This points to the instructor authoring tool, not a published course outline.",
          });
        browser = await chromium.launch({ headless: true });
        let stored;
        if (url.hostname === "outline.uwaterloo.ca") {
          const key = Buffer.from(
            (
              await readFile(
                (process.env.WATERLOO_SECRETS_DIR ?? "/run/secrets") +
                  "/session-key",
                "utf8",
              )
            ).trim(),
            "hex",
          );
          stored = JSON.parse(
            decrypt(
              JSON.parse(
                await readFile(
                  (process.env.WATERLOO_STATE_DIR ?? "/state") +
                    "/browser.json",
                  "utf8",
                ),
              ),
              key,
              "waterloo-browser:v1",
            ),
          );
          key.fill(0);
        }
        const context = await browser.newContext(
          stored ? { storageState: stored } : {},
        );
        const page = await context.newPage();
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await page
          .waitForLoadState("networkidle", { timeout: 15000 })
          .catch(() => {});
        const finalOrigin = new URL(page.url()).origin;
        if (finalOrigin !== url.origin)
          return toolResponse({
            status: "separate_authentication_required",
            source: url.href,
            finalOrigin,
            note: "The linked page redirected to a login or another service; its contents have not been read.",
          });
        const text = await page.locator("body").innerText();
        return toolResponse({
          courseId: args.courseId,
          topicId: args.topicId,
          title: topic.Title,
          source: url.href,
          finalOrigin,
          ...chunk(text, args.offset, args.maxChars),
          note: stored
            ? "Linked Waterloo outline read using the existing Waterloo SSO session."
            : "Public linked page read without Waterloo credentials.",
        });
      } catch (e) {
        return sanitizeError(e);
      } finally {
        await browser?.close();
      }
    },
  );
  server.registerTool(
    "render_course_pdf_page",
    {
      description:
        "Read a PDF page as an image, including scanned or handwritten lecture notes. Returns one PNG image for a vision-capable MCP client; does not save a user download. Page numbers start at 1.",
      inputSchema: z.object({
        courseId: id,
        topicId: id,
        page: z.number().int().min(1).max(1000).default(1),
      }),
    },
    async (args) => {
      let dir;
      try {
        const topic: any = await api.get(
          api.le(args.courseId, `/content/topics/${args.topicId}`),
        );
        if (topic.TopicType !== 1) throw new Error("Not a file topic");
        const response = await api.getRaw(
          api.le(args.courseId, `/content/topics/${args.topicId}/file`),
        );
        const bytes = await bounded(response);
        if (bytes.subarray(0, 5).toString() !== "%PDF-")
          throw new Error("Not a PDF");
        dir = await mkdtemp("/tmp/waterloo-pdf-");
        await writeFile(dir + "/source.pdf", bytes, { mode: 0o600 });
        const info = await exec("pdfinfo", [dir + "/source.pdf"], {
          timeout: 10000,
          maxBuffer: 100000,
        });
        const pages = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
        if (!pages || args.page > pages)
          throw new Error("Page number is outside the PDF");
        await exec(
          "pdftoppm",
          [
            "-f",
            String(args.page),
            "-l",
            String(args.page),
            "-scale-to",
            "1800",
            "-singlefile",
            "-png",
            dir + "/source.pdf",
            dir + "/page",
          ],
          { timeout: 30000, maxBuffer: 100000 },
        );
        const image = await readFile(dir + "/page.png");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                courseId: args.courseId,
                topicId: args.topicId,
                title: topic.Title,
                page: args.page,
                totalPages: pages,
                note: "Rendered PDF page. Interpret visually; this is not OCR text.",
              }),
            },
            {
              type: "image" as const,
              mimeType: "image/png",
              data: image.toString("base64"),
            },
          ],
        };
      } catch (e) {
        return sanitizeError(e);
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    },
  );
  server.registerTool(
    "get_course_calendar",
    {
      description:
        "Read all course calendar events, including events not attached to an assignment or quiz. Pages results without changing the calendar.",
      inputSchema: z.object({
        courseId: id,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    },
    async (args) => {
      try {
        const all: any[] = await api.get(
          api.le(args.courseId, "/calendar/events/"),
        );
        const events = all.slice(args.offset, args.offset + args.limit);
        return toolResponse({
          courseId: args.courseId,
          total: all.length,
          offset: args.offset,
          nextOffset:
            args.offset + events.length < all.length
              ? args.offset + events.length
              : null,
          events,
        });
      } catch (e) {
        return sanitizeError(e);
      }
    },
  );
  server.registerTool(
    "get_course_checklists",
    {
      description:
        "Read course checklists or the items in a specific checklist. Does not mark items complete. Returns the server paging metadata; pass a bookmark to continue.",
      inputSchema: z.object({
        courseId: id,
        checklistId: id.optional(),
        bookmark: z.string().max(2000).optional(),
      }),
    },
    async (args) => {
      try {
        const route = args.checklistId
          ? `/checklists/${args.checklistId}/items/`
          : "/checklists/";
        return toolResponse(
          await api.get(
            api.le(args.courseId, route) +
              (args.bookmark
                ? "?bookmark=" + encodeURIComponent(args.bookmark)
                : ""),
          ),
        );
      } catch (e) {
        return sanitizeError(e);
      }
    },
  );
  server.registerTool(
    "read_course_topic",
    {
      description:
        "Read the actual contents of a course topic: HTML lecture pages, PDFs, Office documents, text, or images. Returns paged text without saving a download. Links and unsupported/scanned formats are identified explicitly; external sites are not fetched with LEARN credentials.",
      inputSchema: z.object({ courseId: id, topicId: id, ...paging }),
    },
    async (args) => {
      try {
        const topic: any = await api.get(
          api.le(args.courseId, `/content/topics/${args.topicId}`),
        );
        const base = {
          courseId: args.courseId,
          topicId: args.topicId,
          title: topic.Title,
          topicType: topic.TopicType,
          url: topic.Url,
        };
        if (topic.TopicType !== 1)
          return toolResponse({
            ...base,
            ...chunk(
              clean(topic.Description?.Html ?? topic.Description?.Text ?? ""),
              args.offset,
              args.maxChars,
            ),
            note: "Linked or embedded resource; its external contents have not been read.",
          });
        const response = await api.getRaw(
          api.le(args.courseId, `/content/topics/${args.topicId}/file`),
        );
        const mime = (response.headers.get("content-type") ?? "").split(";")[0];
        if (mime.startsWith("video/") || mime.startsWith("audio/")) {
          await response.body?.cancel();
          return toolResponse({
            ...base,
            mime,
            note: "Audio/video resource. No transcript was provided by the topic file endpoint; use transcribe_course_media for machine-generated text.",
          });
        }
        const buffer = await bounded(response);
        const filename =
          parseContentDispositionFilename(
            response.headers.get("content-disposition") ?? "",
          ) ??
          topic.Url?.split("/").pop() ??
          topic.Title;
        const ext = filename?.split(".").pop()?.toLowerCase();
        let text = "";
        let note;
        if (mime === "application/pdf" || ext === "pdf") {
          text = (await extractPdfText(buffer))?.text ?? "";
          if (!text.trim())
            note =
              "No PDF text layer. Use render_course_pdf_page to read scanned or handwritten pages with a vision-capable client.";
        } else if (["docx", "xlsx", "pptx"].includes(ext))
          text = officeDocumentText(buffer) ?? "";
        else if (mime === "text/html" || ["html", "htm"].includes(ext))
          text = clean(buffer.toString("utf8"));
        else if (
          mime.startsWith("text/") ||
          ["md", "json", "csv", "txt", "py", "r", "java", "js", "tex"].includes(
            ext,
          )
        )
          text = buffer.toString("utf8");
        else if (
          ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
            mime,
          ) &&
          buffer.length <= 5 * 1024 * 1024
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ...base,
                  filename,
                  mime,
                  bytes: buffer.length,
                  note: "Image content supplied for a vision-capable client.",
                }),
              },
              {
                type: "image" as const,
                mimeType: mime,
                data: buffer.toString("base64"),
              },
            ],
          };
        } else
          note =
            "This binary format has no server text extractor. It has not been interpreted.";
        return toolResponse({
          ...base,
          filename,
          mime,
          bytes: buffer.length,
          ...chunk(text, args.offset, args.maxChars),
          ...(note ? { note } : {}),
        });
      } catch (e) {
        return sanitizeError(e);
      }
    },
  );
  server.registerTool(
    "get_course_news",
    {
      description:
        "Read all published announcements in a course with full HTML converted to text, attachment metadata, and pagination. Unlike the recent-announcements tool, this can page beyond 50 posts.",
      inputSchema: z.object({
        courseId: id,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    },
    async (args) => {
      try {
        const raw: any[] = await api.get(api.le(args.courseId, "/news/"));
        const all = raw
          .filter(isPublishedNewsItem)
          .sort(
            (a, b) =>
              Date.parse(b.StartDate ?? b.CreatedDate ?? 0) -
              Date.parse(a.StartDate ?? a.CreatedDate ?? 0),
          );
        const posts = all
          .slice(args.offset, args.offset + args.limit)
          .map((x) => ({
            id: x.Id,
            title: x.Title,
            text: clean(x.Body?.Html ?? x.Body?.Text ?? ""),
            attachments: x.Attachments ?? [],
            createdDate: x.CreatedDate,
            startDate: x.StartDate,
            createdBy: x.CreatedBy,
          }));
        return toolResponse({
          courseId: args.courseId,
          total: all.length,
          offset: args.offset,
          nextOffset:
            args.offset + posts.length < all.length
              ? args.offset + posts.length
              : null,
          posts,
        });
      } catch (e) {
        return sanitizeError(e);
      }
    },
  );
  server.registerTool(
    "get_course_home",
    {
      description:
        "Read the rendered LEARN course homepage, including visible instructor widgets, notes, announcements, and links. Uses the saved browser session. Does not click controls or post content. Embedded external services may require separate access.",
      inputSchema: z.object({ courseId: id, ...paging }),
    },
    async (args) => {
      let browser;
      try {
        await api.get(api.lp("/users/whoami"));
        const key = Buffer.from(
          (
            await readFile(
              (process.env.WATERLOO_SECRETS_DIR ?? "/run/secrets") +
                "/session-key",
              "utf8",
            )
          ).trim(),
          "hex",
        );
        const state = JSON.parse(
          decrypt(
            JSON.parse(
              await readFile(
                (process.env.WATERLOO_STATE_DIR ?? "/state") + "/browser.json",
                "utf8",
              ),
            ),
            key,
            "waterloo-browser:v1",
          ),
        );
        key.fill(0);
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState: state });
        const page = await context.newPage();
        await page.goto(
          `https://learn.uwaterloo.ca/d2l/home/${args.courseId}`,
          { waitUntil: "domcontentloaded" },
        );
        await page.locator("body").waitFor({ state: "visible" });
        await page
          .waitForLoadState("networkidle", { timeout: 10000 })
          .catch(() => {});
        if (new URL(page.url()).origin !== "https://learn.uwaterloo.ca")
          throw new Error("Saved browser login requires renewal");
        let text = await page.locator("body").innerText();
        for (const frame of page.frames()) {
          if (
            frame !== page.mainFrame() &&
            frame.url().startsWith("https://learn.uwaterloo.ca/")
          ) {
            const extra = await frame
              .locator("body")
              .innerText({ timeout: 3000 })
              .catch(() => "");
            if (extra.trim()) text += "\n\n[Embedded course content]\n" + extra;
          }
        }
        const links = await page
          .locator("a[href]")
          .evaluateAll((nodes) =>
            nodes.map((n) => ({
              text: (n.textContent ?? "").trim(),
              url: (n as HTMLAnchorElement).href,
            })),
          );
        const frames = page
          .frames()
          .filter((f) => f !== page.mainFrame())
          .map((f) => ({ url: new URL(f.url() || "about:blank").origin }));
        return toolResponse({
          courseId: args.courseId,
          ...chunk(text, args.offset, args.maxChars),
          links,
          embeddedFrames: frames,
          note: "Visible homepage text only; external embedded tools are separate from the LEARN API.",
        });
      } catch (e) {
        return sanitizeError(e);
      } finally {
        await browser?.close();
      }
    },
  );
}
