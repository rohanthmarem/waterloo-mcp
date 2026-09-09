import { z } from "zod";
import { readFile, writeFile, rename, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { encrypt, decrypt } from "./upstream/build/auth/encrypted-store.js";
import {
  RoomCatalog,
  roomSchemas,
  parseRoomArgs,
  publicRoom,
  RoomError,
  fail,
} from "./src/libcal.mjs";
import { LibCalBrowser } from "./src/libcal-browser.mjs";
import { toolError } from "./src/errors.mjs";
const descriptions = {
  list_study_rooms:
    "List Waterloo study rooms at Davis Centre, Dana Porter, and Musagetes with room IDs, capacity, library, and links. Public read; no login or temporary room hold.",
  get_study_room_availability:
    "Read available study-room time windows for one date. Times use America/Toronto. No temporary hold or booking is created. Rooms can be booked up to one week ahead, for 15–180 minutes in 15-minute steps.",
  book_study_room:
    "Book one study room for the exact date, start time, duration, and party size after owner approval. The approval includes the library terms and possible confirmation email. Use a new UUID bookingRequestId and reuse it for retries. Never create a new ID after an uncertain outcome; inspect get_study_room_bookings first. Availability is rechecked after approval. A temporary checkout hold starts only after approval.",
  get_study_room_bookings:
    "Read this MCP instance’s encrypted booking history, including confirmed, cancelled, and uncertain operations. It does not list bookings made manually or through other tools, and status reflects the last observed result, not a fresh library query.",
  cancel_study_room_booking:
    "Cancel a booking created through this MCP, after exact owner approval. Only a stored cancellation link from the library confirmation can be used. If the library did not provide a link, use the owner’s confirmation email manually. Never retries an uncertain cancellation automatically.",
};
export const ROOM_WRITE_TOOLS = new Set([
  "book_study_room",
  "cancel_study_room_booking",
]);
export const roomTools = Object.entries(roomSchemas).map(([name, schema]) => ({
  name,
  description: descriptions[name],
  inputSchema: z.toJSONSchema(schema),
  annotations: {
    readOnlyHint: !ROOM_WRITE_TOOLS.has(name),
    destructiveHint: ROOM_WRITE_TOOLS.has(name),
  },
}));
const response = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});
const signature = (args) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(args)
            .filter(([key]) => key !== "bookingRequestId")
            .sort(),
        ),
      ),
    )
    .digest("hex");
