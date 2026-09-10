// Deterministic LEARN-shaped fixtures for the benchmark harness. No real data.
import { deflateRawSync } from "node:zlib";

const LP = "1.47";
const LE = "1.79";
export const versions = { lp: LP, le: LE };
export const USERNAME = "benchuser";
export const COURSES = [101, 102, 103, 104, 105, 106];
const words =
  "lecture assignment integral matrix proof algorithm complexity kernel process thread syntax semantics recursion induction probability entropy gradient tensor compiler network".split(
    " ",
  );
function prose(seed, n) {
  const out = [];
  for (let i = 0; i < n; i++)
    out.push(words[(seed * 7 + i * 13) % words.length]);
  return out.join(" ");
}
function html(seed, paragraphs = 3) {
  let s = `<h2>Section ${seed}</h2>`;
  for (let p = 0; p < paragraphs; p++)
    s += `<p>${prose(seed + p, 40)} <a href="https://learn.uwaterloo.ca/d2l/le/content/${seed}/viewContent/${p}/View">link ${p}</a> <strong>${prose(seed + p + 1, 4)}</strong></p><ul><li>${prose(seed + 2, 6)}</li><li>${prose(seed + 3, 6)}</li></ul>`;
  return s;
}
const text = (h) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const rich = (seed, paragraphs) => {
  const Html = html(seed, paragraphs);
  return { Text: text(Html), Html };
};
const iso = (d) => new Date(Date.UTC(2026, 8, 1 + (d % 60), 12)).toISOString();

