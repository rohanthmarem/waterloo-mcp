# Tools and read coverage

The gateway uses an explicit allowlist. New upstream tools are blocked until reviewed and added to `authorization.mjs`. Use `tools/list` to get each tool’s current input schema.

| Area                 | Tools                                                     | What they read                                                  |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| Account              | `check_auth`, `get_my_courses`                            | Login status and enrolled courses                               |
| Deadlines and grades | `get_upcoming_due_dates`, `get_my_grades`                 | Available dates and the current student’s grades                |
| Course updates       | `get_announcements`, `get_course_news`, `get_course_home` | Announcements, news and the rendered course homepage            |
| Assignments          | `get_assignments`, `get_assignment_files`                 | Assignment instructions and linked files                        |
| People               | `get_roster`, `get_classlist_emails`                      | Classlist data visible to the signed-in account                 |
| Discussion           | `get_discussions`                                         | Discussion data returned by the available Brightspace endpoints |
| Content              | `get_course_content`, `read_course_topic`                 | Content tree and actual file contents                           |
| Documents            | `get_syllabus`, `get_course_outline`                      | Syllabus or outline candidates, plus available text             |
| Linked pages         | `read_course_link`                                        | Allowed Waterloo pages linked from a course topic               |
| Calendar             | `get_course_calendar`, `get_course_checklists`            | Course calendar events and checklist items                      |
| Visual notes         | `render_course_pdf_page`                                  | One PDF page image for a client with image support              |
| Lectures             | `transcribe_course_media`                                 | A selected audio/video window as machine-generated English text |
| Odyssey              | `get_odyssey_schedule`                                    | Assessment schedule visible in the student portal               |
| Download             | `download_file`                                           | Saves a course file after owner approval                        |

## Limits that matter

- Access follows the signed-in account. Hidden, unpublished, locked, missing, or instructor-only items remain unavailable.
- A course homepage is rendered text, not a guarantee that every embedded feed or app has been read. Discussion coverage depends on available endpoints.
- Outlines must appear in accessible content or links. Discovery can report candidates without finding a complete outline.
- `read_course_link` accepts a course topic ID, not an arbitrary URL. External systems such as Piazza and publisher sites need separate integrations.
- Text reads have a 25 MiB file limit. Use `offset` and `maxChars` to read long text completely. Follow `nextOffset`, bookmarks, and other returned continuation fields.
- A PDF with no text layer needs page rendering and a vision-capable agent. Rendering does not itself run OCR.
- Transcription streams a file to temporary storage, with a 512 MiB limit and a two-minute download timeout. Each request covers 10–600 seconds. One job runs at a time; repeat the same arguments to check progress. Failed jobs can be retried after one minute.
- The speech model downloads on first use. Media stays on the VM; no transcription provider receives it. The generated text can misread math and technical terms.
- Transcripts and downloaded course files are stored as ordinary private files. Authentication state is encrypted separately. Manage retention yourself.
- Reading a resource can cause the school’s ordinary view/access tracking. The server does not intentionally post replies, change grades, submit work, or send messages.
- Outlook, Teams, Quest, external publisher tools, and arbitrary websites are not included.

## Approval rules

`download_file` always needs approval. `get_syllabus` needs approval only when `downloadPath` is present. Downloads must stay under `/state/downloads`.

Read operations can create temporary files, caches, transcripts, and updated login state as part of their operation. These internal files do not prompt for approval. Explicit saved downloads do. No general write, edit, submission, or messaging tool is enabled.

Approvals match the tool, all arguments, and the requesting client. A changed argument, different agent, denied request, expired approval, or second use is rejected. An approval is consumed before the write begins; if the write fails, request a new approval rather than repeating the old ID.
