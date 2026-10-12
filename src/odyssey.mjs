import { z } from "zod";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionHttp, SessionExpired } from "./session-http.mjs";
import { documentFromHtml, htmlText } from "./html.mjs";
import { withBrowser } from "../upstream/build/utils/browser-pool.js";
import { root, workerEnv } from "./config.mjs";
import { toolError } from "./errors.mjs";
const source = "https://odyssey.uwaterloo.ca/teaching/schedule";
const schema = z
  .object({
    course: z
      .string()
      .regex(/^[A-Za-z]{2,10}\s*\d{2,4}[A-Za-z]?$/)
      .optional(),
  })
  .strict();
const exec = promisify(execFile);
export function parseSchedule(html) {
  const doc = documentFromHtml(html);
  if (!doc.body.textContent.includes("Assessment Schedule ("))
    throw new SessionExpired();
  let selected;
  for (const table of Array.from(doc.querySelectorAll("table"))) {
    const grid = [];
    for (const [r, row] of Array.from(table.querySelectorAll("tr")).entries()) {
      grid[r] ??= [];
      let c = 0;
      for (const cell of Array.from(row.children).filter((n) =>
        ["TD", "TH"].includes(n.tagName),
      )) {
        while (grid[r][c] !== undefined) c++;
        const rows = Number(cell.getAttribute("rowspan") ?? 1),
          cols = Number(cell.getAttribute("colspan") ?? 1);
        if (
          !Number.isInteger(rows) ||
          !Number.isInteger(cols) ||
          rows < 1 ||
          cols < 1 ||
          rows > 100 ||
          cols > 20 ||
          r > 1000
        )
          throw Error("ODYSSEY_RESPONSE_CHANGED");
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < cols; x++) {
            grid[r + y] ??= [];
            grid[r + y][c + x] = htmlText(cell).trim();
          }
        c += cols;
      }
    }
    if (grid[0]?.join("|") === "Exam|Duration|When|Room|Seat|Sequence") {
      selected = grid;
      break;
    }
  }
  if (!selected) throw Error("ODYSSEY_RESPONSE_CHANGED");
  const assessments = selected
    .slice(1)
    .filter((r) => r.some(Boolean))
    .map((row) => {
      if (row.length !== 6) throw Error("ODYSSEY_RESPONSE_CHANGED");
      const [exam, duration, when, room, seat, sequence] = row;
      const m = when.match(
        /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})[–-](\d{2}:\d{2})$/,
      );
      return {
        exam,
        duration,
        when,
        room: room || null,
        seat: seat || null,
        sequence: sequence || null,
        date: m?.[1] ?? null,
        startTime: m?.[2] ?? null,
        endTime: m?.[3] ?? null,
      };
    });
  const notice =
    htmlText(doc.body)
      .split("\n")
      .find((s) => s.includes("Assigned seat information")) ?? null;
  return { assessments, notice };
}
export class Odyssey {
  constructor(
    config,
    {
      browse = withBrowser,
      renew = () =>
        exec(process.execPath, [path.join(root, "renew.mjs")], {
          env: workerEnv(config),
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        }),
    } = {},
  ) {
    this.renew = renew;
    this.http = new SessionHttp(config, {
      origin: new URL(source).origin,
      allowed: (u) => u.href === source,
      authenticated: (html) => html.includes("Assessment Schedule ("),
      bootstrap: (state) =>
        browse(async (browser) => {
          const context = await browser.newContext({
            storageState: state,
            serviceWorkers: "block",
            acceptDownloads: false,
          });
          try {
            const page = await context.newPage();
            await page.goto(source, {
              waitUntil: "domcontentloaded",
              timeout: 45000,
            });
            await page.waitForURL(source, { timeout: 15000 }).catch(() => {});
            if (
              page.url() !== source ||
              !(await page.locator("body").innerText()).includes(
                "Assessment Schedule (",
              )
            )
              throw new SessionExpired();
            return await context.storageState();
          } finally {
            await context.close();
          }
        }),
    });
  }
  close() {
    return this.http.close();
  }
  async call(args) {
    const input = schema.safeParse(args);
    if (!input.success) return toolError("INPUT_INVALID");
    try {
      const read = () =>
        this.http.run(async (get) => parseSchedule((await get(source)).html));
      let data;
      try {
        data = await read();
      } catch (e) {
        if (!(e instanceof SessionExpired)) throw e;
        try {
          await this.renew();
        } catch {
          throw new SessionExpired();
        }
        data = await read();
      }
      const course = input.data.course;
      const filter = course?.replace(/\s/g, "").toUpperCase();
      const assessments = data.assessments.filter(
        (a) =>
          !filter ||
          a.exam
            .match(/^[A-Za-z]+\s*\d+[A-Za-z]?/)?.[0]
            .replace(/\s/g, "")
            .toUpperCase() === filter,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              source,
              retrievedAt: new Date().toISOString(),
              timezone: "America/Toronto",
              totalAssessments: data.assessments.length,
              count: assessments.length,
              course: course ?? null,
              assessments,
              notice: data.notice,
              note: "Only assessments currently published in Odyssey. TBA and null mean not published, not cancelled. Dates and times are local Waterloo time. Seat details may appear closer to the exam.",
            }),
          },
        ],
      };
    } catch (e) {
      return toolError(
        e instanceof SessionExpired
          ? "AUTH_REAUTH_REQUIRED"
          : e.message === "SERVICE_BUSY"
            ? "SERVICE_BUSY"
            : "UPSTREAM_UNAVAILABLE",
      );
    }
  }
}
