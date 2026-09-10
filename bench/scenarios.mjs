// Tool calls exercised by the benches. Browser-backed tools (get_course_home,
// get_odyssey_schedule, outline pages) and media tools need real hosts or ffmpeg and are
// measured separately by browser-bench.
export const C = 101;
export const workerScenarios = (downloadDir) =>
  [
    ["check_auth", {}],
    ["get_my_courses", {}],
    ["get_upcoming_due_dates", { daysAhead: 30 }],
    ["get_my_grades:all", "get_my_grades", {}],
    ["get_my_grades:course", "get_my_grades", { courseId: C }],
    ["get_announcements:all", "get_announcements", { count: 10 }],
    [
      "get_announcements:course",
      "get_announcements",
      { courseId: C, count: 10 },
    ],
    ["get_assignments:course", "get_assignments", { courseId: C }],
    ["get_assignments:all", "get_assignments", {}],
    ["get_assignment_files:list", "get_assignment_files", { courseId: C }],
    [
      "get_assignment_files:read",
      "get_assignment_files",
      { courseId: C, folderId: C * 100 + 51, fileId: C * 100 + 71 },
    ],
    ["get_course_content:full", "get_course_content", { courseId: C }],
    [
      "get_course_content:depth1",
      "get_course_content",
      { courseId: C, maxDepth: 1 },
    ],
    ["get_classlist_emails", { courseId: C }],
    ["get_roster:staff", "get_roster", { courseId: C }],
    [
      "get_roster:students",
      "get_roster",
      { courseId: C, includeStudents: true },
    ],
    ["get_syllabus", { courseId: C }],
    ["get_discussions:forums", "get_discussions", { courseId: C }],
    [
      "get_discussions:forum",
      "get_discussions",
      { courseId: C, forumId: C * 10 },
    ],
    [
      "get_discussions:topic",
      "get_discussions",
      { courseId: C, forumId: C * 10, topicId: C * 100 },
    ],
    [
      "read_course_topic:pdf",
      "read_course_topic",
      { courseId: C, topicId: C * 1000 + 102 },
    ],
    [
      "read_course_topic:html",
      "read_course_topic",
      { courseId: C, topicId: C * 1000 + 103 },
    ],
    [
      "read_course_topic:txt",
      "read_course_topic",
      { courseId: C, topicId: C * 1000 + 101 },
    ],
    [
      "read_course_link:external",
      "read_course_link",
      { courseId: C, topicId: C * 1000 + 104 },
    ],
    ["get_course_news", { courseId: C }],
    ["get_course_calendar", { courseId: C }],
    ["get_course_checklists:list", "get_course_checklists", { courseId: C }],
    [
      "get_course_checklists:items",
      "get_course_checklists",
      { courseId: C, checklistId: C * 10 + 1 },
    ],
    [
      "download_file",
      { courseId: C, topicId: C * 1000 + 102, downloadPath: downloadDir },
    ],
  ].map((s) =>
    s.length === 2
      ? { label: s[0], name: s[0], args: s[1] }
      : { label: s[0], name: s[1], args: s[2] },
  );
