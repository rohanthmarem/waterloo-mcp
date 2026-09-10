import { z } from "zod";

export const LIBCAL_ORIGIN = "https://libcal.uwaterloo.ca";
export const ROOM_TIMEZONE = "America/Toronto";
export const LIBRARIES = {
  davis: { name: "Davis Centre Library", slug: "dclibrary" },
  porter: { name: "Dana Porter Library", slug: "dplibrary" },
  musagetes: { name: "Musagetes Architecture Library", slug: "musagetes" },
};
export class RoomError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const fail = (code) => {
  throw new RoomError(code);
};
export const roomSchemas = {
  list_study_rooms: z
    .object({
      library: z.enum(["davis", "porter", "musagetes"]).optional(),
      minCapacity: z.number().int().min(1).max(30).optional(),
    })
    .strict(),
  get_study_room_availability: z
    .object({
      library: z.enum(["davis", "porter", "musagetes"]).optional(),
      roomId: z.number().int().positive().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      durationMinutes: z
        .number()
        .int()
        .min(15)
        .max(180)
        .multipleOf(15)
        .default(60),
      minCapacity: z.number().int().min(1).max(30).optional(),
    })
    .strict(),
  book_study_room: z
    .object({
      roomId: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      durationMinutes: z.number().int().min(15).max(180).multipleOf(15),
      partySize: z.number().int().min(1).max(30).default(1),
      bookingRequestId: z
        .string()
        .uuid()
        .describe(
          "Create a UUID for this booking attempt. Reuse it for retries; never change it after an uncertain result.",
        ),
    })
    .strict(),
  get_study_room_bookings: z.object({}).strict(),
  cancel_study_room_booking: z
    .object({ bookingId: z.string().uuid() })
    .strict(),
};
export function parseRoomArgs(name, args) {
  const parsed = roomSchemas[name]?.safeParse(args);
  if (!parsed?.success) fail("INPUT_INVALID");
  return parsed.data;
}
export function localNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ROOM_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:00`;
}
export function nextDate(date) {
  return new Date(Date.parse(date + "T00:00:00Z") + 86400000)
    .toISOString()
    .slice(0, 10);
}
export function validateRoomDate(date, now = new Date()) {
  const timestamp = Date.parse(date + "T00:00:00Z");
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== date
  )
    fail("INPUT_INVALID");
  const today = localNow(now).slice(0, 10);
  const last = new Date(Date.parse(today + "T00:00:00Z") + 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  if (date < today || date > last) fail("ROOM_POLICY_LIMIT");
}
export function bookingWindow(args, now = new Date()) {
  validateRoomDate(args.date, now);
  const [hour, minute] = args.startTime.split(":").map(Number);
  if (hour > 23 || minute > 59 || minute % 15 !== 0) fail("INPUT_INVALID");
  const end = hour * 60 + minute + args.durationMinutes;
  if (end > 1440) fail("ROOM_POLICY_LIMIT");
  const start = args.date + " " + args.startTime + ":00";
  if (start <= localNow(now)) fail("ROOM_POLICY_LIMIT");
  return {
    start,
    end:
      (end === 1440 ? nextDate(args.date) : args.date) +
      " " +
      String(Math.floor(end / 60) % 24).padStart(2, "0") +
      ":" +
      String(end % 60).padStart(2, "0") +
      ":00",
  };
}
export function formEncode(data) {
  const form = new URLSearchParams();
  const add = (key, value) => {
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) add(key + "[" + k + "]", v);
    } else if (value !== undefined && value !== null)
      form.append(key, String(value));
  };
  for (const [k, v] of Object.entries(data)) add(k, v);
  return form.toString();
}
export function parseRooms(html, library) {
  const locationId = Number(html.match(/\blocationId:\s*(\d+)/)?.[1]);
  const method = Number(html.match(/\bbookingMethod:\s*(\d+)/)?.[1]);
  if (!locationId || method !== 11) fail("ROOM_PAGE_CHANGED");
  const rooms = [];
  for (const match of html.matchAll(/resources\.push\(\{([\s\S]*?)\}\);/g)) {
    const text = match[1];
    const int = (key) =>
      Number(text.match(new RegExp("\\b" + key + ":\\s*(\\d+)"))?.[1]);
    const raw = text.match(/\btitle:\s*'((?:\\.|[^'\\])*)'/)?.[1];
    if (!raw) fail("ROOM_PAGE_CHANGED");
    let title;
    try {
      title = JSON.parse(
        '"' + raw.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"',
      );
    } catch {
      fail("ROOM_PAGE_CHANGED");
    }
    const roomId = int("seatId"),
      eid = int("eid"),
      gid = int("gid"),
      lid = int("lid");
    if (!roomId || !eid || !gid || lid !== locationId)
      fail("ROOM_PAGE_CHANGED");
    rooms.push({
      roomId,
      name: title,
      library,
      libraryName: LIBRARIES[library].name,
      capacity: Number(title.match(/Max\s+(\d+)/i)?.[1]) || null,
      url: LIBCAL_ORIGIN + "/seat/" + roomId,
      eid,
      gid,
      lid,
      method,
    });
  }
  if (!rooms.length) fail("ROOM_PAGE_CHANGED");
  return rooms;
}
export const publicRoom = ({ eid, gid, lid, method, ...room }) => room;
export function availableWindows(slots, roomId, minutes, now = new Date()) {
  const result = [];
  const present = localNow(now);
  let window;
  for (const slot of slots
    .filter((s) => s.itemId === roomId)
    .sort((a, b) => a.start.localeCompare(b.start))) {
    if (slot.className || slot.start <= present) {
      window = undefined;
      continue;
    }
    if (window && window.end === slot.start) window.end = slot.end;
    else {
      window = { start: slot.start, end: slot.end };
      result.push(window);
    }
  }
  return result.filter(
    (w) =>
      (Date.parse(w.end.replace(" ", "T") + "Z") -
        Date.parse(w.start.replace(" ", "T") + "Z")) /
        60000 >=
      minutes,
  );
}
export function assertAvailable(slots, roomId, start, end) {
  const room = slots
    .filter((s) => s.itemId === roomId)
    .sort((a, b) => a.start.localeCompare(b.start));
  let cursor = start;
  for (const s of room) {
    if (s.start < cursor) continue;
    if (s.start !== cursor || s.className) break;
    cursor = s.end;
    if (cursor === end) return;
    if (cursor > end) break;
  }
  fail("ROOM_UNAVAILABLE");
}
export function validateGrid(data, date) {
  if (
    !Array.isArray(data?.slots) ||
    data.isPreCreatedBooking ||
    data.slots.length > 10000
  )
    fail("ROOM_PAGE_CHANGED");
  for (const s of data.slots)
    if (
      !Number.isInteger(s.itemId) ||
      !new RegExp("^" + date + " \\d{2}:\\d{2}:00$").test(s.start) ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(s.end) ||
      typeof s.checksum !== "string"
    )
      fail("ROOM_PAGE_CHANGED");
  return data.slots;
}
export class RoomCatalog {
  constructor({ fetchImpl = fetch, now = () => new Date() } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }
  async request(route, data) {
    let response;
    try {
      response = await this.fetchImpl(LIBCAL_ORIGIN + route, {
        method: data ? "POST" : "GET",
        headers: {
          Referer: LIBCAL_ORIGIN + "/",
          ...(data
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(data ? { body: formEncode(data) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      fail("UPSTREAM_UNAVAILABLE");
    }
    if (response.status === 429) fail("UPSTREAM_RATE_LIMITED");
    if (!response.ok) fail("UPSTREAM_UNAVAILABLE");
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) fail("ROOM_PAGE_CHANGED");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!data) return text;
    try {
      return JSON.parse(text);
    } catch {
      fail("ROOM_PAGE_CHANGED");
    }
  }
  async rooms() {
    if (this.cached && this.expires > Date.now()) return this.cached;
    this.pending ??= (async () => {
      // The three library pages are independent public reads; fetch them together.
      const pages = await Promise.all(
        Object.keys(LIBRARIES).map(async (library) => [
          library,
          await this.request("/reserve/spaces/" + LIBRARIES[library].slug),
        ]),
      );
      const rooms = pages.flatMap(([library, html]) =>
        parseRooms(html, library),
      );
      this.cached = rooms;
      this.expires = Date.now() + 300000;
      return rooms;
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async find(roomId) {
    const room = (await this.rooms()).find((r) => r.roomId === roomId);
    if (!room) fail("ROOM_NOT_FOUND");
    return room;
  }
  async grid(room, date, post) {
    validateRoomDate(date, this.now());
    const data = {
      lid: room.lid,
      gid: 0,
      eid: -1,
      seat: 1,
      seatId: 0,
      zone: 0,
      start: date,
      end: nextDate(date),
      pageIndex: 0,
      pageSize: 100,
    };
    return validateGrid(
      await (post ?? this.request.bind(this))(
        "/spaces/availability/grid",
        data,
      ),
      date,
    );
  }
  async availability(args) {
    validateRoomDate(args.date, this.now());
    let rooms = (await this.rooms()).filter(
      (r) =>
        (!args.library || r.library === args.library) &&
        (!args.roomId || r.roomId === args.roomId) &&
        (!args.minCapacity || r.capacity >= args.minCapacity),
    );
    if (args.roomId && !rooms.length) fail("ROOM_NOT_FOUND");
    // One availability grid per library, read together rather than in turn.
    const byLibrary = new Map();
    for (const room of rooms)
      if (!byLibrary.has(room.lid)) byLibrary.set(room.lid, room);
    const grids = new Map(
      await Promise.all(
        [...byLibrary].map(async ([lid, room]) => [
          lid,
          await this.grid(room, args.date),
        ]),
      ),
    );
    return {
      timezone: ROOM_TIMEZONE,
      date: args.date,
      durationMinutes: args.durationMinutes,
      retrievedAt: this.now().toISOString(),
      rooms: rooms.map((room) => ({
        ...publicRoom(room),
        availableWindows: availableWindows(
          grids.get(room.lid),
          room.roomId,
          args.durationMinutes,
          this.now(),
        ),
      })),
      note: "Times use America/Toronto. Start on a 15-minute interval within a window. Availability is checked again after approval; no room is held by this read.",
    };
  }
  async prepare(args) {
    const room = await this.find(args.roomId);
    const window = bookingWindow(args, this.now());
    if (room.capacity && args.partySize > room.capacity)
      fail("ROOM_POLICY_LIMIT");
    assertAvailable(
      await this.grid(room, args.date),
      room.roomId,
      window.start,
      window.end,
    );
    return {
      ...publicRoom(room),
      ...window,
      partySize: args.partySize,
      timezone: ROOM_TIMEZONE,
      termsUrl: "https://uwaterloo.ca/lib/services/study-rooms",
      notice:
        "Creates one booking and may send its confirmation email. Approval accepts the library study-room terms. Checkout places a temporary hold only after approval.",
    };
  }
}
