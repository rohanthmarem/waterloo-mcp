export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
const pointer = (type, id) => ({ type, id });
const relation = (type, id) => ({ data: pointer(type, id) });
export function assignment() {
  return {
    data: {
      id: "assignment-1",
      type: "assignments",
      attributes: {
        due: "2099-09-30T23:59:59Z",
        "submitted-at": null,
        "marks-sent-at": null,
        "is-locked": false,
        state: "drafting",
      },
      relationships: {
        "exam-master": relation("exam-masters", "test-1"),
        questions: {
          data: [
            pointer("assignment-questions", "q1"),
            pointer("assignment-questions", "q2"),
          ],
        },
        group: relation("assignment-group", "g1"),
      },
    },
    included: [
      {
        type: "exam-masters",
        id: "test-1",
        attributes: {
          title: "Practice",
          "is-timed-enabled": false,
          "is-group-enabled": false,
        },
        relationships: { course: relation("courses", "course-1") },
      },
      { type: "courses", id: "course-1", attributes: { name: "Test course" } },
      {
        type: "assignment-group",
        id: "g1",
        attributes: { "is-grouped": false },
        relationships: {
          members: { data: [pointer("assignment-group-member", "me")] },
        },
      },
      {
        type: "assignment-questions",
        id: "q1",
        attributes: {
          label: "Q1(a)",
          sequence: 1,
          "response-type": "image",
          body: "Upload your work",
        },
        relationships: { pages: { data: [] } },
      },
      {
        type: "assignment-questions",
        id: "q2",
        attributes: {
          label: "Q2",
          sequence: 2,
          "response-type": "text",
          body: "Explain your answer",
        },
        relationships: { pages: { data: [] } },
      },
    ],
  };
}
export function addPage(doc, qid, attrs = {}) {
  const q = doc.included.find((x) => x.id === qid);
  const id =
    "page-" +
    (doc.included.filter((x) => x.type === "assignment-pages").length + 1);
  doc.included.push({
    type: "assignment-pages",
    id,
    attributes: {
      number: q.relationships.pages.data.length + 1,
      state: "uploaded",
      uuid: id,
      ...attrs,
    },
    relationships: { question: relation("assignment-questions", qid) },
  });
  q.relationships.pages.data.push(pointer("assignment-pages", id));
  return id;
}
export const readResult = (r) => JSON.parse(r.content[0].text);
