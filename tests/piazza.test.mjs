import test from "node:test";
import assert from "node:assert/strict";
import { Piazza, piazzaTools, toMarkdown } from "../piazza.mjs";
import { PiazzaError } from "../src/piazza-session.mjs";

const network = {
  id: "class1",
  name: "Calculus",
  course_number: "MATH 1",
  term: "Fall",
  folders: ["notes"],
  prof_hash: "hidden-secret",
  course_description: "<p>Course description</p>",
};
const status = { id: "owner-id", sid: "hidden-secret", networks: [network] };
const feedPost = {
  id: "post1",
  nr: 12,
  type: "question",
  subject: "Limits",
  content_snipet: "Find a limit",
  pin: 1,
  uid: "hidden-secret",
  log: [{ u: "hidden-secret" }],
};
const post = {
  id: "post1",
  nr: 12,
  type: "question",
  folders: ["notes"],
  history_size: 3,
  history: [
    {
      anon: "stud",
      uid: "hidden-secret",
      subject: "Limits",
      content: "<p>Find $$\\lim_{x \\to 0} f(x)$$</p>",
    },
  ],
  change_log: [{ uid: "hidden-secret" }],
  drafts: ["hidden-secret"],
  children: [
    {
      type: "i_answer",
      history: [
        {
          anon: "no",
          uid: "hidden-secret",
          content: "<p>Use the theorem.</p>",
        },
      ],
      children: [],
    },
    {
      type: "s_answer",
      history: [
        {
          anon: "stud",
          uid: "hidden-secret",
          content: "<p>Student explanation.</p>",
        },
      ],
      children: [],
    },
    {
      type: "followup",
      subject: "<p>What about zero?</p>",
      children: [
        { type: "feedback", subject: "<p>Use continuity.</p>", children: [] },
      ],
    },
  ],
};
const data = (r) => JSON.parse(r.content[0].text);
function fixture(handler) {
  const calls = [];
  return {
    calls,
    piazza: new Piazza({
      run: (operation) =>
        operation(
          async (method, params) => {
            calls.push([method, params]);
            return method === "user.status"
              ? structuredClone(status)
              : handler(method, params);
          },
          { uid: "owner-id" },
        ),
    }),
  };
}
test("Piazza class and feed reads omit session data, drafts, and user IDs", async () => {
  const { piazza, calls } = fixture(() => ({
    feed: [feedPost],
    more: true,
    token_data: "hidden-secret",
    drafts: ["hidden-secret"],
  }));
  const auth = data(await piazza.call("check_piazza_auth", {}));
  assert.equal(auth.authenticated, true);
  assert.equal(auth.classCount, 1);
  const classes = data(await piazza.call("list_piazza_classes", {}));
  assert.equal(classes.classes[0].classId, "class1");
  const feed = data(
    await piazza.call("get_piazza_feed", {
      classId: "class1",
      offset: 2,
      limit: 1,
    }),
  );
  assert.equal(feed.nextOffset, 3);
  assert.equal(feed.posts[0].pinned, true);
  assert.deepEqual(calls.at(-1), [
    "network.get_my_feed",
    { nid: "class1", offset: 2, limit: 1, sort: "updated" },
  ]);
  assert(!JSON.stringify({ auth, classes, feed }).includes("hidden-secret"));
});
test("Piazza rejects unknown tools, unexpected arguments, and nonmember classes before reading them", async () => {
  const { piazza, calls } = fixture(() => {
    throw new Error("must not call");
  });
  for (const [name, args, code] of [
    [
      "create_piazza_post",
      { classId: "class1", approved: true },
      "TOOL_UNSUPPORTED",
    ],
    [
      "get_piazza_feed",
      { classId: "class1", method: "content.create" },
      "INPUT_INVALID",
    ],
    ["get_piazza_feed", { classId: "class1", limit: 1000 }, "INPUT_INVALID"],
    [
      "get_piazza_post",
      { classId: "class1", postId: "https://evil.test" },
      "INPUT_INVALID",
    ],
    ["get_piazza_feed", { classId: "other" }, "PIAZZA_FORBIDDEN"],
  ])
    assert.equal(data(await piazza.call(name, args)).error.code, code);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["user.status"],
  );
  assert(piazzaTools.every((t) => t.annotations.readOnlyHint));
});
test("full Piazza thread preserves answers and nested replies without disclosing anonymous authors", async () => {
  const { piazza } = fixture(() => structuredClone(post));
  const p = data(
    await piazza.call("get_piazza_post", { classId: "class1", postId: 12 }),
  );
  assert.equal(p.discussionEntries, 5);
  assert.equal(p.entryTypes.i_answer, 1);
  assert.equal(p.entryTypes.s_answer, 1);
  for (const text of [
    "anonymous",
    "Use the theorem",
    "Student explanation",
    "What about zero",
    "Use continuity",
  ])
    assert(p.text.includes(text));
  assert.equal(p.nextOffset, null);
  assert.equal(p.historicalRevisionsIncluded, false);
  assert(!JSON.stringify(p).includes("hidden-secret"));
  assert.equal(p.contentIsUntrusted, true);
  assert(p.text.includes("$$\\lim_{x \\to 0} f(x)$$"));
});
test("Piazza text pagination reconstructs the entire discussion; search pages actual returned matches", async () => {
  const long = structuredClone(post);
  long.history[0].content = "<p>" + "Course text. ".repeat(300) + "</p>";
  const { piazza } = fixture((method) =>
    method === "content.get"
      ? long
      : [feedPost, { ...feedPost, id: "post2" }, { ...feedPost, id: "post3" }],
  );
  let offset = 0,
    combined = "",
    pages = 0;
  do {
    const p = data(
      await piazza.call("get_piazza_post", {
        classId: "class1",
        postId: "post1",
        offset,
        maxChars: 1000,
      }),
    );
    assert(p.text.length <= 1000);
    combined += p.text;
    offset = p.nextOffset;
    pages++;
  } while (offset !== null);
  const all = data(
    await piazza.call("get_piazza_post", {
      classId: "class1",
      postId: "post1",
      maxChars: 50000,
    }),
  );
  assert.equal(combined, all.text);
  assert(pages > 1);
  const found = data(
    await piazza.call("search_piazza_posts", {
      classId: "class1",
      query: "limits",
      offset: 1,
      limit: 1,
    }),
  );
  assert.equal(found.posts[0].postId, "post2");
  assert.equal(found.nextOffset, 2);
  assert.equal(found.returnedMatchCount, 3);
});
test("Piazza published information, unsafe HTML, changed responses, and failures are handled explicitly", async () => {
  const { piazza } = fixture(() => ({ unexpected: "hidden-secret" }));
  const info = data(
    await piazza.call("get_piazza_course_info", { classId: "class1" }),
  );
  assert(info.text.includes("Course description"));
  assert(!JSON.stringify(info).includes("hidden-secret"));
  assert.equal(
    data(await piazza.call("get_piazza_feed", { classId: "class1" })).error
      .code,
    "PIAZZA_RESPONSE_CHANGED",
  );
  assert.equal(
    data(await piazza.call("get_piazza_post", { classId: "class1", postId: 1 }))
      .error.code,
    "PIAZZA_RESPONSE_CHANGED",
  );
  const html = toMarkdown(
    '<script>steal()</script><p>Notes <a href="javascript:steal()">unsafe link</a><img src="https://piazza.com/file/example.png"></p>',
  );
  assert(!html.includes("steal"));
  assert(html.includes("unsafe link"));
  assert(html.includes("https://piazza.com/file/example.png"));
  const denied = fixture(() => {
    throw new PiazzaError("PIAZZA_FORBIDDEN");
  });
  assert.equal(
    data(await denied.piazza.call("get_piazza_feed", { classId: "class1" }))
      .error.code,
    "PIAZZA_FORBIDDEN",
  );
  const failure = fixture(() => {
    throw new Error("hidden-secret");
  });
  const result = await failure.piazza.call("get_piazza_feed", {
    classId: "class1",
  });
  assert.equal(data(result).error.code, "UPSTREAM_UNAVAILABLE");
  assert(!JSON.stringify(result).includes("hidden-secret"));
});
