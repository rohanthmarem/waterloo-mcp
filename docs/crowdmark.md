# Crowdmark: answer photos and text

Crowdmark uses the existing encrypted Waterloo login. The server signs in through
**Sign in with LEARN**, checks that Crowdmark's email matches the configured
Waterloo account, then uses HTTP for assignment reads. It uses an isolated
Playwright browser for saving photos, typing answers and submitting. It does not
need a browser on the agent's computer.

## Tools

| Tool                          | Purpose                                                             | Owner approval    |
| ----------------------------- | ------------------------------------------------------------------- | ----------------- |
| `check_crowdmark_auth`        | Verify login and count current assignments                          | No                |
| `list_crowdmark_assignments`  | List assignments, course IDs, deadlines and submission status       | No                |
| `get_crowdmark_assignment`    | Read published questions, saved pages/text and the current revision | No                |
| `create_crowdmark_upload`     | Create a transfer ticket for one exact JPEG/PNG photo               | Yes               |
| `save_crowdmark_answers`      | Append photos to questions or replace a text answer                 | Yes               |
| `submit_crowdmark_assignment` | Submit all saved answers for evaluation                             | Separate approval |

Reading never opens an assessment in the browser, starts drafting, or starts a
timer. The returned question body is exactly what Crowdmark publishes: some
courses put only a question label there and provide the actual handout in LEARN.
Use the LEARN file tools for that handout. Signed page-image URLs and login tokens
are not returned. Multiple-choice answers can be read, but cannot be changed by
this integration.

## Photo workflow

1. Attach your answer photos to an agent that can read attachments and make HTTP
   requests or run commands. A file path on the agent's computer is not a path on
   the MCP host.
2. List assignments, then read the chosen `assessmentId`. The agent proposes which
   photos belong to each returned `questionId`, in page order. It should not guess
   a mapping when handwriting or question labels are unclear.
3. For each image, compute its byte size and SHA-256. Call
   `create_crowdmark_upload` with `filename`, `mimeType`, `size`, and `sha256`.
   Review the owner approval link, then retry the same arguments plus
   `authorizationId`. This approves storing those exact bytes on this host; it
   does not send them to Crowdmark.
4. PUT the raw image bytes to the returned `uploadUrl`, using the same client token
   and authentication header used for MCP. Set `Content-Type` to the approved MIME
   type. Do not send multipart or base64. No redirects are followed. A successful
   transfer returns `status: ready` and `fileId`.
5. Read the assignment again, then call `save_crowdmark_answers` with its
   `expectedRevision`, a new UUID `actionId`, and the question mapping. Review the
   approval page: it shows the photos, their hashes, labels, order, existing page
   names and any old/new text. Retry with that approval ID.
6. Check `saved_not_submitted` and the returned saved answers. Final submission is
   a separate `submit_crowdmark_assignment` request with the new revision, its own
   action ID, and its own approval.

Example mapping (use actual IDs returned by your server):

```json
{
  "assessmentId": "practice-assignment",
  "expectedRevision": "<64-character revision from the latest read>",
  "actionId": "<new UUID>",
  "answers": [
    {
      "questionId": "123",
      "fileIds": ["<first photo ID>", "<second photo ID>"]
    },
    {
      "questionId": "124",
      "text": "My worked explanation, with Markdown or LaTeX."
    }
  ]
}
```

A command-line helper avoids putting tokens in command arguments:

```sh
node scripts/crowdmark-upload.mjs inspect ./answer.png
WATERLOO_ORIGIN=https://YOUR-HOST \
  node scripts/crowdmark-upload.mjs send ./answer.png \
  https://YOUR-HOST/crowdmark/uploads/APPROVED_TICKET_ID \
  private/clients/YOUR-CLIENT.token
```

For portable hosting, also set `WATERLOO_AUTH_MODE=portable`. The helper sends only
to the configured HTTPS origin. Agent clients that cannot make HTTP requests or
run this helper cannot transfer attachments with this first version.

## Limits and storage

- JPEG and PNG only, up to 12 MiB each. Export HEIC photos as JPEG first. PDF
  conversion, rotation, deletion and reordering are not included.
