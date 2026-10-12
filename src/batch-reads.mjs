import { z } from "zod";
import { READ_TOOLS, needsApproval } from "../authorization.mjs";
import { toolError } from "./errors.mjs";
const schema = z
  .object({
    requests: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            arguments: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const batchReadTool = {
  name: "read_many",
  description:
    "Read up to eight independent MCP resources in one round trip, with at most three calls running at once. Use for school briefings across LEARN, Piazza, Odyssey, rooms and Marmoset. Supply discovered IDs; dependent reads need a subsequent batch. Only known read-only calls are allowed. Downloads, approvals, submissions, edits, media rendering/transcription and nested batches are rejected before any call runs. Results preserve input order and each tool's errors. Large results must be requested individually. Saves agent/network round trips without caching page content.",
  inputSchema: z.toJSONSchema(schema),
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const excluded = new Set(["render_course_pdf_page", "transcribe_course_media"]);
export async function batchReads(input, call) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return toolError("INPUT_INVALID");
  const requests = parsed.data.requests;
  if (
    requests.some(
      (r) =>
        !READ_TOOLS.has(r.name) ||
        excluded.has(r.name) ||
        needsApproval(r.name, r.arguments) ||
        Object.hasOwn(r.arguments, "authorizationId"),
    )
  )
    return toolError("BATCH_READ_ONLY");
  const results = new Array(requests.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= requests.length) return;
      const r = requests[index];
      let result;
      try {
        result = await call(r.name, r.arguments);
      } catch {
        result = toolError("UPSTREAM_UNAVAILABLE");
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
        result = toolError("BATCH_RESULT_TOO_LARGE");
      results[index] = { index, name: r.name, result };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, requests.length) }, worker),
  );
  return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
}
