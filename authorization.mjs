import { mkdir, readFile, writeFile, rename, open } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
export const READ_TOOLS = new Set([
  "check_piazza_auth",
  "list_piazza_classes",
  "get_piazza_course_info",
  "get_piazza_feed",
  "search_piazza_posts",
  "get_piazza_post",
  "list_study_rooms",
  "get_study_room_availability",
  "get_study_room_bookings",
  "get_course_outline",
  "get_odyssey_schedule",
  "check_auth",
  "get_my_courses",
  "get_upcoming_due_dates",
  "get_my_grades",
  "get_announcements",
  "get_assignments",
  "get_assignment_files",
  "get_course_content",
  "get_classlist_emails",
  "get_roster",
  "get_syllabus",
  "get_discussions",
  "read_course_topic",
  "get_course_home",
  "get_course_news",
  "get_course_calendar",
  "get_course_checklists",
  "render_course_pdf_page",
  "transcribe_course_media",
  "read_course_link",
]);
export const ROOM_WRITE_TOOLS = new Set([
  "book_study_room",
  "cancel_study_room_booking",
]);
export const KNOWN_TOOLS = new Set([
  ...READ_TOOLS,
  "download_file",
  ...ROOM_WRITE_TOOLS,
]);
const stable = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? "[" + v.map(stable).join(",") + "]"
      : "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
          .join(",") +
        "}";
const digest = (name, args, caller) =>
  createHash("sha256").update(stable({ name, args, caller })).digest("hex");
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export class Authorizations {
  constructor(dir = "/state/approvals") {
    this.dir = dir;
  }
  async read(id) {
    if (!/^[a-f0-9]{48}$/.test(id)) throw new Error("Invalid approval ID");
    return JSON.parse(
      await readFile(path.join(this.dir, id + ".json"), "utf8"),
    );
  }
  async save(r) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const p = path.join(this.dir, r.id + ".json");
    await writeFile(p + ".pending", JSON.stringify(r), { mode: 0o600 });
    await rename(p + ".pending", p);
  }
  async request(name, args, caller, summary) {
    const r = {
      id: randomBytes(24).toString("hex"),
      nonce: randomBytes(32).toString("hex"),
      name,
      summary,
      args,
      caller,
      digest: digest(name, args, caller),
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60000,
      status: "pending",
    };
    await this.save(r);
    return r.id;
  }
  async consume(id, name, args, caller) {
    const r = await this.read(id);
    if (
      r.status !== "approved" ||
      Date.now() > r.expiresAt ||
      r.digest !== digest(name, args, caller)
    )
      throw new Error(
        "Approval missing, expired, or does not match this exact action",
      );
    const f = await open(path.join(this.dir, id + ".used"), "wx", 0o600);
    await f.close();
    return true;
  }
  async decide(id, nonce, decision) {
    const r = await this.read(id);
    if (r.status !== "pending" || Date.now() > r.expiresAt)
      throw new Error("Approval is no longer pending");
    const a = Buffer.from(nonce ?? ""),
      b = Buffer.from(r.nonce);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new Error("Invalid approval form");
    if (!["approve", "deny"].includes(decision))
      throw new Error("Invalid decision");
    r.status = decision === "approve" ? "approved" : "denied";
    await this.save(r);
    return r.status;
  }
  async page(id) {
    const r = await this.read(id);
    return `<!doctype html><html><meta name="viewport" content="width=device-width"><title>Approve MCP action</title><h1>Review MCP action</h1><p>Tool: <strong>${escape(r.name)}</strong></p><p>This action creates or changes saved data. Approve only if you want these exact parameters executed once.</p>${r.summary ? `<h2>Review the exact action</h2><pre>${escape(JSON.stringify(r.summary, null, 2))}</pre>` : ""}<pre>${escape(JSON.stringify(r.args, null, 2))}</pre><p>Status: ${escape(r.status)}. Expires: ${escape(new Date(r.expiresAt).toISOString())}</p>${r.status === "pending" && Date.now() < r.expiresAt ? `<form method="post"><input type="hidden" name="nonce" value="${r.nonce}"><button name="decision" value="approve">Approve this action once</button><button name="decision" value="deny">Deny</button></form>` : ""}</html>`;
  }
}
export function needsApproval(name, args) {
  return (
    ROOM_WRITE_TOOLS.has(name) ||
    name === "download_file" ||
    (name === "get_syllabus" && args.downloadPath !== undefined)
  );
}
export function validateWriteTarget(args) {
  const p = path.resolve(args.downloadPath ?? "");
  if (p !== "/state/downloads" && !p.startsWith("/state/downloads/"))
    throw new Error(
      "Downloads must be saved under /state/downloads, never into credentials or application files",
    );
  if (
    args.customFilename &&
    path.basename(args.customFilename) !== args.customFilename
  )
    throw new Error("Filename must not contain a directory");
}
export function describeTool(t) {
  return {
    ...t,
    annotations: {
      ...t.annotations,
      readOnlyHint:
        !ROOM_WRITE_TOOLS.has(t.name) &&
        t.name !== "download_file" &&
        t.name !== "get_syllabus",
      destructiveHint:
        ROOM_WRITE_TOOLS.has(t.name) ||
        t.name === "download_file" ||
        t.name === "get_syllabus",
    },
    ...(["download_file", "get_syllabus", ...ROOM_WRITE_TOOLS].includes(t.name)
      ? {
          description:
            t.description +
            (ROOM_WRITE_TOOLS.has(t.name)
              ? " This action requires explicit owner approval. Open the returned approval URL for the owner and retry the exact arguments with authorizationId only after approval."
              : " Saving a file requires explicit user approval at the returned approval URL. Retry with the returned authorizationId only after the user approves. Downloads must use /state/downloads."),
          inputSchema: {
            ...t.inputSchema,
            properties: {
              ...t.inputSchema.properties,
              authorizationId: {
                type: "string",
                description:
                  "One-use approval ID returned by this server after requesting the exact action.",
              },
            },
          },
        }
      : {}),
  };
}
