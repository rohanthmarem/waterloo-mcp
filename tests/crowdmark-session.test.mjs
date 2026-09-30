import test from "node:test";
import assert from "node:assert/strict";
import { CrowdmarkSession } from "../src/crowdmark-session.mjs";

test("failed identity checks never leave a reusable Crowdmark session; source rotation replaces cookies", async () => {
  let created = 0,
    disposed = 0,
    reads = 0,
    version = "one",
    bad = true;
  const sessionDoc = {
    data: { relationships: { user: { data: { type: "users", id: "me" } } } },
    included: [
      {
        type: "users",
        id: "me",
        attributes: { email: "student@uwaterloo.ca" },
      },
    ],
  };
  const cm = new CrowdmarkSession(
    { username: "student@uwaterloo.ca" },
    {
      load: async () => ({ version, state: { cookies: [], origins: [] } }),
      browse: async () => ({ cookies: [], origins: [] }),
      createContext: async () => {
        created++;
        return {
          dispose: async () => disposed++,
          get: async (url) => {
            reads++;
            if (bad) throw Error("temporary identity read failure");
            return {
              status: () => 200,
              headers: () => ({ "content-type": "application/json" }),
              body: async () =>
                Buffer.from(
                  JSON.stringify(
                    url.endsWith("/session") ? sessionDoc : { data: [] },
                  ),
                ),
              dispose: async () => {},
            };
          },
        };
      },
    },
  );
  try {
    await assert.rejects(cm.connect());
    assert.equal(cm.context, undefined);
    assert.equal(disposed, 1);
    await assert.rejects(cm.connect());
    assert.equal(created, 2);
    assert.equal(disposed, 2);
    bad = false;
    await cm.read("/api/v2/student/assignments");
    assert.equal(created, 3);
    await cm.read("/api/v2/student/assignments");
    assert.equal(created, 3);
    version = "two";
    await cm.read("/api/v2/student/assignments");
    assert.equal(created, 4);
    const count = reads;
    await assert.rejects(cm.get("/api/v2/student/assignments/../../secrets"), {
      code: "CROWDMARK_RESPONSE_CHANGED",
    });
    assert.equal(reads, count);
    sessionDoc.included[0].attributes.email = "other@uwaterloo.ca";
    version = "three";
    await assert.rejects(cm.connect(), { code: "CROWDMARK_IDENTITY_MISMATCH" });
    assert.equal(cm.context, undefined);
  } finally {
    await cm.close();
  }
});
