import test from "node:test";
import assert from "node:assert/strict";
import { SessionHttp, SessionExpired } from "../src/session-http.mjs";
import { htmlSnapshot, htmlText, documentFromHtml } from "../src/html.mjs";
import { parseSchedule } from "../src/odyssey.mjs";
function fixture() {
  let version = "one",
    failLoad = false,
    login = 0,
    disposed = 0,
    responseDisposed = 0,
    requests = 0,
    mode = "normal",
    time = 0;
  const installed = [];
  const saved = {
    cookies: [
      { name: "mine", value: "private", domain: "school.test" },
      { name: "other", value: "private", domain: "other.test" },
    ],
  };
  const service = new SessionHttp(
    {},
    {
      origin: "https://school.test",
      allowed: (u) => u.pathname === "/read",
      authenticated: (html) => html.includes("signed in"),
      now: () => time,
      idleMs: 100000,
      maxAgeMs: 100,
      load: async () => {
        if (failLoad) throw new SessionExpired();
        return { state: saved, version };
      },
      bootstrap: async () => {
        login++;
        return {
          ...saved,
          cookies: [
            ...saved.cookies,
            { name: "ready", domain: "school.test", value: "yes" },
          ],
        };
      },
      createContext: async (options) => {
        installed.push(options);
        return {
          dispose: async () => {
            disposed++;
          },
          get: async (url) => {
            requests++;
            const ready = options.storageState.cookies.some(
              (c) => c.name === "ready",
            );
            return {
              status: () => (mode === "redirect" || !ready ? 302 : 200),
              headers: () => ({
                "content-type": "text/html",
                location: "https://foreign.test/login",
              }),
              text: async () =>
                mode === "oversize"
                  ? "x".repeat(2000001)
                  : "signed in " + requests,
              dispose: async () => {
                responseDisposed++;
              },
            };
          },
        };
      },
    },
  );
  return {
    service,
    installed,
    get metrics() {
      return { login, disposed, responseDisposed, requests };
    },
    setVersion: (v) => (version = v),
    fail: () => (failLoad = true),
    mode: (v) => (mode = v),
    tick: (n) => (time = n),
  };
}
test("service cookies are isolated, reads are fresh, responses disposed, session rotation invalidates", async () => {
  const f = fixture();
  try {
    const first = await f.service.run((get) => get("/read"));
    const second = await f.service.run((get) => get("/read"));
    assert.notEqual(first.html, second.html);
    assert.equal(f.metrics.login, 1);
    assert.equal(
      f.installed.every((o) =>
        o.storageState.cookies.every((c) => c.domain === "school.test"),
      ),
      true,
    );
    assert.equal(f.metrics.responseDisposed, f.metrics.requests);
    f.setVersion("two");
    await f.service.run((get) => get("/read"));
    assert.equal(f.metrics.login, 2);
    f.tick(200);
    await f.service.run((get) => get("/read"));
    assert.equal(f.metrics.login, 3);
    f.fail();
    await assert.rejects(
      () => f.service.run((get) => get("/read")),
      SessionExpired,
    );
    assert.equal(f.service.context, undefined);
  } finally {
    await f.service.close();
  }
});
test("redirects cannot leak cookies; retries bounded; response limits enforced", async () => {
  const f = fixture();
  try {
    f.mode("redirect");
    await assert.rejects(
      () => f.service.run((get) => get("/read")),
      SessionExpired,
    );
    assert.equal(f.metrics.login, 1);
    assert.equal(f.metrics.requests, 2);
    f.mode("normal");
    await f.service.run((get) => get("/read"));
    f.mode("oversize");
    await assert.rejects(
      () => f.service.run((get) => get("/read")),
      /HTTP_RESPONSE_TOO_LARGE/,
    );
    assert.equal(f.metrics.responseDisposed, f.metrics.requests);
  } finally {
    await f.service.close();
  }
});
test("HTML parsing does not include scripts, forms, hidden fields; preformatted diagnostics preserved", () => {
  const r = htmlSnapshot(
    '<body><h1>Results</h1><script>secret</script><form><input value="credential"><span>private</span></form><div hidden>hidden</div><pre>  leading\n    indented\n\nend</pre><table><tr><td>A</td><td>B</td></tr></table></body>',
  );
  assert.equal(/secret|credential|private|hidden/.test(r.text), false);
  assert.equal(r.text.includes("  leading\n    indented\n\nend"), true);
  assert.equal(r.text.includes("A\tB"), true);
});
test("Odyssey parser preserves row spans, unpublished dates and rejects changed tables", () => {
  const html =
    '<body>Assessment Schedule (Student)<table><tr><th>Exam</th><th>Duration</th><th>When</th><th>Room</th><th>Seat</th><th>Sequence</th></tr><tr><td rowspan="2">CS 145 Midterm</td><td>60 min</td><td>2026-10-08 19:00–20:00</td><td>MC</td><td>A1</td><td>1</td></tr><tr><td>60 min</td><td>TBA</td><td></td><td></td><td></td></tr></table><p>Assigned seat information appears later.</p></body>';
  const r = parseSchedule(html);
  assert.equal(r.assessments.length, 2);
  assert.equal(r.assessments[1].exam, "CS 145 Midterm");
  assert.equal(r.assessments[1].date, null);
  assert.equal(r.assessments[0].startTime, "19:00");
  assert.equal(r.notice, "Assigned seat information appears later.");
  assert.throws(
    () => parseSchedule("<body>Assessment Schedule (Student)</body>"),
    /ODYSSEY_RESPONSE_CHANGED/,
  );
});
