# Changes

## Unreleased

- Add an offline performance suite (`npm run bench`) with a fake LEARN server, golden output checks for every API tool, and a comparison report; see `docs/performance.md`.
- Read independent LEARN resources together: module children, assignment submissions and feedback, quiz attempts, forum topics, and topic posts. Raise the client-side LEARN rate limit from 3 to 8 requests per second with a burst of 20, served in strict order, while still honoring 429 Retry-After.
- Return compact JSON from the Brightspace worker; the same fields, without indentation whitespace.
- Share one headless Chromium across page reads with a fresh isolated context per read and a 60-second idle shutdown; load Playwright on first use in both processes.
- Read the three LibCal library pages and availability grids together; start the worker when the gateway begins listening; skip the worker's npm update check in service mode; bound the worker's response cache to 2000 entries.
- Build the Docker image in two stages so development packages, TypeScript sources, and tests stay out of the runtime image.

## 0.3.0

- Add six read-only Piazza tools for class lists, feeds, search, published course information, and full current discussions.
- Add private owner setup, encrypted Piazza credentials, and browser-free session renewal on the VM.
- Preserve math notation, include nested replies, and page long text without exposing author IDs, drafts, or raw account metadata.
- Add explicit Piazza errors, membership checks, and tests for authentication, privacy, pagination, and blocked writes.

## 0.2.0

- Add five LibCal study-room tools across Davis Centre, Dana Porter, and Musagetes.
- Require exact owner approval before checkout holds, bookings, or cancellations.
- Recheck availability and preserve the requested room and duration.
- Encrypt booking receipts and cancellation links; block duplicate or uncertain submissions after restarts.
- Add room-specific error codes and browser form tests.

## 0.1.0

- Package LEARN, Odyssey, and course outline access for private exe.dev deployments.
- Add guided setup, encrypted login state, agent tokens, one-use download approvals, caching, diagnostics, and deployment documentation.
