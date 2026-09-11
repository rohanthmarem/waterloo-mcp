# Racket feature verification

Checked on 2026-09-11 with synthetic accounts and assignments.

- 32 application tests and 411 library tests passed locally. CI also exercises the four browser checkout fixtures.
- The isolated runner passed on Linux ARM64 under Colima on macOS. All five teaching languages ran `check-expect` programs. Failed teaching tests were visible in output. File, network, subprocess, unsafe FFI, and reader checks required explicit access-denial errors. The evaluator timeout returned `RACKET_TIME_LIMIT`, memory exhaustion returned `RACKET_MEMORY_LIMIT`, and output flooding stopped at 32 KiB.
- Two users ran separate MCP and Racket containers. Both users read only their own saved assignment/code and ran their own program. Cross-user credentials were rejected. All 27 runtime isolation checks passed, and each MCP retained its non-internal default route.
- Real Chromium verified owner login, assignment display, code save/run, MCP reads, owner-approved MCP edits and runs, busy retry without consuming approval, preserved unsaved edits, revision conflicts, late-response protection after a newer save, and reload. The page was also loaded from the actual built image.
- A simulated optional-runner startup failure happened only after the MCP start succeeded. Shutdown tests verify that a second admin command remains blocked until the first Docker process exits.
- Claude Code using `claude-fable-5-1` reviewed both the hosting and Racket changes. Review findings led to login/shutdown fixes, deferred Racket approval consumption, runner startup separation, clearer errors, and editor protection.

The Mac browser download did not complete; the real browser workflow was tested in the local Linux container. No real course assignment, new Waterloo login, or production deployment was used. Full DrRacket, graphical output, arbitrary packages, and Windows hosting were not tested or added.

## Hosting release 0.4.0

Checked on 2026-09-11 with synthetic accounts. The existing production installation was kept separate.

- The build, 29 application tests, and 411 library tests passed locally. Four optional application browser fixtures and three optional upstream browser tests were skipped in that run.
- Two real Linux AMD64 containers built from the production Dockerfile passed the shared-host test. Each MCP read returned only that user's encrypted test booking. Foreign agent tokens, owner keys, and owner cookies were rejected. Agent tokens could not open owner setup pages.
- The generated configuration passed 38 of 38 file checks. The actual containers passed 13 of 13 runtime checks, including private mounts and networks, non-root processes, a read-only root filesystem, and loopback-only published ports.
- HTTP tests cover separate caches, approval ownership and single use, token revocation, forged proxy headers, host and origin checks, login throttling, and cookie expiry. Session-import tests reject the wrong Waterloo account before saving and verify encryption with the selected user's key.
- The isolation audit detects reused encryption keys, shared paths, and altered container settings. Owner rotation invalidates old owner credentials without replacing school encryption keys.
- CI runs the two-container test with generated keys and no school credentials. Run it yourself with `npm run test:hosting:containers` on a Docker host.

The container test models the HTTPS proxy's HTTP connection to the backend; it does not install DNS or certificates. A fresh real user's Waterloo/Duo browser login, macOS/Windows Docker hosts, and Linux ARM64 were not tested for this release. The pinned base image publishes AMD64 and ARM64 variants. These checks do not establish protection from the host administrator or guarantee that Waterloo sessions will renew without MFA.

## Previous release: 0.3.0

Checked on 2026-09-09. The private HTTPS MCP served 34 tools, including six new Piazza readers, using the existing agent token.

- 23 gateway, setup, room, and Piazza tests passed. These cover encrypted credential reuse after restart, automatic renewal and failed-login cooldown, class membership, blocked API writes, anonymous author privacy, nested discussions, math notation, search, text pagination, and stable errors.
- 402 vendored library tests passed; 3 optional upstream browser tests were skipped.
- All four account classes were listed. Feed pagination reached 31 unique accessible posts across the four classes. The current post bodies and nested discussions were read through the HTTPS MCP, including real instructor and student answers and follow-up replies. Long-post continuation was exercised.
- Search was checked in all four classes, including an empty result. All four classes had empty published course-information fields; the tools reported that explicitly. Attachment contents, historical revisions, and poll results were not tested or included.
- One initial post call returned `PIAZZA_RESPONSE_CHANGED`. A later check of every post in that class succeeded; the original response was not retained, so its cause is unknown. The server keeps an explicit error for an unrecognized response instead of claiming the read succeeded.
- Only the encrypted Piazza record’s cookies were cleared for a controlled renewal check. A fresh HTTPS MCP call signed in using the saved password and persisted a new session without a local browser, new credentials, or user input. Waterloo state and the authenticator were not changed by that check.
- LEARN authentication, course listing, and existing room-booking history still passed live reads. Unknown Piazza create/edit/message tools were rejected with `TOOL_UNSUPPORTED`. No Piazza write or new reservation was sent.
- Grok Bot reloaded its host catalog from 28 to 34 tools using the same token. It independently verified Piazza authentication, listed all four classes, read the CS 135 feed, and read a complete pinned post.
- A deliberately missing post returned Piazza’s actual “cannot be found” response. Its error mapping is covered by a regression test.

