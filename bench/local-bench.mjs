// In-process benches for the gateway's own tool code: LibCal catalog reads with a fake
// LibCal, Piazza thread rendering, approval records, and the read cache.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoomCatalog } from "../src/libcal.mjs";
import { threadText, Piazza } from "../piazza.mjs";
import { Authorizations } from "../authorization.mjs";
import { ReadCache } from "../src/read-cache.mjs";
import { stats, tokens } from "./measure.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roomsHtml = (lid, n) =>
  `locationId: ${lid}, bookingMethod: 11; ` +
  Array.from(
    { length: n },
    (_, i) =>
      `resources.push({title:'Room ${lid}-${i} (Max ${2 + (i % 6)})',seatId:${lid * 100 + i},eid:${lid * 10},gid:${lid},lid:${lid}});`,
  ).join("\n");
function fakeLibcal(latencyMs, day) {
  let calls = 0;
  const lids = { dclibrary: 40, dplibrary: 41, musagetes: 42 };
  const fetchImpl = async (url, options) => {
    calls++;
    await sleep(latencyMs);
    const u = new URL(url);
    if (u.pathname.startsWith("/reserve/spaces/")) {
      const lid = lids[u.pathname.split("/").pop()];
      return new Response(roomsHtml(lid, 8), {
        headers: { "Content-Type": "text/html" },
      });
    }
    const form = new URLSearchParams(options.body);
    const lid = Number(form.get("lid"));
    const slots = [];
    for (let i = 0; i < 8; i++)
      for (let h = 8; h < 22; h++)
        for (let q = 0; q < 4; q++) {
          const mm = String(q * 15).padStart(2, "0");
          const end =
            q === 3
              ? `${String(h + 1).padStart(2, "0")}:00`
              : `${String(h).padStart(2, "0")}:${String(q * 15 + 15).padStart(2, "0")}`;
          slots.push({
            itemId: lid * 100 + i,
            start: `${day} ${String(h).padStart(2, "0")}:${mm}:00`,
            end: `${day} ${end}:00`,
            checksum: "x",
            ...(h % 5 === 0 && i % 2 ? { className: "s-lc-eq-checkout" } : {}),
          });
        }
    return new Response(
      JSON.stringify({ slots, bookings: [], isPreCreatedBooking: false }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  return {
    fetchImpl,
    get calls() {
      return calls;
    },
  };
}
function bigThread(children, depth) {
  const node = (d, i) => ({
    type:
      d === 0
        ? "question"
        : d === 1
          ? i
            ? "followup"
            : "i_answer"
          : "feedback",
    created: "2026-09-01T00:00:00Z",
    history: [
      {
        subject: `Subject ${d}-${i}`,
        content: `<p>Body ${i} with <b>math</b> $x_i^2 + \\alpha$ and a <a href="https://piazza.com/x">link</a>. ${"lorem ipsum ".repeat(30)}</p>`,
      },
    ],
    children:
      d < depth
        ? Array.from({ length: children }, (_, j) => node(d + 1, j))
        : [],
  });
  return node(0, 0);
}
export async function runLocalBench() {
  const results = {};
  const now = () => new Date("2026-09-09T16:00:00Z");
  const day = "2026-09-10";
  for (const latencyMs of [40]) {
    const fl = fakeLibcal(latencyMs, day);
    const catalog = new RoomCatalog({ fetchImpl: fl.fetchImpl, now });
    const t0 = performance.now();
    await catalog.rooms();
    const roomsMs = performance.now() - t0;
    const roomsCalls = fl.calls;
    const t1 = performance.now();
    const availability = await catalog.availability({
      date: day,
      durationMinutes: 60,
    });
    const availMs = performance.now() - t1;
    const availText = JSON.stringify(availability);
    const t2 = performance.now();
    await catalog.availability({
      date: day,
      durationMinutes: 60,
      library: "davis",
    });
    const availOneMs = performance.now() - t2;
    results.libcal = {
      latencyMs,
      roomsMs,
      roomsRequests: roomsCalls,
      availabilityAllMs: availMs,
      availabilityAllRequests: fl.calls - roomsCalls,
      availabilityBytes: Buffer.byteLength(availText),
      availabilityTokensEstimate: tokens(availText),
      availabilityOneLibraryMs: availOneMs,
    };
  }
  const thread = bigThread(4, 4);
  const xs = [];
  let out;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    out = threadText(thread);
    xs.push(performance.now() - t0);
  }
  results.piazzaThread = {
    nodes: out.nodeCount,
    ms: stats(xs),
    chars: out.text.length,
  };
  // Piazza tool path with an in-memory session: JS overhead per call, excluding network.
  const status = {
    id: "u",
    networks: [
      {
        id: "cls",
        name: "Class",
        course_number: "CS 135",
        term: "Fall 2026",
        folders: ["hw1"],
      },
    ],
  };
  const session = {
    run: async (op) =>
      op(
        async (method) =>
          method === "user.status"
            ? status
            : method === "content.get"
              ? thread
              : { feed: [], more: false },
        { uid: "u" },
      ),
  };
  const piazza = new Piazza(session);
  results.piazzaPost = {
    ms: await timedStats(10, () =>
      piazza.call("get_piazza_post", { classId: "cls", postId: 1 }),
    ),
  };
  const dir = await mkdtemp(path.join(tmpdir(), "bench-approvals-"));
  try {
    const a = new Authorizations(dir);
    results.approvalRequest = {
      ms: await timedStats(50, () =>
        a.request(
          "download_file",
          { courseId: 1, topicId: 2, downloadPath: "/state/downloads" },
          "client",
        ),
      ),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const cache = new ReadCache();
  const big = { content: [{ type: "text", text: "x".repeat(1024 * 1024) }] };
  results.readCacheStore1MiB = {
    ms: await timedStats(20, (i) => cache.get("k" + i, async () => big)),
  };
  return results;
}
async function timedStats(n, fn) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    xs.push(performance.now() - t0);
  }
  return stats(xs);
}
