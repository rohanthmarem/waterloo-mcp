# Contributing

Use Node.js 22 or later. Install from the lockfile, build, and test:

```sh
npm ci
npm run check
npm run test:upstream
```

The upstream suite excludes tests for the original npm release layout. Browser fixture tests are opt-in and do not use a real school account. See `docs/verification.md` for the actual checks performed for this release.

New tools must be reviewed and added to the gateway allowlist. A tool that writes, edits, submits, or sends must use owner approval before execution. Test the actual gateway behavior, including denied, expired, changed, and repeated approvals. Do not rely only on MCP read/write hints.

Use generic fixtures. Do not record school pages, real course IDs, personal details, tokens, login screenshots, or encrypted account state in tests. Keep the original upstream copyright notices when changing vendored files.

Errors returned to agents must have a safe message and an actionable code. Do not return raw upstream exceptions or credential-bearing URLs. Use bounded reads, explicit timeouts, and pagination for large content.

## Hosting and Racket changes

Keep one account per MCP process. Do not add a user-selecting header or tool argument to a shared credential-bearing worker. Hosting changes must preserve separate keys, state paths, owner cookies, caches, and approval records. Update both file audits and running-container audits when generated settings change.

For relevant changes, use Docker and synthetic accounts:

```sh
npm run test:racket:runner
WATERLOO_TEST_RACKET=1 npm run test:hosting:containers
npm run format:check
npm run audit:package
```

The runner test builds its image and checks real execution and denied access. The container test checks two users and rejects cross-user credentials. Follow [Racket browser verification](docs/racket.md#errors-and-verification) for editor or owner-route changes; CI runs that workflow with Chromium. No test needs school credentials.

Keep execution separate from the MCP service. Bound time, memory, output, and concurrent runs. Preserve optimistic revisions and exact approval checks when changing save/run behavior. Test stale revisions, unreadable state, busy retries, uncertain responses, and late browser responses when relevant.

## Documentation checklist

- Update `docs/tools.md` and `docs/clients.md` when tools, schemas, or approvals change.
- Update `docs/hosting.md`, `docs/operations.md`, and `SECURITY.md` when setup, state, keys, or container settings change.
- Keep `docs/errors.md` aligned with error codes and practical recovery steps.
- Record actual tested platforms and limitations in `docs/verification.md`; distinguish synthetic checks from live school access.
- Add user-visible changes to `CHANGELOG.md`. Keep optional unreleased features separate from published version claims.
- Use placeholders in examples. Do not publish real courses, assignments, account identifiers, keys, or approval URLs.
