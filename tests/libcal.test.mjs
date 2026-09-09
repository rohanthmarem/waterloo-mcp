import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  RoomCatalog,
  RoomError,
  parseRooms,
  bookingWindow,
  parseRoomArgs,
  availableWindows,
  assertAvailable,
  formEncode,
} from "../src/libcal.mjs";
import { LibCal, BookingStore } from "../libcal.mjs";
import { trustedCancelUrl } from "../src/libcal-browser.mjs";
const now = () => new Date("2026-09-09T16:00:00Z");
const args = {
  roomId: 10,
  date: "2026-09-10",
  startTime: "13:00",
  durationMinutes: 60,
  partySize: 1,
  bookingRequestId: randomUUID(),
};
const room = {
  roomId: 10,
  eid: 20,
  gid: 30,
  lid: 40,
  method: 11,
  name: "Room Test (Max 2)",
  library: "davis",
  libraryName: "Davis Centre Library",
  capacity: 2,
  url: "https://libcal.uwaterloo.ca/seat/10",
};
const slots = Array.from({ length: 8 }, (_, i) => ({
  itemId: 10,
  start: `2026-09-10 ${13 + Math.floor(i / 4)}:${String((i % 4) * 15).padStart(2, "0")}:00`,
  end: `2026-09-10 ${13 + Math.floor((i + 1) / 4)}:${String(((i + 1) % 4) * 15).padStart(2, "0")}:00`,
  checksum: "fixture",
}));
const catalog = {
  now,
  find: async () => room,
  prepare: async (a) => ({ ...room, ...bookingWindow(a, now()) }),
  grid: async () => slots,
};
const code = (result) => JSON.parse(result.content[0].text).error?.code;
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "waterloo-room-"));
  const config = { stateDir: dir, secretsDir: path.join(dir, "secrets") };
  await mkdir(config.secretsDir);
  await writeFile(
    path.join(config.secretsDir, "session-key"),
    randomBytes(32).toString("hex"),
  );
  try {
    await run(config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("room dates use Waterloo time, validate calendar dates and support midnight endings", () => {
  assert.equal(bookingWindow(args, now()).end, "2026-09-10 14:00:00");
  assert.equal(
    bookingWindow({ ...args, startTime: "23:00" }, now()).end,
    "2026-09-11 00:00:00",
  );
  for (const patch of [
    { date: "2026-02-30" },
    { date: "2026-09-17" },
    { startTime: "13:07" },
    { date: "2026-09-09", startTime: "10:00" },
    { startTime: "24:00" },
  ])
    assert.throws(() => bookingWindow({ ...args, ...patch }, now()));
  assert.throws(() =>
    parseRoomArgs("book_study_room", { ...args, url: "https://other.example" }),
  );
  assert.throws(() =>
    parseRoomArgs("book_study_room", { ...args, durationMinutes: 195 }),
  );
});
test("public HTML parsing never evaluates scripts and extracts room capacity", () => {
  const html = String.raw`locationId: 40, bookingMethod: 11; resources.push({title:'Room\u0020Test\u0020(Max\u00202)',seatId:10,eid:20,gid:30,lid:40});`;
  assert.equal(parseRooms(html, "davis")[0].name, room.name);
  assert.throws(
    () =>
      parseRooms(
        html.replace("bookingMethod: 11", "bookingMethod: 99"),
        "davis",
      ),
    /ROOM_PAGE_CHANGED/,
  );
});
test("availability preserves blocked gaps and rejects a changed slot", () => {
  const g = structuredClone(slots);
  g[3].className = "s-lc-eq-checkout";
  assert.equal(availableWindows(g, 10, 60, now()).length, 1);
  assert.throws(
    () =>
      assertAvailable(g, 10, args.date + " 13:00:00", args.date + " 14:00:00"),
    /ROOM_UNAVAILABLE/,
  );
  assert.doesNotThrow(() =>
    assertAvailable(
      slots,
      10,
      args.date + " 13:00:00",
      args.date + " 14:00:00",
    ),
  );
  assert.equal(
    new URLSearchParams(formEncode({ bookings: [{ seat_id: 10 }] })).get(
      "bookings[0][seat_id]",
    ),
    "10",
  );
  assert.equal(
    trustedCancelUrl("https://evil.example/equipment/cancel?x=1"),
    null,
  );
  assert.equal(
    trustedCancelUrl(
      "https://libcal.uwaterloo.ca@example.test/equipment/cancel",
    ),
    null,
  );
});
test("public search uses only the availability POST and no checkout or authentication", async () => {
  const calls = [];
  const c = new RoomCatalog({
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({ slots, bookings: [], isPreCreatedBooking: false }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  c.rooms = async () => [room];
  const result = await c.availability({ date: args.date, durationMinutes: 60 });
  assert.equal(result.rooms.length, 1);
  assert(calls.every((c) => c.url.endsWith("/spaces/availability/grid")));
  assert(calls.every((c) => !c.options.headers.Cookie));
});
test("bookings are encrypted, duplicate attempts are blocked, and cancellation URLs remain private", () =>
  fixture(async (config) => {
    let submitted = 0;
    const driver = {
      book: async (a, before, saveReceipt) => {
        await before();
        await saveReceipt({ html: "fixture-private receipt", httpStatus: 200 });
        submitted++;
        return {
          status: "confirmed",
          cancellationUrl:
            "https://libcal.uwaterloo.ca/equipment/cancel?secret=fixture-private",
        };
      },
      cancel: async (r, before) => {
        await before();
        return { status: "cancelled" };
      },
    };
    const libcal = new LibCal(config, { catalog, driver });
    const first = await libcal.call("book_study_room", args);
    assert(!first.isError);
    assert(!JSON.stringify(first).includes("fixture-private"));
    assert.equal(
      (await libcal.store.load())[0].receipt.html,
      "fixture-private receipt",
    );
    assert(!(await libcal.call("book_study_room", args)).isError);
    assert.equal(submitted, 1);
    assert.equal(
      code(
        await libcal.call("book_study_room", {
          ...args,
          bookingRequestId: randomUUID(),
        }),
      ),
      "ROOM_REQUEST_CONFLICT",
    );
    assert.equal(
      code(
        await libcal.call("book_study_room", { ...args, startTime: "14:00" }),
      ),
      "ROOM_REQUEST_CONFLICT",
    );
    const disk = await readFile(
      path.join(config.stateDir, "libcal/bookings.encrypted.json"),
      "utf8",
    );
    assert(!disk.includes("fixture-private"));
    assert(!disk.includes(room.name));
    const receipt = JSON.parse(first.content[0].text);
    assert(
      !(
        await libcal.call("cancel_study_room_booking", {
          bookingId: receipt.bookingId,
        })
      ).isError,
    );
  }));
test("unknown submissions survive restart and never trigger an automatic duplicate", () =>
  fixture(async (config) => {
    let submitted = 0;
    const driver = {
      book: async (a, before) => {
        await before();
        submitted++;
        throw new Error("private upstream response");
      },
    };
    const libcal = new LibCal(config, { catalog, driver });
    assert.equal(
      code(await libcal.call("book_study_room", args)),
      "ROOM_BOOKING_UNKNOWN",
    );
    const restarted = new LibCal(config, { catalog, driver });
    assert.equal(
      code(await restarted.call("book_study_room", args)),
      "ROOM_BOOKING_UNKNOWN",
    );
    assert.equal(
      code(
        await restarted.call("book_study_room", {
          ...args,
          bookingRequestId: randomUUID(),
        }),
      ),
      "ROOM_REQUEST_CONFLICT",
    );
    assert.equal(submitted, 1);
    const history = await restarted.call("get_study_room_bookings", {});
    assert(!JSON.stringify(history).includes("private upstream"));
  }));
test("changed availability fails before a submission and corrupted history fails closed", () =>
  fixture(async (config) => {
    let submitted = 0;
    const unavailable = {
      ...catalog,
      prepare: async () => {
        throw new RoomError("ROOM_UNAVAILABLE");
      },
    };
    const libcal = new LibCal(config, {
      catalog: unavailable,
      driver: {
        book: async () => {
          submitted++;
        },
      },
    });
    assert.equal(
      code(await libcal.call("book_study_room", args)),
      "ROOM_UNAVAILABLE",
    );
    assert.equal(submitted, 0);
    const store = new BookingStore(config);
    await mkdir(store.dir, { recursive: true });
    await writeFile(store.file, "corrupt");
    await assert.rejects(store.load(), /ROOM_STATE_INVALID/);
  }));
