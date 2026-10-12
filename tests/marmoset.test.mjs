import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedRequest,
  readLink,
  normalizeSnapshot,
  Marmoset,
  MarmosetError,
  marmosetTools,
} from "../src/marmoset.mjs";
import { needsApproval, KNOWN_TOOLS } from "../authorization.mjs";
test("Marmoset navigation rejects writes and other origins", () => {
  for (const p of [
    "/view/submitProject.jsp",
    "/action/RequestReleaseTest",
    "/data/DownloadSubmission",
    "/authenticate/Logout",
    "/view/course.jsp/../submitProject.jsp",
  ])
    assert.equal(
      allowedRequest(
        "https://marmoset.student.cs.uwaterloo.ca" + p,
        "GET",
        "document",
      ),
      false,
      p,
    );
  assert.equal(
    allowedRequest(
      "https://marmoset.student.cs.uwaterloo.ca/view/project.jsp?projectPK=1",
      "POST",
      "document",
    ),
    false,
  );
  assert.equal(
    allowedRequest("https://evil.example/view/course.jsp", "GET", "document"),
    false,
  );
  assert.equal(
    allowedRequest(
      "https://marmoset.student.cs.uwaterloo.ca/authenticate/PerformLogin;jsessionid=secret",
      "POST",
      "document",
    ),
    true,
  );
  assert.equal(
    allowedRequest(
      "https://marmoset.student.cs.uwaterloo.ca/view/submission.jsp?submissionPK=1",
      "GET",
      "document",
    ),
    true,
  );
});
test("URLs strip session identifiers and reject actions and foreign hosts", () => {
  assert.deepEqual(
    readLink("/view/project.jsp;jsessionid=secret?projectPK=123&csrf=secret"),
    {
      kind: "project",
      id: "123",
      url: "https://marmoset.student.cs.uwaterloo.ca/view/project.jsp?projectPK=123",
    },
  );
  for (const url of [
    "https://evil.example/view/project.jsp?projectPK=1",
    "/view/submitProject.jsp?projectPK=1",
    "/view/project.jsp?projectPK=../1",
    "javascript:alert(1)",
  ])
    assert.equal(readLink(url), null);
  const doc = normalizeSnapshot({
    text: "hello;jsessionid=ABC123",
    links: [
      { text: "view", href: "/view/submission.jsp?submissionPK=1" },
      { text: "release", href: "/action/ReleaseTest?submissionPK=1" },
    ],
  });
  assert.equal(doc.links.length, 1);
  assert.equal(doc.text, "hello");
  assert.throws(
    () => normalizeSnapshot({ text: "x".repeat(1000001), links: [] }),
    { code: "MARMOSET_RESPONSE_TOO_LARGE" },
  );
});
test("strict inputs do not browse or renew; five explicitly read-only tools", async () => {
  const m = new Marmoset({});
  m.read = () => {
    throw Error("should not browse");
  };
  m.renew = () => {
    throw Error("should not renew");
  };
  const r = await m.call("get_marmoset_project", {
    courseId: "1",
    projectId: "2",
    url: "https://evil.example",
  });
  assert.equal(r.isError, true);
  assert.equal(marmosetTools.length, 5);
  for (const t of marmosetTools) {
    assert.equal(KNOWN_TOOLS.has(t.name), true);
    assert.equal(needsApproval(t.name, {}), false);
    assert.equal(t.annotations.readOnlyHint, true);
  }
});
test("auth renews once; access errors never renew and raw exceptions stay private", async () => {
  let renewed = 0,
    reads = 0;
  const m = new Marmoset(
    {},
    {
      renew: async () => {
        renewed++;
      },
    },
  );
  m.read = async () => {
    if (++reads === 1) throw new MarmosetError("MARMOSET_AUTH_REQUIRED");
    return { authenticated: true };
  };
  assert.equal((await m.call("check_marmoset_auth", {})).isError, undefined);
  assert.equal(renewed, 1);
  m.read = async () => {
    throw new MarmosetError("MARMOSET_NOT_FOUND");
  };
  assert.equal((await m.call("check_marmoset_auth", {})).isError, true);
  assert.equal(renewed, 1);
  m.read = async () => {
    throw Error("secret credential");
  };
  assert.equal(
    JSON.stringify(await m.call("check_marmoset_auth", {})).includes(
      "secret credential",
    ),
    false,
  );
});

test("other Duo tenants and credential-bearing URLs are blocked", () => {
  assert.equal(
    allowedRequest(
      "https://api-4ccc589b.duosecurity.com/oauth/v1/authorize",
      "POST",
      "document",
    ),
    true,
  );
  assert.equal(
    allowedRequest(
      "https://api-other.duosecurity.com/oauth/v1/authorize",
      "POST",
      "document",
    ),
    false,
  );
  assert.equal(
    allowedRequest(
      "https://user:secret@marmoset.student.cs.uwaterloo.ca/",
      "GET",
      "document",
    ),
    false,
  );
});
