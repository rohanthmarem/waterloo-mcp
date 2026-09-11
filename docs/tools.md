# Tools and read coverage

The gateway uses an explicit allowlist. New upstream tools are blocked until reviewed and added to `authorization.mjs`. Use `tools/list` to get each tool’s current input schema. There are 34 core tools. Enabling Racket for a user adds four tools, for a total of 38.

| Area                 | Tools                                                                                                                             | What they read                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Account              | `check_auth`, `get_my_courses`                                                                                                    | Login status and enrolled courses                                                                               |
| Deadlines and grades | `get_upcoming_due_dates`, `get_my_grades`                                                                                         | Available dates and the current student’s grades                                                                |
| Course updates       | `get_announcements`, `get_course_news`, `get_course_home`                                                                         | Announcements, news and the rendered course homepage                                                            |
| Assignments          | `get_assignments`, `get_assignment_files`                                                                                         | Assignment instructions and linked files                                                                        |
| People               | `get_roster`, `get_classlist_emails`                                                                                              | Classlist data visible to the signed-in account                                                                 |
| Discussion           | `get_discussions`                                                                                                                 | Discussion data returned by the available Brightspace endpoints                                                 |
| Content              | `get_course_content`, `read_course_topic`                                                                                         | Content tree and actual file contents                                                                           |
| Documents            | `get_syllabus`, `get_course_outline`                                                                                              | Syllabus or outline candidates, plus available text                                                             |
| Linked pages         | `read_course_link`                                                                                                                | Allowed Waterloo pages linked from a course topic                                                               |
| Calendar             | `get_course_calendar`, `get_course_checklists`                                                                                    | Course calendar events and checklist items                                                                      |
| Visual notes         | `render_course_pdf_page`                                                                                                          | One PDF page image for a client with image support                                                              |
| Lectures             | `transcribe_course_media`                                                                                                         | A selected audio/video window as machine-generated English text                                                 |
| Odyssey              | `get_odyssey_schedule`                                                                                                            | Assessment schedule visible in the student portal                                                               |
| Study rooms          | `list_study_rooms`, `get_study_room_availability`, `book_study_room`, `get_study_room_bookings`, `cancel_study_room_booking`      | Room discovery, availability, approved booking/cancellation, and this MCP’s booking records                     |
| Piazza               | `check_piazza_auth`, `list_piazza_classes`, `get_piazza_course_info`, `get_piazza_feed`, `search_piazza_posts`, `get_piazza_post` | Class lists, published information, feeds, search, and full current discussions; see [Piazza limits](piazza.md) |
| Download             | `download_file`                                                                                                                   | Saves a course file after owner approval                                                                        |

## Optional Racket tools

| Tool                     | What it does                                                 | Owner approval |
| ------------------------ | ------------------------------------------------------------ | -------------- |
| `list_racket_workspaces` | Lists saved workspaces, revisions, and unreadable IDs        | No             |
| `read_racket_workspace`  | Reads assignment text, code, revision, and latest result     | No             |
| `save_racket_workspace`  | Creates or replaces one document using its expected revision | Yes            |
| `run_racket_workspace`   | Executes that saved revision and stores bounded results      | Yes            |

All four are available only when this user's runner is configured. Execution uses a separate container without school credentials. See [Racket](racket.md) for schemas, supported languages, and limits. A successful run does not establish that the program passed its tests.

## Limits that matter

- Access follows the signed-in account. Hidden, unpublished, locked, missing, or instructor-only items remain unavailable.
- A course homepage is rendered text, not a guarantee that every embedded feed or app has been read. Discussion coverage depends on available endpoints.
- Outlines must appear in accessible content or links. Discovery can report candidates without finding a complete outline.
- `read_course_link` accepts a course topic ID, not an arbitrary URL. Piazza has separate read tools and a separate login. Publisher sites need their own integrations.
- Text reads have a 25 MiB file limit. Use `offset` and `maxChars` to read long text completely. Follow `nextOffset`, bookmarks, and other returned continuation fields.
- A PDF with no text layer needs page rendering and a vision-capable agent. Rendering does not itself run OCR.
- Transcription streams a file to temporary storage, with a 512 MiB limit and a two-minute download timeout. Each request covers 10–600 seconds. One job runs at a time; repeat the same arguments to check progress. Failed jobs can be retried after one minute.
- The speech model downloads on first use. Media stays on the VM; no transcription provider receives it. The generated text can misread math and technical terms.
- Transcripts and downloaded course files are stored as ordinary private files. Authentication state is encrypted separately. Manage retention yourself.
- Reading a resource can cause the school’s ordinary view/access tracking. The server does not intentionally post replies, change grades, submit work, or send messages.
- Outlook, Teams, Quest, external publisher tools, and arbitrary websites are not included.

## Approval rules

`book_study_room`, `cancel_study_room_booking`, `download_file`, `save_racket_workspace`, and `run_racket_workspace` always need agent approval. Room approval includes the resolved room name, library, date, start and end times, and terms notice. `get_syllabus` needs approval only when `downloadPath` is present. Downloads must stay under `/state/downloads`.

Read operations can create temporary files, caches, transcripts, and updated login state as part of their operation. These internal files do not prompt for approval. Explicit saved downloads do. Study-room booking and cancellation are the only enabled external write actions. No course editing, assignment submission, or general messaging tool is enabled.

Approvals match the tool, all arguments, and the requesting client. A changed argument, different agent, denied request, expired approval, or second use is rejected. An approval is consumed before the write begins. Racket checks its lock, revision, and runner health before consumption; an unchanged request can reuse a still-valid approval after those checks fail. Once a write or run starts, do not assume its approval is reusable. Inspect saved state after an uncertain result before requesting another approval.