## Previous release: 0.2.0

The room catalog and availability were read live from all three Waterloo libraries. The saved Waterloo session reached the authenticated LibCal checkout form without another password or Duo prompt. No final reservation was submitted during inspection; temporary checkout holds expired and availability was checked again.

- 15 gateway, setup, room data, and booking-history tests passed. The real checkout exposed nested field groups; the browser fixtures now include that structure.
- 402 vendored library tests passed for this update; 3 optional upstream browser tests were skipped.
- Four real Chromium form tests passed in an isolated Linux container with networking disabled: confirmed response, uncertain response, a new required question, and a checkout form pointing outside LibCal.
- Bookings and cancellations require separate owner approval. Tests cover exact arguments, changed times, single use, duplicate request IDs, encrypted receipts, and uncertain outcomes after restart.
- The updated production server listed all 28 tools over its private HTTPS endpoint using the existing agent token. Authentication, course listing, Odyssey, the 23-room catalog, availability, and empty booking history passed live checks.
- One owner-approved real booking was submitted and confirmed by Waterloo. The confirmation response was retained encrypted and used to recover the booking record after its heading exposed a parser mismatch. The corrected parser was checked against that saved response without resubmitting.
- The web confirmation supplied no cancellation link. The owner subsequently supplied the confirmation email, which matched the booking and included that link. An operator stored it encrypted without opening it. The MCP reported the confirmed booking with cancellation available. No real cancellation was submitted. See [study rooms](study-rooms.md).

## Previous release: 0.1.0

Checked on 2026-09-09. These results describe this source release, not a guarantee about another person’s school account.

| Check                             | Result                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| TypeScript build                  | Passed locally and inside the Linux Docker image                                                                       |
| Gateway and setup tests           | 8 passed                                                                                                               |
| Vendored library tests            | 402 passed; 3 opt-in Chromium fixture tests skipped                                                                    |
| Fresh setup CLI                   | Created private keys and config; refused to overwrite them                                                             |
| Client CLI                        | Signed a VM token; verified the signature; revoked and replaced a client                                               |
| Actual exe.dev HTTPS connection   | Connected to an isolated container and listed all 23 tools                                                             |
| Actual HTTPS token revocation     | Disabled token returned `CLIENT_REVOKED` on its next request                                                           |
| Actual proxy access checks        | Token blocked from owner setup; unknown write tool rejected                                                            |
| Missing session through HTTPS MCP | Returned `AUTH_REAUTH_REQUIRED` with `isError: true`                                                                   |
| Approval integration              | Tested exact arguments, owner nonce, client identity, expiry, denial, changed arguments, one use, and concurrent reuse |
| Error handling                    | Checked redaction and stable error codes                                                                               |
| Performance controls              | Checked shared in-progress reads, cache limits, no error caching, and capacity rejection                               |
| Package audit                     | Checked tracked files for private paths, private keys, and recognized signed tokens                                    |

The Docker check used the read-only filesystem, restricted user, secret mount, temporary storage, and loopback port settings from the deployment. It used generated test keys and no Waterloo login state. The existing account’s running server was kept separate.

Not repeated for this release: a new person’s interactive Waterloo/Duo enrollment, fresh unattended authentication, a full course-by-course read audit, and lecture transcription against real course media. The predecessor deployment had live account checks; those do not establish general account compatibility. Run the provided login and `smoke --live` commands on your own installation.

The full `deploy init` command was not pointed at the existing production installation. SSH transfer, image build, container settings, and private HTTPS access were tested in a separate directory and container.

## Reproduce

```sh
npm ci
npm run check
npm run test:upstream
npm run format:check
npm run audit:package
```

The audit reads `git ls-files`, so stage intended files first in a new local repository. The scan detects common mistakes; inspect the tracked file list yourself before sharing. Never treat a successful pattern scan as proof that arbitrary sensitive data cannot exist.

For your deployed instance:

```sh
npm run doctor
npm run smoke -- private/clients/YOUR-TOKEN-FILE.token
npm run smoke -- private/clients/YOUR-TOKEN-FILE.token --live
```

`doctor` checks local files. The first smoke test checks the remote connection and catalog. The second checks authentication, course listing, and Odyssey. A successful status endpoint or tool listing alone does not prove Waterloo data access.
