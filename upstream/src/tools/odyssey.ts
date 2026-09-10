import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withBrowser } from "../utils/browser-pool.js";
import { decrypt } from "../auth/encrypted-store.js";
import { toolResponse } from "./tool-helpers.js";

const source = "https://odyssey.uwaterloo.ca/teaching/schedule";
const exec = promisify(execFile);
async function readSchedule() {
  const key = Buffer.from(
    (
      await readFile(
        (process.env.WATERLOO_SECRETS_DIR ?? "/run/secrets") + "/session-key",
        "utf8",
      )
    ).trim(),
    "hex",
  );
  let state;
  try {
    state = JSON.parse(
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
  } finally {
    key.fill(0);
  }
  // A fresh isolated context per read; the browser process is shared.
  return withBrowser(async (browser) => {
    const context = await browser.newContext({ storageState: state });
    try {
      const page = await context.newPage();
      await page.goto(source, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {});
      const url = new URL(page.url());
      if (
        url.origin !== "https://odyssey.uwaterloo.ca" ||
        url.pathname !== "/teaching/schedule"
      )
        return null;
      const body = await page.locator("body").innerText();
      if (!body.includes("Assessment Schedule (")) return null;
      const tables = await page.locator("table").evaluateAll((nodes) =>
        nodes.map((table) => {
          const grid: string[][] = [];
          for (const [r, row] of Array.from(
            (table as HTMLTableElement).rows,
          ).entries()) {
            grid[r] ??= [];
            let c = 0;
            for (const cell of Array.from(row.cells)) {
              while (grid[r][c] !== undefined) c++;
              for (let y = 0; y < cell.rowSpan; y++)
                for (let x = 0; x < cell.colSpan; x++) {
                  grid[r + y] ??= [];
                  grid[r + y][c + x] = (cell.innerText ?? "").trim();
                }
              c += cell.colSpan;
            }
          }
          return grid;
        }),
      );
      const table = tables.find(
        (t) => t[0]?.join("|") === "Exam|Duration|When|Room|Seat|Sequence",
      );
      if (!table)
        throw new Error("Odyssey schedule format changed; no schedule inferred.");
      const assessments = table
        .slice(1)
        .filter((row) => row.some(Boolean))
        .map((row) => {
          if (row.length !== 6)
            throw new Error("Unexpected Odyssey row; no fields inferred.");
          const [exam, duration, when, room, seat, sequence] = row;
          const match = when.match(
            /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})[–-](\d{2}:\d{2})$/,
          );
          return {
            exam,
            duration,
            when,
            room: room || null,
            seat: seat || null,
            sequence: sequence || null,
            date: match?.[1] ?? null,
            startTime: match?.[2] ?? null,
            endTime: match?.[3] ?? null,
          };
        });
      const notice =
        body.split("\n").find((s) => s.includes("Assigned seat information")) ??
        null;
      return { assessments, notice };
    } finally {
      await context.close();
    }
  });
}

export function registerOdyssey(server: McpServer) {
  server.registerTool(
    "get_odyssey_schedule",
    {
      description:
        "Read your Waterloo Odyssey assessment schedule: quizzes, midterms, finals, dates, times, durations, rooms, assigned seats, and sequence numbers. Reads the personal schedule using the existing Waterloo sign-in on the VM. TBA stays TBA; missing dates remain null. Includes only assessments published in Odyssey, not every course deadline. Does not edit a calendar, book/change seats, submit work, or send messages.",
      inputSchema: z.object({
        course: z
          .string()
          .regex(/^[A-Za-z]{2,10}\s*\d{2,4}[A-Za-z]?$/)
          .optional()
          .describe(
            "Optional course filter, e.g. MATH 137 or CS135. Omit for all assessments.",
          ),
      }),
    },
    async ({ course }) => {
      try {
        let data = await readSchedule();
        if (!data) {
          // Reuse the existing serialized, cooldown-protected Waterloo renewal.
          // Never return its output, which may contain authentication diagnostics.
          await exec(process.execPath, ["/app/renew.mjs"], {
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          });
          data = await readSchedule();
        }
        if (!data) throw new Error("Odyssey sign-in still required");
        const filter = course?.replace(/\s/g, "").toUpperCase();
        const assessments = data.assessments.filter(
          (a) =>
            !filter ||
            a.exam
              .match(/^[A-Za-z]+\s*\d+[A-Za-z]?/)?.[0]
              .replace(/\s/g, "")
              .toUpperCase() === filter,
        );
        return toolResponse({
          source,
          retrievedAt: new Date().toISOString(),
          timezone: "America/Toronto",
          totalAssessments: data.assessments.length,
          count: assessments.length,
          course: course ?? null,
          assessments,
          notice: data.notice,
          note: "Only assessments currently published in Odyssey. TBA and null mean not published, not cancelled. Dates and times are local Waterloo time. Seat details may appear closer to the exam.",
        });
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Could not read the authenticated Odyssey schedule. Sign-in may need renewal, Odyssey may be unavailable, or its page format may have changed. No empty schedule was inferred.",
            },
          ],
        };
      }
    },
  );
}
