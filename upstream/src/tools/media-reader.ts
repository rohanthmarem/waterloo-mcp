import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { z } from "zod";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolResponse } from "./tool-helpers.js";
const exec = promisify(execFile);
let running: string | undefined;
const pending = new Map<string, { status: string; expiresAt: number }>();
export function registerMediaReader(server: McpServer, api: D2LApiClient) {
  server.registerTool(
    "transcribe_course_media",
    {
      description:
        "Read a time window of a course audio/video file as machine-generated English text. Runs locally on exe.dev; no media is sent to a transcription provider. First call starts a background read job; repeat the same arguments to retrieve it. One job runs at a time. Use successive time windows to cover a full lecture. Speech recognition may mishear technical or mathematical terms.",
      inputSchema: z.object({
        courseId: z.number().int().positive(),
        topicId: z.number().int().positive(),
        startSeconds: z.number().int().min(0).max(86400).default(0),
        durationSeconds: z.number().int().min(10).max(600).default(300),
      }),
    },
    async (args) => {
      const id = createHash("sha256")
        .update(JSON.stringify({ ...args, model: "base.en" }))
        .digest("hex");
      const file =
        (process.env.WATERLOO_STATE_DIR ?? "/state") +
        "/transcripts/" +
        id +
        ".json";
      try {
        return toolResponse(JSON.parse(await readFile(file, "utf8")));
      } catch (e) {
        if ((e as any).code !== "ENOENT")
          return toolResponse({
            status: "failed",
            note: "Stored transcript is unavailable",
          });
      }
      const prior = pending.get(id);
      if (prior && prior.expiresAt > Date.now())
        return toolResponse({
          status: prior.status,
          jobId: id,
          ...(prior.status === "failed"
            ? {
                error: {
                  code: "MEDIA_TRANSCRIPTION_FAILED",
                  retryable: true,
                  action:
                    "Retry after one minute. Check the file type, size, and requested time window.",
                },
              }
            : {}),
          note: "Repeat the same request to check progress.",
        });
      pending.delete(id);
      if (running)
        return toolResponse({
          status: "busy",
          note: "Another transcription is running. Retry later.",
        });
      running = id;
      for (const [key, entry] of pending)
        if (entry.expiresAt <= Date.now()) pending.delete(key);
      if (pending.size >= 32) pending.delete(pending.keys().next().value!);
      pending.set(id, {
        status: "running",
        expiresAt: Date.now() + 30 * 60000,
      });
      void (async () => {
        let dir;
        try {
          const topic: any = await api.get(
            api.le(args.courseId, `/content/topics/${args.topicId}`),
          );
          if (topic.TopicType !== 1) throw new Error("Not a file topic");
          const response = await api.getRaw(
            api.le(args.courseId, `/content/topics/${args.topicId}/file`),
          );
          const mime = response.headers.get("content-type") ?? "";
          if (!mime.startsWith("video/") && !mime.startsWith("audio/")) {
            await response.body?.cancel();
            throw new Error("Not an audio/video file");
          }
          dir = await mkdtemp("/tmp/waterloo-media-");
          if (!response.body) throw new Error("Empty media response");
          let size = 0;
          const limit = new Transform({
            transform(chunk, encoding, done) {
              size += chunk.length;
              done(
                size > 512 * 1024 * 1024
                  ? new Error("Media exceeds 512 MiB limit")
                  : null,
                chunk,
              );
            },
          });
          // Stream to disk with backpressure; never retain a full lecture in memory.
          await pipeline(
            Readable.fromWeb(response.body as any),
            limit,
            createWriteStream(dir + "/source", { mode: 0o600 }),
            { signal: AbortSignal.timeout(120000) },
          );
          const probe = await exec(
            "ffprobe",
            [
              "-v",
              "error",
              "-show_entries",
              "format=duration",
              "-of",
              "json",
              dir + "/source",
            ],
            { timeout: 15000, maxBuffer: 100000 },
          );
          const duration = Number(JSON.parse(probe.stdout).format.duration);
          if (args.startSeconds >= duration)
            throw new Error("Requested window is past the end");
          await exec(
            "ffmpeg",
            [
              "-v",
              "error",
              "-ss",
              String(args.startSeconds),
              "-i",
              dir + "/source",
              "-t",
              String(args.durationSeconds),
              "-vn",
              "-ar",
              "16000",
              "-ac",
              "1",
              dir + "/audio.wav",
            ],
            { timeout: 120000, maxBuffer: 100000 },
          );
          const result = await exec(
            "/opt/transcription/bin/python",
            ["/app/transcribe.py", dir + "/audio.wav"],
            {
              timeout: 20 * 60000,
              maxBuffer: 2 * 1024 * 1024,
              env: {
                ...process.env,
                HF_HOME:
                  (process.env.WATERLOO_STATE_DIR ?? "/state") + "/models",
                OMP_NUM_THREADS: "2",
              },
            },
          );
          const data = JSON.parse(result.stdout);
          const end = Math.min(
            duration,
            args.startSeconds + args.durationSeconds,
          );
          const saved = {
            status: "complete",
            courseId: args.courseId,
            topicId: args.topicId,
            title: topic.Title,
            startSeconds: args.startSeconds,
            endSeconds: end,
            totalDurationSeconds: duration,
            nextStartSeconds: end < duration ? end : null,
            segments: data.segments.map((s: any) => ({
              ...s,
              start: s.start + args.startSeconds,
              end: s.end + args.startSeconds,
            })),
            note: "Machine speech transcription, not instructor-supplied captions. Verify mathematical notation against slides or notes.",
          };
          await mkdir(
            (process.env.WATERLOO_STATE_DIR ?? "/state") + "/transcripts",
            { recursive: true, mode: 0o700 },
          );
          await writeFile(file + ".pending", JSON.stringify(saved), {
            mode: 0o600,
          });
          await rename(file + ".pending", file);
          pending.delete(id);
        } catch {
          pending.set(id, { status: "failed", expiresAt: Date.now() + 60000 });
        } finally {
          if (dir) await rm(dir, { recursive: true, force: true });
          running = undefined;
        }
      })();
      return toolResponse({
        status: "running",
        jobId: id,
        note: "Reading media locally. Repeat the same request for the transcript; large clips may take several minutes.",
      });
    },
  );
}
