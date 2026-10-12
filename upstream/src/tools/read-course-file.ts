import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { D2LApiClient } from "../api/index.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { officeDocumentText } from "../utils/zip-extract.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";

export async function readBoundedCourseFile(response: Response, limit = 25 * 1024 * 1024): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("COURSE_FILE_TOO_LARGE: file exceeds the read limit.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const part of response.body as any) {
    bytes += part.length;
    if (bytes > limit) throw new Error("COURSE_FILE_TOO_LARGE: file exceeds the read limit.");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export function registerReadCourseFile(server: McpServer, api: D2LApiClient): void {
  server.registerTool("read_course_file", {
    description: "Read a PDF, text, HTML, or Office file linked inside a LEARN course page using the saved server session. Use for /content/enforced/ links without a standalone topicId, such as a handout linked in an assignment index. Returns paged text without saving or attaching a file. Do not open a separate browser login. Use download_file with fileUrl to request an approved save on the MCP host.",
    inputSchema: z.object({
      courseId: z.number().int().positive(),
      fileUrl: z.string().min(1).max(4096),
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(100).max(100000).default(20000),
    }),
  }, async ({ courseId, fileUrl, offset, maxChars }) => {
    try {
      const response = await api.getCourseFile(courseId, fileUrl);
      const mime = (response.headers.get("content-type") ?? "").split(";")[0];
      const filename = decodeURIComponent(new URL(fileUrl, "https://learn.uwaterloo.ca").pathname.split("/").pop() || "file");
      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      const buffer = await readBoundedCourseFile(response);
      let text = "";
      let note: string | undefined;
      if (mime === "application/pdf" || ext === "pdf") {
        // A login page must never masquerade as a PDF with an empty text layer.
        if (buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("COURSE_FILE_NOT_PDF: server did not return PDF data.");
        text = (await extractPdfText(buffer))?.text ?? "";
        if (!text.trim()) note = "This PDF has no readable text layer. It may be scanned or handwritten.";
      } else if (["docx", "xlsx", "pptx"].includes(ext)) text = officeDocumentText(buffer) ?? "";
      else if (mime === "text/html") text = convertHtmlToMarkdown(buffer.toString("utf8")).markdown;
      else if (mime.startsWith("text/") || ["txt", "md", "rkt", "csv", "json"].includes(ext)) text = buffer.toString("utf8");
      else note = "This file type has no text extractor. Use download_file with fileUrl for an approved save.";
      return toolResponse({ courseId, fileUrl, filename, mime, bytes: buffer.length,
        text: text.slice(offset, offset + maxChars), totalChars: text.length, offset,
        nextOffset: offset + maxChars < text.length ? offset + maxChars : null,
        ...(note ? { note } : {}), saved: false });
    } catch (error) { return sanitizeError(error); }
  });
}
