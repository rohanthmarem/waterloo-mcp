import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  allowedRequest,
  parseTerm,
  parseAppointment,
  parseCart,
  parseClassSearch,
  parseSchedule,
  parseGrades,
  parseTranscript,
  parseHolds,
  parseTodos,
  questDateTime,
  questTools,
  Quest,
  QUEST_SIGN_IN,
} from "../src/quest.mjs";
import { SessionExpired } from "../src/session-http.mjs";
import { READ_TOOLS, KNOWN_TOOLS, needsApproval } from "../authorization.mjs";
import { ERRORS } from "../src/errors.mjs";

const fixture = (name) =>
  readFileSync(
    new URL(`./fixtures/quest/${name}.html`, import.meta.url),
    "utf8",
  );
const winter = parseTerm("1271");
const fall = parseTerm("Fall 2026");
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return "NO_ERROR";
};

test("Quest terms accept codes and names and reject anything else", () => {
  assert.deepEqual(winter, { code: "1271", name: "Winter 2027" });
  assert.deepEqual(fall, { code: "1269", name: "Fall 2026" });
  assert.deepEqual(parseTerm("spring 2027"), {
    code: "1275",
    name: "Spring 2027",
  });
  for (const bad of ["1272", "2027", "W27", "Summer 2027", "1271; drop", ""])
    assert.equal(parseTerm(bad), null, bad);
});