export function enrollments(activeOnly) {
  const items = COURSES.map((id, i) => ({
    OrgUnit: {
      Id: id,
      Name: `BENCH ${id} Course ${i + 1}`,
      Code: `BENCH${id}`,
      Type: { Id: 3, Code: "Course Offering", Name: "Course Offering" },
    },
    Access: {
      IsActive: i !== 5,
      CanAccess: i !== 4,
      ClasslistRoleName: "Student",
      LastAccessed: iso(i),
      StartDate: iso(0),
      EndDate: null,
    },
  })).filter((x) => !activeOnly || x.Access.IsActive);
  return items;
}
export function contentRoot(courseId) {
  return Array.from({ length: 6 }, (_, m) => module(courseId, m + 1));
}
function module(courseId, n) {
  return {
    Id: courseId * 1000 + n,
    Title: n === 1 ? "Course Outline and Syllabus" : `Week ${n} Module`,
    ShortTitle: null,
    Type: 0,
    Description: n % 2 ? rich(courseId + n, 1) : null,
    ModuleStartDate: null,
    ModuleEndDate: null,
    ModuleDueDate: null,
    IsHidden: false,
    IsLocked: false,
    LastModifiedDate: iso(n),
  };
}
export function moduleStructure(courseId, moduleId) {
  const n = moduleId - courseId * 1000;
  const items = [];
  if (n <= 6) {
    for (let t = 1; t <= 3; t++) items.push(topic(courseId, n * 100 + t, 1));
    items.push(topic(courseId, n * 100 + 4, 3));
    items.push(module(courseId, n + 10));
  } else {
    for (let t = 1; t <= 3; t++) items.push(topic(courseId, n * 100 + t, 1));
  }
  return items;
}
export function topic(courseId, n, type) {
  const id = courseId * 1000 + n;
  const ext = ["pdf", "html", "txt"][n % 3];
  return {
    Id: id,
    Title: type === 1 ? `Lecture ${n} notes.${ext}` : `External reading ${n}`,
    ShortTitle: null,
    Type: 1,
    Description: n % 3 === 0 ? rich(id, 2) : { Text: "", Html: "" },
    ModuleStartDate: null,
    ModuleEndDate: null,
    ModuleDueDate: null,
    IsHidden: false,
    IsLocked: false,
    LastModifiedDate: iso(n),
    TopicType: type,
    Url:
      type === 1
        ? `/content/enforced/${courseId}/lecture-${n}.${ext}`
        : n % 2
          ? `https://outline.uwaterloo.ca/view/${courseId}${n}`
          : `https://www.example.com/reading/${n}`,
    StartDate: null,
    EndDate: null,
    DueDate: null,
    ActivityId: null,
  };
}
export function topicById(courseId, topicId) {
  const n = topicId - courseId * 1000;
  return topic(courseId, n, n % 100 === 4 ? 3 : 1);
}
export function news(courseId) {
  return Array.from({ length: 8 }, (_, i) => ({
    Id: courseId * 10 + i,
    Title: `Announcement ${i + 1}: ${prose(courseId + i, 5)}`,
    Body: rich(courseId + i, 2),
    CreatedBy: { Identifier: "1", DisplayName: "Instructor Example" },
    CreatedDate: iso(i * 3),
    LastModifiedBy: { Identifier: "1", DisplayName: "Instructor Example" },
    LastModifiedDate: iso(i * 3),
    StartDate: iso(i * 3),
    EndDate: null,
    IsPublished: i !== 7,
    IsPinned: i === 0,
    IsGlobal: false,
    Attachments:
      i % 4 === 0
        ? [{ FileId: 9000 + i, FileName: `slides-${i}.pdf`, Size: 120000 }]
        : [],
  }));
}
export function gradeValues(courseId) {
  return Array.from({ length: 12 }, (_, i) => ({
    GradeObjectIdentifier: String(courseId * 100 + i),
    GradeObjectName:
      i === 11 ? "Final Calculated Grade" : `Grade item ${i + 1}`,
    DisplayedGrade: `${80 + (i % 15)} %`,
    PointsNumerator: 80 + (i % 15),
    PointsDenominator: 100,
    WeightedNumerator: 8,
    WeightedDenominator: 10,
    Comments: i % 3 ? null : rich(courseId + i, 1),
    PrivateComments: null,
    LastModified: iso(i),
    ReleasedDate: iso(i),
    GradeObjectTypeName: "Numeric",
  }));
}
export function gradeObjects(courseId) {
  return Array.from({ length: 14 }, (_, i) => ({
    Id: courseId * 100 + i,
    Name: i === 13 ? "Midterm (in person)" : `Grade item ${i + 1}`,
    ShortName: "",
    GradeType: "Numeric",
    GradeObjectTypeId: i === 12 ? 9 : 1,
    MaxPoints: 100,
    AssociatedTool:
      i < 6 ? { ToolId: 6, ToolItemId: courseId * 100 + 50 + i } : null,
  }));
}
export function dropboxFolders(courseId) {
  return Array.from({ length: 6 }, (_, i) => ({
    Id: courseId * 100 + 50 + i,
    CategoryId: null,
    Name: `Assignment ${i + 1}`,
    CustomInstructions: rich(courseId + i, 3),
    Attachments:
      i % 2
        ? [
            {
              FileId: courseId * 100 + 70 + i,
              FileName: i === 1 ? "spec.pdf" : "starter.txt",
              Size: 4000,
            },
          ]
        : [],
    TotalFiles: 1,
    UnreadFiles: 0,
    FlaggedFiles: 0,
    TotalUsers: 1,
    TotalUsersWithSubmissions: 1,
    TotalUsersWithFeedback: 1,
    Availability: null,
    GroupTypeId: null,
    DueDate: iso(i * 5),
    IsHidden: false,
    Assessment: {
      ScoreDenominator: 100,
      Rubrics: [
        {
          RubricId: 1,
          Name: "Rubric",
          Criteria: [
            {
              CriterionId: 1,
              Name: "Correctness",
              Levels: [1, 2, 3].map((l) => ({
                LevelId: l,
                Name: `Level ${l}`,
                Points: l * 10,
                Description: rich(l, 1),
              })),
            },
            {
              CriterionId: 2,
              Name: "Style",
              Levels: [1, 2, 3].map((l) => ({
                LevelId: l,
                Name: `Level ${l}`,
                Points: l * 5,
                Description: rich(l + 1, 1),
              })),
            },
          ],
        },
      ],
    },
    SubmissionType: 0,
  }));
}
export function submissions(courseId, folderId) {
  return [
    {
      Id: folderId * 10,
      SubmittedBy: { Identifier: "5", DisplayName: "Bench User" },
      SubmissionDate: iso(2),
      Comment: rich(folderId, 1),
      Files: [
        { FileId: folderId * 10 + 1, FileName: "submission.pdf", Size: 20000 },
      ],
    },
  ];
}
export function feedback(courseId, folderId) {
  return { Score: 88, Feedback: rich(folderId + 3, 2), RubricAssessments: [] };
}
export function quizzes(courseId) {
  return {
    Objects: Array.from({ length: 5 }, (_, i) => ({
      QuizId: courseId * 100 + 90 + i,
      Name: `Quiz ${i + 1}`,
      Description: { Text: rich(courseId + i, 1), IsDisplayed: true },
      StartDate: iso(i),
      EndDate: iso(i + 10),
      DueDate: iso(i + 9),
      IsActive: true,
      AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 },
      SubmissionTimeLimit: {
        IsEnforced: true,
        ShowClock: true,
        TimeLimitValue: 30,
      },
      SubmissionGracePeriod: 5,
      Password: null,
    })),
    Next: null,
  };
}
export function forums(courseId) {
  return Array.from({ length: 3 }, (_, i) => ({
    ForumId: courseId * 10 + i,
    Name: `Forum ${i + 1}`,
    Description: rich(courseId + i, 1),
    StartDate: null,
    EndDate: null,
    IsLocked: false,
    IsHidden: false,
    AllowAnonymous: false,
    RequiresApproval: false,
  }));
}
export function topics(courseId, forumId) {
  return Array.from({ length: 3 }, (_, i) => ({
    ForumId: forumId,
    TopicId: forumId * 10 + i,
    Name: `Topic ${i + 1}`,
    Description: rich(forumId + i, 1),
    StartDate: null,
    EndDate: null,
    DueDate: null,
    IsLocked: false,
    IsHidden: false,
    AllowAnonymousPosts: false,
    MustPostToParticipate: false,
    RequiresApproval: false,
    ScoreOutOf: null,
  }));
}
export function posts(courseId, forumId, topicId) {
  return Array.from({ length: 8 }, (_, i) => ({
    ForumId: forumId,
    TopicId: topicId,
    PostId: topicId * 10 + i,
    ThreadId: topicId * 10,
    ParentPostId: i ? topicId * 10 : null,
    Subject: `Post ${i + 1}`,
    Message: rich(topicId + i, 2),
    PostingUserId: 5 + i,
    PostingUserDisplayName: `Student ${i}`,
    DatePosted: iso(i),
    IsAnonymous: false,
    IsDeleted: false,
    LastEditedDate: null,
    ReplyPostIds: [],
    WordCount: 80,
    AttachmentCount: 0,
    IsRead: true,
  }));
}
export function classlist(courseId, { roleId, bookmark }) {
  const all = Array.from({ length: 60 }, (_, i) => ({
    Identifier: courseId * 1000 + i,
    DisplayName: `Person ${i}`,
    Email: `person${i}@uwaterloo.ca`,
    FirstName: `First${i}`,
    LastName: `Last${i}`,
    RoleId: i < 2 ? 109 : i < 5 ? 135 : 110,
    ClasslistRoleDisplayName: i < 2 ? "Instructor" : i < 5 ? "TA" : "Student",
    IsOnline: false,
    LastAccessed: iso(i),
  })).filter((u) => !roleId || u.RoleId === Number(roleId));
  const start = bookmark ? Number(bookmark) : 0;
  const page = all.slice(start, start + 20);
  return {
    Objects: page,
    Next: start + 20 < all.length ? String(start + 20) : null,
  };
}
export function overview(courseId) {
  return { Description: rich(courseId, 4) };
}
export function calendar(courseId) {
  return Array.from({ length: 20 }, (_, i) => ({
    CalendarEventId: courseId * 100 + i,
    OrgUnitId: courseId,
    Title: `Event ${i + 1}`,
    Description: prose(i, 12),
    StartDateTime: iso(i),
    EndDateTime: iso(i + 1),
    StartDay: null,
    EndDay: null,
    GroupId: null,
    RecurrenceInfo: null,
    LocationId: null,
    LocationName: "MC 2017",
    AssociatedEntity: null,
    VisibilityRestrictions: null,
    CalendarEventViewUrl: `https://learn.uwaterloo.ca/d2l/le/calendar/${courseId}/event/${i}/detailsview`,
    HasVisibilityRestrictions: false,
    IsAssociatedEntityHidden: false,
  }));
}
export function checklists(courseId) {
  return {
    Objects: [1, 2].map((i) => ({
      ChecklistId: courseId * 10 + i,
      Name: `Checklist ${i}`,
      Description: rich(i, 1),
      IsVisible: true,
    })),
    Next: null,
  };
}
export function checklistItems(courseId, checklistId) {
  return {
    Objects: Array.from({ length: 5 }, (_, i) => ({
      ChecklistItemId: checklistId * 10 + i,
      Name: `Item ${i + 1}`,
      Description: rich(i, 1),
      IsCompleted: i < 2,
      DueDate: iso(i),
    })),
    Next: null,
  };
}
/** A minimal one-page PDF with a real text layer so the extractor has something to read. */
export function tinyPdf(seed, lines = 40) {
  const content = ["BT", "/F1 11 Tf", "50 760 Td", "13 TL"];
  for (let i = 0; i < lines; i++)
    content.push(`(${prose(seed + i, 10).replace(/[()\\]/g, "")}) Tj T*`);
  content.push("ET");
  const stream = content.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += String(o).padStart(10, "0") + " 00000 n \n";
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}
/** A minimal DOCX (zip with word/document.xml) for the Office text extractor. */
export function tinyDocx(seed) {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${Array.from({ length: 20 }, (_, i) => `<w:p><w:r><w:t>${prose(seed + i, 12)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;
  return zip([["word/document.xml", Buffer.from(xml)]]);
}
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const deflated = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12);
    c.writeUInt32LE(0, 16);
    c.writeUInt32LE(deflated.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE(0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    parts.push(local, nameBuf, deflated);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}
export function topicFile(courseId, topicId) {
  const n = topicId - courseId * 1000;
  switch (n % 3) {
    case 0:
      return {
        type: "application/pdf",
        name: `lecture-${n}.pdf`,
        body: tinyPdf(topicId, 60),
      };
    case 1:
      return {
        type: "text/html; charset=utf-8",
        name: `lecture-${n}.html`,
        body: Buffer.from(`<html><body>${html(topicId, 8)}</body></html>`),
      };
    default:
      return {
        type: "text/plain; charset=utf-8",
        name: `lecture-${n}.txt`,
        body: Buffer.from(prose(topicId, 600)),
      };
  }
}
