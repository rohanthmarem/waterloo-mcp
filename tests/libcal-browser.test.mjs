import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { encrypt } from "../upstream/build/auth/encrypted-store.js";
import { LibCalBrowser } from "../src/libcal-browser.mjs";
const enabled = process.env.WATERLOO_TEST_BROWSER === "1";
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
  name: "Room Test",
  library: "davis",
  method: 11,
  url: "https://libcal.uwaterloo.ca/seat/10",
};
const base = "https://libcal.uwaterloo.ca";
const draft = {
  id: 1,
  eid: 20,
  seat_id: 10,
  gid: 30,
  lid: 40,
  start: "2026-09-10 13:00:00",
  end: "2026-09-10 14:00:00",
  cost: 0,
  checksum: "fixture",
  options: ["2026-09-10 14:00:00"],
  optionChecksums: ["fixture"],
};
const slots = Array.from({ length: 4 }, (_, i) => ({
  itemId: 10,
  start: `2026-09-10 13:${String(i * 15).padStart(2, "0")}:00`,
  end:
    i === 3
      ? "2026-09-10 14:00:00"
      : `2026-09-10 13:${String((i + 1) * 15).padStart(2, "0")}:00`,
  checksum: "fixture",
}));
const catalog = {
  now: () => new Date("2026-09-09T16:00:00Z"),
  find: async () => room,
  grid: async () => slots,
};
for (const scenario of [
  "confirmed",
  "unknown outcome",
  "new required question",
])
  test("real Chromium checkout: " + scenario, { skip: !enabled }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "waterloo-room-browser-"));
    const secretsDir = path.join(dir, "secrets");
    await mkdir(secretsDir);
    const key = randomBytes(32);
    await writeFile(path.join(secretsDir, "session-key"), key.toString("hex"));
    await writeFile(
      path.join(dir, "browser.json"),
      JSON.stringify(
        encrypt(
          JSON.stringify({ cookies: [], origins: [] }),
          key,
          "waterloo-browser:v1",
        ),
      ),
    );
    let submissions = 0,
      recorded = 0,
      cleaned = 0;
    const pageHtml = `<main><div id="s-lc-public-page-content"><div id="s-lc-eq-co-itemlist"><table><tbody><tr><td>Room Test</td><td>1:00pm Thursday, September 10, 2026</td><td>2:00pm Thursday, September 10, 2026</td></tr></tbody></table></div><button id="terms_accept" onclick="document.querySelector('form').style.display='block'">Continue</button><form id="s-lc-eq-bform" action="/ajax/equipment/checkout" style="display:none"><fieldset><legend>Booking Form</legend><div class="s-lc-eq-email"><p class="form-control-static">student@uwaterloo.ca</p></div><fieldset><legend>I acknowledge the Terms &amp; Conditions</legend><label><input type="checkbox" name="q1[]" value="Yes">Yes</label></fieldset>${scenario === "new required question" ? '<input name="unexpected" required>' : ""}<button type="submit" id="btn-form-submit">Submit my Booking</button></fieldset></form></div></main><script>var springyPage={sessionId:123};document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/ajax/equipment/checkout',{method:'POST'});document.querySelector('#s-lc-public-page-content').innerHTML=await r.text();};</script>`;
    const driver = new LibCalBrowser(
      { username: "student@uwaterloo.ca", stateDir: dir, secretsDir },
      catalog,
      {
        launch: async () => {
          const browser = await chromium.launch({ headless: true });
          const createContext = browser.newContext.bind(browser);
          browser.newContext = async (options) => {
            const context = await createContext(options);
            context.request.get = async () => ({ ok: () => true });
            context.request.post = async (url, options) => {
              const route = new URL(url).pathname;
              let data;
              if (route === "/spaces/availability/booking/add")
                data = { bookings: [draft] };
              else if (route === "/ajax/space/times")
                data = { redirect: "/spaces/auth" };
              else if (route === "/ajax/equipment/cart/remove") {
                cleaned++;
                data = { count: 0 };
              } else throw Error("Unplanned fixture request");
              return {
                ok: () => true,
                status: () => 200,
                json: async () => data,
              };
            };
            await context.route("**/*", async (route) => {
              const url = new URL(route.request().url());
              assert.equal(url.origin, base);
              if (url.pathname === "/spaces/auth")
                await route.fulfill({
                  contentType: "text/html",
                  body: pageHtml,
                });
              else if (url.pathname === "/ajax/equipment/checkout") {
                assert.equal(recorded, 1);
                submissions++;
                await route.fulfill({
                  contentType: "text/html",
                  body:
                    scenario === "unknown outcome"
                      ? "<p>Response interrupted</p>"
                      : '<p class="s-lc-eq-booking-status-msg">Your booking is confirmed.</p><a href="/equipment/cancel?code=fixture">Cancel Booking</a>',
                });
              } else await route.abort();
            });
            return context;
          };
          return browser;
        },
      },
    );
    try {
      if (scenario === "confirmed") {
        const result = await driver.book(args, async () => {
          recorded++;
        });
        assert.equal(result.status, "confirmed");
        assert.equal(submissions, 1);
        assert(result.cancellationUrl.endsWith("code=fixture"));
      } else {
        await assert.rejects(
          driver.book(args, async () => {
            recorded++;
          }),
          new RegExp(
            scenario === "unknown outcome"
              ? "ROOM_BOOKING_UNKNOWN"
              : "ROOM_PAGE_CHANGED",
          ),
        );
        assert.equal(submissions, scenario === "unknown outcome" ? 1 : 0);
        assert.equal(cleaned, scenario === "new required question" ? 1 : 0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