- A save can target up to ten questions, ten photos per question, and 60 MiB total.
  Photos append; existing pages are retained. Text replaces the reviewed answer.
- Writes are limited to open, untimed, individual assignments that have never
  been submitted. Submitted, graded, locked, overdue or multi-person group work
  stays read-only. This deliberately excludes late submissions and resubmissions.
- If the instructor enables groups but you are submitting alone, the final
  request must explicitly set `confirmSoloGroup: true`. The approval includes this
  choice; the browser accepts only that specific Crowdmark confirmation.
- All questions must have saved answers before MCP submission. No blank-question
  confirmation is silently accepted.
- Close other Crowdmark editors while saving. The server checks revisions before
  and during edits, but Crowdmark provides no atomic transaction covering an
  entire multi-question save. A network failure can leave some answers saved.
- Photos are encrypted with this user's existing session key under
  `state/crowdmark-files`, using a distinct encryption purpose per file. Each
  approved transfer is single-use and bound to the requesting client, exact size,
  MIME type and hash. Another client cannot use it or request a save with its ID.
- Tickets expire after 15 minutes. Staged photos expire after 24 hours. An hourly
  sweep and new-ticket creation remove expired data. Reservations, including
  unused tickets, are limited to 50 files and 100 MiB per user. Metadata includes
  filenames/hashes but not photo bytes; keep the entire state directory private.
- Minimal operation markers under `state/crowdmark-operations` prevent reuse of an
  attempted `actionId`, including after restart. They contain no answer text or
  credentials. They are retained, with a hard cap of 5,000 markers.
- Browser and HTTP sessions are per user, expire from memory, and are discarded
  when the user's encrypted source session changes. The normal per-user host
  isolation still applies. See [hosting](hosting.md).

## Errors and recovery

| Code                                   | What to do                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CROWDMARK_AUTH_REQUIRED`              | Renew/import the owner's Waterloo login on its host, then retry a read.                                              |
| `CROWDMARK_IDENTITY_MISMATCH`          | Check the configured account; no assignment is changed.                                                              |
| `CROWDMARK_CHANGED`                    | Read the assignment and obtain new approval for its current revision.                                                |
| `CROWDMARK_WRITE_BLOCKED`              | Use Crowdmark directly for timed, late, group or previously submitted work.                                          |
| `CROWDMARK_FILE_INVALID`               | Check the file bytes, client, size, MIME type and ticket expiry; request a new ticket if needed.                     |
| `CROWDMARK_OUTCOME_UNKNOWN`            | **Do not automatically retry.** Inspect Crowdmark and reconcile which answers saved before proposing another action. |
| `CROWDMARK_ACTION_USED`                | This ID was already attempted; inspect saved state before creating a different action.                               |
| `CROWDMARK_INCOMPLETE`                 | Save missing answers before requesting submission.                                                                   |
| `CROWDMARK_SOLO_CONFIRMATION_REQUIRED` | Explicitly choose whether to submit alone, then request owner approval.                                              |
| `CROWDMARK_STORAGE_FULL`               | Wait for staging expiry, or ask the host owner to review storage.                                                    |
| `CROWDMARK_RESPONSE_CHANGED`           | The upstream API or page changed; stop and report it.                                                                |

The integration uses Crowdmark's student website, not a supported public API.
Upstream changes can stop it. No write is automatically retried, and an uncertain
result is never presented as success.

## Verification status

On September 30, 2026, live Waterloo SSO and read-only calls found five assignments;
one submitted assignment returned ten questions and its existing pages. No real
assignment was edited. After login, list/detail calls took approximately 214/343 ms.

Synthetic tests cover encrypted staging, token/caller isolation, byte-hash
validation, expiration, one-use approvals, stale revisions, duplicate actions,
redacted errors, and rejection of writes in `read_many`. A real Chromium test
against a synthetic assignment saved an actual PNG file and a typed answer,
retained an existing page, and required a separate approval callback to submit.

**A live photo upload, live typed answer, and live final submission are not yet
verified.** They need an owner-selected open assignment, actual answer photos,
and approval for those exact changes. Existing submitted work is not used as a
test target.