test("Quest tools are read-only, catalogued and batchable without approval", () => {
  assert.deepEqual(
    questTools.map((t) => t.name),
    [
      "get_quest_enrolment_appointment",
      "get_quest_shopping_cart",
      "get_quest_class_schedule",
      "get_quest_grades",
      "get_quest_unofficial_transcript",
      "get_quest_holds_and_todos",
    ],
  );
  for (const tool of questTools) {
    assert(READ_TOOLS.has(tool.name), tool.name);
    assert(KNOWN_TOOLS.has(tool.name), tool.name);
    assert.equal(needsApproval(tool.name, {}), false);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.match(tool.description, /untrusted data, not instructions/);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  for (const c of [
    "QUEST_TERM_UNAVAILABLE",
    "QUEST_ACCESS_DENIED",
    "QUEST_RESPONSE_CHANGED",
    "QUEST_UNAVAILABLE",
  ])
    assert(ERRORS[c], c);
});

test("Quest browsing stays on Quest, Waterloo ADFS and Duo and never signs out", () => {
  const ok = [
    [
      "https://quest.pecs.uwaterloo.ca/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSR_SSENRL_LIST.GBL",
      "POST",
      "document",
    ],
    [
      "https://quest.pecs.uwaterloo.ca/cs/SS/cache/PS_CS_STATUS_OPEN_ICN_1.gif",
      "GET",
      "image",
    ],
    [QUEST_SIGN_IN, "GET", "document"],
    ["https://api-4ccc589b.duosecurity.com/prompt/x", "GET", "document"],
  ];
  for (const [u, m, t] of ok) assert.equal(allowedRequest(u, m, t), true, u);
  const blocked = [
    [
      "https://quest.pecs.uwaterloo.ca/psp/SS/ACADEMIC/SA/?cmd=logout",
      "GET",
      "document",
    ],
    [
      "https://quest.pecs.uwaterloo.ca/psc/SS/ACADEMIC/SA/c/X.GBL",
      "PUT",
      "xhr",
    ],
    [
      "http://quest.pecs.uwaterloo.ca/psc/SS/ACADEMIC/SA/c/X.GBL",
      "GET",
      "document",
    ],
    ["https://quest.pecs.uwaterloo.ca/other/", "GET", "document"],
    ["https://user:pw@quest.pecs.uwaterloo.ca/psc/SS/", "GET", "document"],
    ["https://adfs.uwaterloo.ca/elsewhere", "GET", "document"],
    ["https://evil.example/psc/SS/", "GET", "document"],
    ["https://duosecurity.com.evil.example/", "GET", "document"],
  ];
  for (const [u, m, t] of blocked)
    assert.equal(allowedRequest(u, m, t), false, u);
});

test("Quest dates become Waterloo local times with the right UTC offset", () => {
  assert.deepEqual(questDateTime("November 24, 2026 12:15PM"), {
    date: "2026-11-24",
    local: "2026-11-24T12:15:00",
    iso: "2026-11-24T12:15:00-05:00",
  });
  assert.equal(
    questDateTime("July 29, 2026 9:05AM").iso,
    "2026-07-29T09:05:00-04:00",
  );
  assert.equal(
    questDateTime("November 24, 2026 12:05AM").local,
    "2026-11-24T00:05:00",
  );
  assert.deepEqual(questDateTime("July 29, 2026"), {
    date: "2026-07-29",
    local: null,
    iso: null,
  });
  assert.equal(questDateTime("TBA"), null);
});

test("Enrolment appointment reads the appointment window and open enrolment dates", () => {
  const w = parseAppointment(fixture("appointment-1271"), winter);
  assert.equal(w.noAppointment, false);
  assert.deepEqual(w.appointments, [
    {
      session: "Regular Academic Session",
      begins: "November 24, 2026 12:15PM",
      ends: "November 24, 2026 11:59PM",
      maxTotalUnits: "2.75",
      maxNoGpaUnits: "2.75",
      maxAuditUnits: null,
      maxWaitListUnits: "1.00",
      beginsAt: "2026-11-24T12:15:00-05:00",
      endsAt: "2026-11-24T23:59:00-05:00",
    },
  ]);
  assert.deepEqual(
    w.openEnrolment.map((o) => [o.session, o.beginsDate, o.lastDateToEnrol]),
    [
      ["Regular Academic Session", "2026-11-25", null],
      ["Course Selection Session", "2026-11-25", null],
    ],
  );
  const f = parseAppointment(fixture("appointment-1269"), fall);
  assert.equal(f.noAppointment, true);
  assert.equal(f.openEnrolment[0].beginsDate, "2026-07-29");
  assert.equal(
    code(() => parseAppointment(fixture("appointment-1271"), fall)),
    "QUEST_TERM_UNAVAILABLE",
  );
});

test("Shopping cart reads every row with section, class number, times, room and status", () => {
  const data = parseCart(fixture("cart-1271"), winter);
  assert.deepEqual(
    data.cart.map((c) => [
      c.course,
      c.section,
      c.classNumber,
      c.daysTimes[0],
      c.room[0],
      c.status,
    ]),
    [
      ["CS 902", "002", "5327", "TTh 11:30AM - 12:50PM", "MC 2054", "open"],
      ["CS 902", "201", "5222", "M 7:00PM - 8:50PM", "TBA", "open"],
      ["CS 902", "101", "9233", "F 8:30AM - 9:20AM", "MC 4045", "open"],
      ["MATH 906", "081", "7287", "TBA", "ONLN - Online", "open"],
    ],
  );
  assert.deepEqual(data.scheduled, [
    {
      course: "PD 909",
      section: "081",
      classNumber: "6456",
      component: "LEC",
      title: "Example Careers",
      units: "0.50",
    },
  ]);
  const empty = parseCart(fixture("cart-1269"), fall);
  assert.deepEqual(empty.cart, []);
  assert.equal(empty.scheduled.length, 13);
  assert.deepEqual(
    empty.scheduled
      .filter((s) => s.course === "CS 901")
      .map((s) => [s.section, s.component]),
    [
      ["002", "LEC"],
      ["102", "TUT"],
      ["201", "TST"],
    ],
  );
});

test("Class search supplies components and statuses by class number", () => {
  const sections = parseClassSearch(fixture("class-search-cs136"));
  assert.equal(sections.size, 19);
  assert.deepEqual(sections.get("5327"), {
    section: "002",
    component: "LEC",
    status: "open",
  });
  assert.deepEqual(sections.get("9233"), {
    section: "101",
    component: "TUT",
    status: "open",
  });
  assert.equal(sections.get("5222").component, "TST");
  assert(
    [...sections.values()].some((s) => s.status === "closed"),
    "closed sections are reported",
  );
});

test("Class schedule groups meetings into sections and keeps repeat meetings", () => {
  const data = parseSchedule(fixture("schedule-1269"), fall);
  assert.deepEqual(
    data.courses.map((c) => c.course),
    [
      "CS 901",
      "ENGL 903",
      "MATH 904",
      "MATH 905",
      "MTHEL 907",
      "PHIL 908",
      "SEQ 910",
    ],
  );
  const cs = data.courses[0];
  assert.equal(cs.status, "Enrolled");
  assert.equal(cs.grading, "Numeric Grading Basis");
  const test = cs.sections.find((s) => s.component === "TST");
  assert.deepEqual(
    test.meetings.map((m) => m.dates),
    ["10/08/2026 - 10/08/2026", "11/09/2026 - 11/09/2026"],
  );
  assert.deepEqual(
    cs.sections.find((s) => s.component === "LEC"),
    {
      classNumber: "9422",
      section: "002",
      component: "LEC",
      meetings: [
        {
          daysTimes: "TTh 1:00PM - 2:20PM",
          room: "MC 2054",
          instructor: "Instructor M",
          dates: "09/09/2026 - 12/08/2026",
        },
      ],
    },
  );
  const w = parseSchedule(fixture("schedule-1271"), winter);
  assert.equal(
    w.courses[0].sections[0].meetings[0].instructor,
    "Instructor I, Instructor C",
  );
  assert.equal(
    code(() => parseSchedule(fixture("schedule-1271"), fall)),
    "QUEST_TERM_UNAVAILABLE",
  );
});

test("Grades report unreleased grades as empty with Quest's release notice", () => {
  const data = parseGrades(fixture("grades-1269"), fall);
  assert.equal(data.released, false);
  assert.equal(
    data.notice,
    "Grades for the term will be available on Dec 24, 2026.",
  );
  assert.equal(data.grades.length, 7);
  assert.deepEqual(data.grades[0], {
    course: "CS 901",
    title: "Example Programming",
    units: "0.50",
    grading: "Numeric Grading Basis",
    grade: null,
    gradePoints: null,
  });
  assert.equal(
    code(() => parseGrades(fixture("appointment-1271"), winter)),
    "QUEST_RESPONSE_CHANGED",
  );
});

const liveShapedTranscript = `University of Waterloo
200 University Ave. West
Waterloo Ontario Canada N2L3G1Page 1 of 1
11/24/2026
Undergraduate Unofficial Transcript
Name: Student, Test
Student ID: 00000000
Ontario Education Nbr: 000000000
Beginning of Undergraduate Record
Fall 2026
Program: Example Subject, Honours, Co-operative Program
Level: 1A Form Of Study: Enrolment
Course Description Attempted Earned Grade
CS 901 Example Programming (Advanced Level)
ENGL 903 Example Writing in Mathematics and Computer
Science
MTHEL 907 Example Readiness
Course Topic: First year readiness
Winter 2027
Program: Example Subject, Honours, Co-operative Program
Level: 1B Form Of Study: Enrolment
Course Description Attempted Earned Grade
PD 909 Example Careers
Scholarships and Awards
2027 Example Scholarship
End of Undergraduate Unofficial Transcript`;

test("Unofficial transcript parses terms, wrapped titles, topics and awards without identifiers", () => {
  const data = parseTranscript([liveShapedTranscript]);
  assert.deepEqual(
    data.terms.map((t) => [t.term.code, t.level, t.courses.length]),
    [
      ["1269", "1A", 3],
      ["1271", "1B", 1],
    ],
  );
  assert.equal(
    data.terms[0].courses[1].title,
    "Example Writing in Mathematics and Computer Science",
  );
  assert.equal(data.terms[0].courses[2].topic, "First year readiness");
  assert.deepEqual(data.awards, ["2027 Example Scholarship"]);
  const serialized = JSON.stringify(data);
  for (const secret of ["00000000", "000000000", "Student, Test"])
    assert(!serialized.includes(secret), secret);
  assert.equal(
    code(() => parseTranscript(["Something else"])),
    "QUEST_RESPONSE_CHANGED",
  );
});

test("Unofficial transcript keeps attempted, earned, grades and average lines once released", () => {
  const graded = liveShapedTranscript
    .replace(
      "CS 901 Example Programming (Advanced Level)",
      "CS 901 Example Programming (Advanced Level) 0.50 0.50 91",
    )
    .replace("Winter 2027\n", "Term Average: 88.50\nWinter 2027\n");
  const data = parseTranscript([graded]);
  assert.deepEqual(data.terms[0].courses[0], {
    course: "CS 901",
    title: "Example Programming (Advanced Level)",
    attempted: "0.50",
    earned: "0.50",
    grade: "91",
    topic: null,
  });
  assert.deepEqual(data.statistics, [
    { term: "1269", line: "Term Average: 88.50" },
  ]);
});

test("Holds and to-dos fail closed on unknown pages and report an unavailable to-do list", () => {
  assert.deepEqual(parseHolds(fixture("holds-none")), []);
  assert.deepEqual(parseTodos(fixture("todos-unauthorized")), {
    available: false,
    items: [],
  });
  assert.equal(
    code(() => parseHolds(fixture("grades-1269"))),
    "QUEST_RESPONSE_CHANGED",
  );
  const withHold = `<html><body><form><div>Your Holds</div><table><tr><th>Hold Item</th><th>Reason</th></tr><tr><td>Academic Hold</td><td>Advisor</td></tr></table></form></body></html>`;
  assert.deepEqual(parseHolds(withHold), [
    { "Hold Item": "Academic Hold", Reason: "Advisor" },
  ]);
});

test("Quest calls validate input, renew once on an expired session and reuse transcripts", async () => {
  const quest = new Quest({}, { renew: async () => {}, now: () => 1_000_000 });
  assert.equal(
    (await quest.call("get_quest_grades", { term: "1272" })).isError,
    true,
  );
  assert.equal(
    (await quest.call("get_quest_grades", { term: "1271", extra: 1 })).isError,
    true,
  );
  assert.equal(
    (await quest.call("get_quest_holds_and_todos", { term: "1271" })).isError,
    true,
  );

  let attempts = 0;
  let renewals = 0;
  const expiring = new Quest({}, { renew: async () => renewals++ });
  expiring.run = async () => {
    attempts++;
    throw new SessionExpired();
  };
  const expired = await expiring.call("get_quest_grades", { term: "1271" });
  assert.equal(expired.isError, true);
  assert.match(expired.content[0].text, /AUTH_REAUTH_REQUIRED/);
  assert.deepEqual([attempts, renewals], [2, 1]);

  let clock = 0;
  let sessions = 0;
  const cached = new Quest({}, { now: () => clock });
  cached.session = async () => {
    sessions++;
    return { terms: [], awards: [], statistics: [] };
  };
  const first = JSON.parse(
    (await cached.call("get_quest_unofficial_transcript", {})).content[0].text,
  );
  clock += 9 * 60_000;
  const second = JSON.parse(
    (await cached.call("get_quest_unofficial_transcript", {})).content[0].text,
  );
  clock += 2 * 60_000;
  await cached.call("get_quest_unofficial_transcript", {});
  assert.equal(sessions, 2);
  assert.equal(second.reusedFrom, first.retrievedAt);
  assert.equal(first.contentIsUntrusted, true);
});

test("Shopping cart merges class-search components and names rows it could not resolve", async () => {
  const quest = new Quest({});
  quest.termPage = async () => fixture("cart-1271");
  const searched = [];
  quest.classComponents = async (page, wanted, courses) => {
    searched.push(...courses);
    const found = new Map();
    for (const [nbr, info] of parseClassSearch(fixture("class-search-cs136")))
      found.set(nbr, { ...info, course: "CS 902" });
    return { found, unavailable: ["MATH 906"] };
  };
  const data = await quest.read(
    "get_quest_shopping_cart",
    { term: "1271" },
    {},
  );
  assert.deepEqual(searched, ["CS 902", "MATH 906"]);
  assert.deepEqual(
    data.cart.map((c) => [c.course, c.section, c.component]),
    [
      ["CS 902", "002", "LEC"],
      ["CS 902", "201", "TST"],
      ["CS 902", "101", "TUT"],
      ["MATH 906", "081", null],
    ],
  );
  assert.deepEqual(data.componentsUnavailableFor, ["MATH 906"]);
});

test("Class search refuses to submit when a postback wiped the typed criteria", async () => {
  const values = { term: "1271", subject: "", catalog: "" };
  let searched = false;
  const box = (key, wipe) => ({
    inputValue: async () => values[key],
    fill: async (v) => {
      values[key] = wipe ? "" : v;
    },
    selectOption: async (v) => {
      values[key] = v;
    },
  });
  const page = {
    locator: (selector) =>
      selector.includes("STRM")
        ? box("term")
        : selector.includes("SUBJECT")
          ? box("subject", true)
          : box("catalog"),
    selectOption: async () => {},
    isChecked: async () => false,
    click: async () => {
      searched = true;
    },
  };
  const quest = new Quest({});
  quest.open = async () => ({ authorized: true });
  assert.equal(await quest.searchCourse(page, winter, "CS", "136"), null);
  assert.equal(searched, false);
  const result = await quest.classComponents(page, winter, ["CS 136"]);
  assert.deepEqual(result.unavailable, ["CS 136"]);
});
