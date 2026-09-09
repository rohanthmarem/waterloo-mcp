import { z } from "zod";
export const outlineTool = {
  name: "get_course_outline",
  description:
    "Find and read a course outline or syllabus from the LEARN course content. Uses existing Waterloo sign-in for published outline.uwaterloo.ca pages and reads file outlines in memory. With multiple matches, returns candidates: select a topicId. Pages long text with offset/maxChars. Authoring links and missing outlines are reported explicitly. Read-only; never saves files or edits an outline.",
  inputSchema: {
    type: "object",
    properties: {
      courseId: { type: "integer", minimum: 1 },
      topicId: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0, default: 0 },
      maxChars: {
        type: "integer",
        minimum: 100,
        maximum: 100000,
        default: 20000,
      },
    },
    required: ["courseId"],
    additionalProperties: false,
  },
};
const schema = z
  .object({
    courseId: z.number().int().positive(),
    topicId: z.number().int().positive().optional(),
    offset: z.number().int().min(0).default(0),
    maxChars: z.number().int().min(100).max(100000).default(20000),
  })
  .strict();
const response = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});
const parse = (r) => JSON.parse(r.content.find((x) => x.type === "text").text);
export function findOutlines(
  nodes,
  parentMatch = false,
  result = [],
  warnings = [],
) {
  for (const item of nodes) {
    if (item.childrenReadError)
      warnings.push({ id: item.id, error: item.childrenReadError });
    if (item.isHidden || item.isLocked) continue;
    const match = /\b(outline|syllabus)\b/i.test(item.title ?? "");
    if (item.type === "module")
      findOutlines(item.children ?? [], parentMatch || match, result, warnings);
    else if (
      match ||
      parentMatch ||
      /^https:\/\/outline\.uwaterloo\.ca\//i.test(item.url ?? "")
    )
      result.push({
        topicId: item.id,
        title: item.title,
        type: item.topicType,
        url: item.url ?? null,
      });
  }
  return { candidates: result, warnings };
}
export async function getCourseOutline(client, raw) {
  const valid = schema.safeParse(raw);
  if (!valid.success)
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Invalid course-outline arguments. Use courseId, optional topicId, offset, and maxChars only.",
        },
      ],
    };
  const args = valid.data;
  const tree = await client.callTool(
    { name: "get_course_content", arguments: { courseId: args.courseId } },
    undefined,
    { timeout: 180000 },
  );
  if (tree.isError) return tree;
  const { candidates, warnings } = findOutlines(parse(tree).contentTree ?? []);
  const base = { courseId: args.courseId, candidates, warnings };
  let selected = args.topicId
    ? candidates.find((x) => x.topicId === args.topicId)
    : candidates.length === 1
      ? candidates[0]
      : null;
  if (args.topicId && !selected)
    return response({
      ...base,
      status: "topic_not_an_outline_candidate",
      note: "Choose a topicId from candidates. For other topics use read_course_topic.",
    });
  if (!selected && candidates.length)
    return response({
      ...base,
      status: "select_outline_topic",
      note: "Multiple outline or syllabus sections found. Call again with a candidate topicId to read a section.",
    });
  if (!selected) {
    const overview = await client.callTool({
      name: "get_syllabus",
      arguments: { courseId: args.courseId },
    });
    return response({
      ...base,
      status: "no_outline_topic_found",
      overview: overview.isError
        ? { error: "Course overview could not be read" }
        : parse(overview),
      note: "No outline topic was found in the accessible content tree. The overview is a fallback, not proof of a complete outline.",
    });
  }
  const content = await client.callTool(
    {
      name: selected.type === "file" ? "read_course_topic" : "read_course_link",
      arguments: {
        courseId: args.courseId,
        topicId: selected.topicId,
        offset: args.offset,
        maxChars: args.maxChars,
      },
    },
    undefined,
    { timeout: 180000 },
  );
  if (content.isError) return content;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ...base, selectedTopicId: selected.topicId }),
      },
      ...content.content,
    ],
  };
}
