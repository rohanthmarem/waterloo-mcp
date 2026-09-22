# Read files linked inside LEARN pages

Some course handouts are links inside an HTML topic, rather than separate topics.
For example, an assignment index can link `W2.pdf` under
`/content/enforced/123-MATH135/media/assignments/`. Such a file has no topic ID.
Opening its URL in an agent's browser does not carry the MCP server's saved login.
A browser sign-in page therefore does not prove the server session has expired.

## Read the file

1. Use `get_course_content` to locate the index topic.
2. Use `read_course_topic` to read that topic and find its file link.
3. Call `read_course_file` with the same `courseId` and the exact `fileUrl`.

```json
{
  "courseId": 123,
  "fileUrl": "https://learn.uwaterloo.ca/content/enforced/123-MATH135/media/assignments/W2.pdf?isCourseFile=true"
}
```

This tool reuses the saved LEARN session and returns paged text in memory. It does
not save a file or attach it to chat. PDF, HTML, text, and Office documents are
supported. Scanned PDFs report that they have no readable text layer. Reads stop
at 25 MiB. A valid session does not need another browser or passkey step.

## Save the file

Call `download_file` with `courseId`, `fileUrl`, and an approved `downloadPath`
under `/state/downloads`. The usual owner approval is still required and is tied
to the exact URL and arguments. Do not mix `fileUrl` with topic or submission IDs.
The returned path is on the MCP host, not on the user's computer. A client needs
its own authorized file-transfer/attachment support to attach it to a conversation;
never present that path or the original LEARN link as a completed attachment.

## Access restrictions and errors

Only HTTPS URLs at the configured LEARN origin, under the requested course's
`/content/enforced/<courseId>-.../` directory, are accepted. LEARN checks the
saved user's permission to read the file. Cookies are not forwarded to other
hosts, other courses, or action URLs, including through redirects. No generic
URL-fetching tool is introduced. A sign-in response triggers the existing
session recovery flow; it is not saved as a PDF.

- `INVALID_COURSE_FILE_URL`: use the exact same-course file URL discovered in a topic.
- `INVALID_FILE_SOURCE`: choose a linked URL, topic ID, or submission IDs, not a mixture.
- `COURSE_FILE_TOO_LARGE`: the file exceeds the read/download size limit.
- `COURSE_FILE_REDIRECT_BLOCKED`: the file redirected outside its allowed course directory.
- `COURSE_FILE_NOT_PDF`: a `.pdf` URL did not return PDF bytes.

A protected external service such as Crowdmark still needs its own integration.
