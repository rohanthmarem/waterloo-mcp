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
