# Verification for 0.2.0

The room catalog and availability were read live from all three Waterloo libraries. The saved Waterloo session reached the authenticated LibCal checkout form without another password or Duo prompt. No final reservation was submitted during inspection; temporary checkout holds expired and availability was checked again.

- 15 gateway, setup, room data, and booking-history tests passed. The real checkout exposed nested field groups; the browser fixtures now include that structure.
- 402 vendored library tests passed for this update; 3 optional upstream browser tests were skipped.
- Four real Chromium form tests passed in an isolated Linux container with networking disabled: confirmed response, uncertain response, a new required question, and a checkout form pointing outside LibCal.
- Bookings and cancellations require separate owner approval. Tests cover exact arguments, changed times, single use, duplicate request IDs, encrypted receipts, and uncertain outcomes after restart.
- The updated production server listed all 28 tools over its private HTTPS endpoint using the existing agent token. Authentication, course listing, Odyssey, the 23-room catalog, availability, and empty booking history passed live checks.
- One owner-approved real booking was submitted and confirmed by Waterloo. The confirmation response was retained encrypted and used to recover the booking record after its heading exposed a parser mismatch. The corrected parser was checked against that saved response without resubmitting.
- The confirmation supplied no cancellation link. This real reservation requires the owner’s confirmation email for cancellation. No real cancellation was submitted. See [study rooms](study-rooms.md).

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