const publicRecord = (record) => ({
  bookingId: record.bookingId,
  bookingRequestId: record.bookingRequestId,
  details: record.details,
  status: record.status,
  updatedAt: record.updatedAt,
  cancellationAvailable:
    !!record.cancellationUrl && record.status === "confirmed",
  ...(record.errorCode ? { errorCode: record.errorCode } : {}),
});
export class BookingStore {
  constructor(config) {
    this.config = config;
    this.dir = path.join(config.stateDir, "libcal");
    this.file = path.join(this.dir, "bookings.encrypted.json");
  }
  async key() {
    try {
      const text = (
        await readFile(path.join(this.config.secretsDir, "session-key"), "utf8")
      ).trim();
      if (!/^[a-f0-9]{64}$/i.test(text)) fail("CONFIG_INVALID");
      return Buffer.from(text, "hex");
    } catch {
      fail("CONFIG_INVALID");
    }
  }
  async load() {
    let key;
    try {
      const text = await readFile(this.file, "utf8");
      key = await this.key();
      const records = JSON.parse(
        decrypt(JSON.parse(text), key, "waterloo-libcal-bookings:v1"),
      );
      if (!Array.isArray(records)) fail("ROOM_STATE_INVALID");
      return records;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      fail("ROOM_STATE_INVALID");
    } finally {
      key?.fill(0);
    }
  }
  async save(records) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const key = await this.key();
    try {
      await writeFile(
        this.file + ".pending",
        JSON.stringify(
          encrypt(JSON.stringify(records), key, "waterloo-libcal-bookings:v1"),
        ),
        { mode: 0o600 },
      );
      await rename(this.file + ".pending", this.file);
    } finally {
      key.fill(0);
    }
  }
  async locked(run) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.dir, "write.lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      fail("SERVICE_BUSY");
    }
    try {
      return await run(await this.load());
    } finally {
      await rmdir(lock);
    }
  }
}
export class LibCal {
  constructor(
    config,
    {
      catalog = new RoomCatalog(),
      driver,
      store = new BookingStore(config),
    } = {},
  ) {
    this.catalog = catalog;
    this.driver = driver ?? new LibCalBrowser(config, catalog);
    this.store = store;
  }
  async preview(name, raw) {
    const args = parseRoomArgs(name, raw);
    if (name === "book_study_room") return this.catalog.prepare(args);
    if (name === "cancel_study_room_booking") {
      const record = (await this.store.load()).find(
        (r) => r.bookingId === args.bookingId,
      );
      if (!record) fail("ROOM_BOOKING_NOT_FOUND");
      if (record.status !== "confirmed" || !record.cancellationUrl)
        fail("ROOM_CANCEL_UNAVAILABLE");
      return {
        ...record.details,
        action: "Cancel this booking",
        bookingId: record.bookingId,
        notice:
          "Cancels this reservation and may send a library confirmation email.",
      };
    }
  }
  async book(args) {
    return this.store.locked(async (records) => {
      const hash = signature(args);
      let record = records.find(
        (r) => r.bookingRequestId === args.bookingRequestId,
      );
      if (record) {
        if (record.signature !== hash) fail("ROOM_REQUEST_CONFLICT");
        if (record.status === "confirmed") return publicRecord(record);
        if (["submitting", "unknown", "cancelling"].includes(record.status))
          fail("ROOM_BOOKING_UNKNOWN");
        if (record.status === "cancelled") fail("ROOM_REQUEST_CONFLICT");
      }
      if (
        records.some(
          (r) =>
            r.signature === hash &&
            ["confirmed", "submitting", "unknown", "cancelling"].includes(
              r.status,
            ),
        )
      )
        fail("ROOM_REQUEST_CONFLICT");
      const details = await this.catalog.prepare(args);
      record ??= {
        bookingId: randomUUID(),
        bookingRequestId: args.bookingRequestId,
        signature: hash,
        details,
      };
      if (!records.includes(record)) records.push(record);
      record.status = "preparing";
      record.updatedAt = new Date().toISOString();
      await this.store.save(records);
      let submitted = false;
      try {
        const result = await this.driver.book(
          args,
          async () => {
            record.status = "submitting";
            record.updatedAt = new Date().toISOString();
            await this.store.save(records);
            submitted = true;
          },
          async (receipt) => {
            // Keep the response encrypted for owner recovery after an uncertain result.
            // publicRecord deliberately excludes receipt HTML and cancellation links.
            record.receipt = receipt;
            await this.store.save(records);
          },
        );
        if (result?.status !== "confirmed") fail("ROOM_BOOKING_UNKNOWN");
        Object.assign(record, result, {
          updatedAt: new Date().toISOString(),
          errorCode: undefined,
        });
        await this.store.save(records);
        return publicRecord(record);
      } catch (error) {
        record.status = submitted ? "unknown" : "failed";
        record.errorCode = submitted
          ? "ROOM_BOOKING_UNKNOWN"
          : (error.code ?? "UPSTREAM_UNAVAILABLE");
        record.updatedAt = new Date().toISOString();
        await this.store.save(records);
        if (submitted) fail("ROOM_BOOKING_UNKNOWN");
        throw error;
      }
    });
  }
  async cancel(args) {
    return this.store.locked(async (records) => {
      const record = records.find((r) => r.bookingId === args.bookingId);
      if (!record) fail("ROOM_BOOKING_NOT_FOUND");
      if (record.status === "cancelled") return publicRecord(record);
      if (["unknown", "cancelling", "submitting"].includes(record.status))
        fail("ROOM_BOOKING_UNKNOWN");
      if (record.status !== "confirmed" || !record.cancellationUrl)
        fail("ROOM_CANCEL_UNAVAILABLE");
      let submitted = false;
      try {
        const result = await this.driver.cancel(record, async () => {
          record.status = "cancelling";
          record.updatedAt = new Date().toISOString();
          await this.store.save(records);
          submitted = true;
        });
        if (result?.status !== "cancelled") fail("ROOM_BOOKING_UNKNOWN");
        Object.assign(record, result, { updatedAt: new Date().toISOString() });
        await this.store.save(records);
        return publicRecord(record);
      } catch (error) {
        if (submitted) {
          record.status = "unknown";
          record.errorCode = "ROOM_BOOKING_UNKNOWN";
          record.updatedAt = new Date().toISOString();
          await this.store.save(records);
          fail("ROOM_BOOKING_UNKNOWN");
        }
        throw error;
      }
    });
  }
  async call(name, raw) {
    try {
      const args = parseRoomArgs(name, raw);
      switch (name) {
        case "list_study_rooms":
          return response({
            rooms: (await this.catalog.rooms())
              .filter(
                (r) =>
                  (!args.library || r.library === args.library) &&
                  (!args.minCapacity || r.capacity >= args.minCapacity),
              )
              .map(publicRoom),
          });
        case "get_study_room_availability":
          return response(await this.catalog.availability(args));
        case "get_study_room_bookings":
          return response({
            scope: "Bookings created through this MCP instance only",
            liveLibraryStatus: false,
            bookings: (await this.store.load()).map(publicRecord),
          });
        case "book_study_room":
          return response(await this.book(args));
        case "cancel_study_room_booking":
          return response(await this.cancel(args));
        default:
          return toolError("TOOL_UNSUPPORTED");
      }
    } catch (error) {
      return toolError(
        error instanceof RoomError ? error.code : "UPSTREAM_UNAVAILABLE",
        error instanceof RoomError && error.stage ? { stage: error.stage } : {},
      );
    }
  }
}
