import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decrypt } from "../upstream/build/auth/encrypted-store.js";
import {
  LIBCAL_ORIGIN,
  LIBRARIES,
  RoomError,
  fail,
  formEncode,
  bookingWindow,
  assertAvailable,
  nextDate,
} from "./libcal.mjs";

const errorFromText = (text) =>
  /limit|maximum|three bookings|too many/i.test(text)
    ? "ROOM_POLICY_LIMIT"
    : /unavailable|taken|no longer|conflict/i.test(text)
      ? "ROOM_UNAVAILABLE"
      : "ROOM_PAGE_CHANGED";
export function trustedCancelUrl(value) {
  try {
    const u = new URL(value, LIBCAL_ORIGIN);
    return u.origin === LIBCAL_ORIGIN &&
      !u.username &&
      !u.password &&
      /^\/(spaces|equipment|booking)\/.+/.test(u.pathname) &&
      /cancel/i.test(u.pathname)
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export class LibCalBrowser {
  constructor(
    config,
    catalog,
    { launch = () => chromium.launch({ headless: true }) } = {},
  ) {
    this.launch = launch;
    this.config = config;
    this.catalog = catalog;
  }
  async context(browser) {
    let key;
    try {
      key = Buffer.from(
        (
          await readFile(
            path.join(this.config.secretsDir, "session-key"),
            "utf8",
          )
        ).trim(),
        "hex",
      );
      const storageState = JSON.parse(
        decrypt(
          JSON.parse(
            await readFile(
              path.join(this.config.stateDir, "browser.json"),
              "utf8",
            ),
          ),
          key,
          "waterloo-browser:v1",
        ),
      );
      return await browser.newContext({ storageState });
    } catch {
      fail("ROOM_AUTH_REQUIRED");
    } finally {
      key?.fill(0);
    }
  }
  async book(args, beforeSubmit, saveReceipt = async () => {}) {
    const room = await this.catalog.find(args.roomId);
    const window = bookingWindow(args, this.catalog.now());
    const browser = await this.launch();
    let context,
      page,
      sessionId,
      stage = "browser-context",
      submitted = false;
    try {
      context = await this.context(browser);
      page = await context.newPage();
      const post = async (route, data) => {
        const r = await context.request.post(LIBCAL_ORIGIN + route, {
          timeout: 25000,
          maxRedirects: 0,
          headers: {
            Referer:
              LIBCAL_ORIGIN + "/reserve/spaces/" + LIBRARIES[room.library].slug,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          data: formEncode(data),
        });
        if (r.status() === 429) fail("UPSTREAM_RATE_LIMITED");
        if (!r.ok()) fail("UPSTREAM_UNAVAILABLE");
        let value;
        try {
          value = await r.json();
        } catch {
          fail("ROOM_PAGE_CHANGED");
        }
        if (value.error) fail(errorFromText(String(value.error)));
        return value;
      };
      stage = "room-page";
      await context.request.get(room.url, { timeout: 25000 });
      stage = "availability";
      const slots = await this.catalog.grid(room, args.date, post);
      assertAvailable(slots, room.roomId, window.start, window.end);
      const slot = slots.find(
        (s) => s.itemId === room.roomId && s.start === window.start,
      );
      const scope = {
        lid: room.lid,
        gid: 0,
        start: args.date,
        end: nextDate(args.date),
      };
      stage = "booking-draft";
      const draft = await post("/spaces/availability/booking/add", {
        ...scope,
        add: {
          eid: room.eid,
          seat_id: room.roomId,
          gid: room.gid,
          lid: room.lid,
          start: window.start,
          checksum: slot.checksum,
        },
      });
      if (draft.limitIssues) fail("ROOM_POLICY_LIMIT");
      let booking = draft.bookings?.[0];
      if (
        draft.bookings?.length !== 1 ||
        booking.seat_id !== room.roomId ||
        booking.start !== window.start
      )
        fail("ROOM_PAGE_CHANGED");
      const desired = booking.options?.indexOf(window.end);
      if (
        desired === undefined ||
        desired < 0 ||
        !booking.optionChecksums?.[desired]
      )
        fail("ROOM_UNAVAILABLE");
      const payload = (b) =>
        Object.fromEntries(
          [
            "id",
            "eid",
            "seat_id",
            "gid",
            "lid",
            "start",
            "end",
            "checksum",
          ].map((k) => [k, b[k]]),
        );
      if (booking.end !== window.end) {
        stage = "booking-end-time";
        const updated = await post("/spaces/availability/booking/add", {
          ...scope,
          bookings: [payload(booking)],
          update: {
            id: booking.id,
            checksum: booking.optionChecksums[desired],
            end: window.end,
          },
        });
        if (updated.bookings?.length !== 1) fail("ROOM_PAGE_CHANGED");
        booking = updated.bookings[0];
      }
      if (
        booking.seat_id !== room.roomId ||
        booking.start !== window.start ||
        booking.end !== window.end ||
        Number(booking.cost) !== 0
      )
        fail("ROOM_PAGE_CHANGED");
      // This request creates a temporary checkout hold. The gateway must approve first.
      stage = "checkout-hold";
      const checkout = await post("/ajax/space/times", {
        method: room.method,
        returnUrl: room.url,
        bookings: [payload(booking)],
      });
      if (typeof checkout.redirect !== "string") fail("ROOM_PAGE_CHANGED");
      const target = new URL(checkout.redirect, LIBCAL_ORIGIN);
      if (target.origin !== LIBCAL_ORIGIN || target.pathname !== "/spaces/auth")
        fail("ROOM_PAGE_CHANGED");
      stage = "sign-in";
      await page.goto(target.href, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page
        .waitForLoadState("networkidle", { timeout: 10000 })
        .catch(() => {});
      if (new URL(page.url()).origin !== LIBCAL_ORIGIN)
        fail("ROOM_AUTH_REQUIRED");
      stage = "checkout-form";
      const html = await page.content();
      sessionId = html.match(/sessionId:\s*(\d+)/)?.[1];
      const form = page.locator("#s-lc-eq-bform");
      if (
        (await form.count()) !== 1 ||
        new URL(await form.getAttribute("action"), LIBCAL_ORIGIN).pathname !==
          "/ajax/equipment/checkout"
      )
        fail("ROOM_PAGE_CHANGED");
      stage = "account-check";
      const email = (
        await page.locator(".s-lc-eq-email .form-control-static").innerText()
      )
        .trim()
        .toLowerCase();
      if (email !== this.config.username.toLowerCase())
        fail("ROOM_AUTH_REQUIRED");
      stage = "room-check";
      const rows = page.locator("#s-lc-eq-co-itemlist tbody tr");
      if (
        (await rows.count()) !== 1 ||
        !(await rows.innerText()).includes(room.name)
      )
        fail("ROOM_PAGE_CHANGED");
      // Recheck displayed local times as well as the server's signed draft payload.
      const displayed = await rows.locator("td").allTextContents();
      for (const value of [window.start, window.end]) {
        const hour = Number(value.slice(11, 13));
        const minute = value.slice(14, 16);
        const time =
          String(hour % 12 || 12) + ":" + minute + (hour >= 12 ? "pm" : "am");
        const dateText = new Intl.DateTimeFormat("en-US", {
          timeZone: "UTC",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }).format(new Date(value.slice(0, 10) + "T12:00:00Z"));
        if (!displayed.some((x) => x.includes(time) && x.includes(dateText)))
          fail("ROOM_PAGE_CHANGED");
      }
      stage = "terms-form";
      await page.locator("#terms_accept").click();
      const checks = form.locator("input[type=checkbox]");
      if (
        (await checks.count()) !== 1 ||
        !(
          await checks.locator("xpath=ancestor::fieldset[1]").innerText()
        ).includes("Terms & Conditions")
      )
        fail("ROOM_PAGE_CHANGED");
      await checks.check();
      // A new question or required field requires a reviewed implementation change.
      const unknown = await form
        .locator("input,select,textarea")
        .evaluateAll((es) =>
          es.some(
            (e) =>
              e.type !== "hidden" &&
              e.type !== "checkbox" &&
              !["submit", "button"].includes(e.type),
          ),
        );
      if (unknown) fail("ROOM_PAGE_CHANGED");
      stage = "submit";
      await beforeSubmit();
      submitted = true;
      const responsePromise = page.waitForResponse(
        (r) =>
          new URL(r.url()).origin === LIBCAL_ORIGIN &&
          new URL(r.url()).pathname === "/ajax/equipment/checkout" &&
          r.request().method() === "POST",
        { timeout: 45000 },
      );
      await page.locator("#btn-form-submit").click();
      const response = await responsePromise;
      await saveReceipt({
        httpStatus: response.status(),
        html: (await response.text()).slice(0, 524288),
        receivedAt: new Date().toISOString(),
      });
      if (!response.ok()) fail("ROOM_BOOKING_UNKNOWN");
      const status = await page
        .locator(".s-lc-eq-booking-status-msg")
        .innerText({ timeout: 10000 })
        .catch(() => null);
      if (
        !status ||
        !/confirmed|successfully\s+booked|booking\s+complete/i.test(status) ||
        /not\s+confirmed|failed|error/i.test(status)
      )
        fail("ROOM_BOOKING_UNKNOWN");
      const links = await page
        .locator("#s-lc-public-page-content a[href]")
        .evaluateAll((as) => as.map((a) => a.href));
      const cancellationUrl = links.map(trustedCancelUrl).find(Boolean) ?? null;
      return {
        status: "confirmed",
        cancellationUrl,
        confirmedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (!submitted) {
        await saveReceipt({
          kind: "diagnostic",
          stage,
          errorName: error.name,
          message: String(error.message).slice(0, 4096),
          html: page
            ? (await page.content().catch(() => "")).slice(0, 524288)
            : "",
          receivedAt: new Date().toISOString(),
        }).catch(() => {});
      }
      const code = submitted
        ? "ROOM_BOOKING_UNKNOWN"
        : error instanceof RoomError
          ? error.code
          : [
                "checkout-form",
                "account-check",
                "room-check",
                "terms-form",
              ].includes(stage)
            ? "ROOM_PAGE_CHANGED"
            : "UPSTREAM_UNAVAILABLE";
      const failure = new RoomError(code);
      failure.stage = stage;
      throw failure;
    } finally {
      if (!submitted && context && sessionId) {
        await context.request
          .post(LIBCAL_ORIGIN + "/ajax/equipment/cart/remove", {
            timeout: 10000,
            headers: {
              Referer: LIBCAL_ORIGIN + "/spaces/auth",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            data: formEncode({ eid: 0, id: 0, session: sessionId }),
          })
          .catch(() => {});
      }
      await browser.close();
    }
  }
  async cancel(record, beforeSubmit) {
    const url = trustedCancelUrl(record.cancellationUrl);
    if (!url) fail("ROOM_CANCEL_UNAVAILABLE");
    const browser = await this.launch();
    let submitted = false;
    try {
      const context = await this.context(browser);
      const page = await context.newPage();
      // Some receipt cancellation links act on GET. Approval and journaling precede navigation.
      await beforeSubmit();
      submitted = true;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (new URL(page.url()).origin !== LIBCAL_ORIGIN)
        fail("ROOM_BOOKING_UNKNOWN");
      let text = await page.locator("main").innerText();
      if (!/has been cancel[le]+d|successfully cancel[le]+d/i.test(text)) {
        const button = page.getByRole("button", {
          name: /^(cancel (my |this )?(booking|reservation)|confirm cancellation)$/i,
        });
        if ((await button.count()) !== 1) fail("ROOM_BOOKING_UNKNOWN");
        await button.click();
        await page
          .waitForLoadState("networkidle", { timeout: 10000 })
          .catch(() => {});
        text = await page.locator("main").innerText();
      }
      if (!/has been cancel[le]+d|successfully cancel[le]+d/i.test(text))
        fail("ROOM_BOOKING_UNKNOWN");
      return { status: "cancelled", cancelledAt: new Date().toISOString() };
    } catch (error) {
      if (submitted) fail("ROOM_BOOKING_UNKNOWN");
      if (error instanceof RoomError) throw error;
      fail("UPSTREAM_UNAVAILABLE");
    } finally {
      await browser.close();
    }
  }
}
