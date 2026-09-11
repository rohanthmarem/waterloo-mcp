# Performance

Measured on 2026-09-09 on an Apple Silicon laptop (10 cores, 32 GiB) with Node 26. All numbers come from the offline suite in `bench/`, which runs the real gateway and the real Brightspace worker against a local HTTPS stand-in for LEARN with deterministic fixtures and a fixed 50 ms delay per request. Nothing here contacted Waterloo. Absolute times on an exe.dev VM will be higher; the request counts and ratios are what carry over.

The suite also records every API tool's output as a golden snapshot. After the changes below, every tool produced byte-for-byte the same data as before (compared as parsed JSON, so only whitespace and ephemeral ports differ). Nothing was added to or removed from any tool.

## Run it

```sh
npm run build
node bench/run.mjs baseline --record-golden   # once, on the commit you are comparing against
node bench/run.mjs after --check-golden       # after a change; fails if any tool output differs
npm run bench:compare -- baseline after       # Markdown tables
node bench/memory-soak.mjs                    # worker RSS across 40 rounds of multi-request tools
```

`--skip-browser` leaves out the Chromium lifecycle section; `LABEL --browser-only` adds it to an existing result file. Chromium must be installed (`npx playwright install chromium`). Results land in `bench/results/`.

What the fixtures look like: six enrollments (five active), six root modules per course each with five children including a nested module, eight announcements, twelve grade items, six assignments with submissions, feedback and rubrics, five quizzes whose attempts endpoint answers 403 as it does for Waterloo students, three forums with three topics of eight posts, a sixty-person classlist paged twenty at a time, a PDF outline attachment, twenty calendar events, and two checklists.

## Real exe.dev VM, real account

The offline suite's fixtures and its 50 ms default delay are a stand-in, not the real thing. So the whole comparison was also run on a real deployment: I copied the production VM with `exe.dev cp` (a byte-for-byte duplicate including the encrypted Waterloo and Piazza login state), moved its dedicated authenticator out of the mounted state so the copy could never renew against the real second factor, pointed it at its own private preview origin, and ran the same read-only sweep through the exe.dev HTTPS proxy against the previous build and then the new build.

The sweep is `bench/live.mjs`: `check_auth`, `get_my_courses`, the account-wide grade/announcement/assignment reads, then for three real courses the content tree, assignments, grades, announcements, discussions, syllabus, news, calendar, roster, assignment files, one topic read, the outline composite, and the rendered course home, then Odyssey, study rooms, and Piazza. 51 tool calls, each run cold (fresh) and warm (repeat). Both passes returned the same four `AUTH_REAUTH_REQUIRED` results on one course whose items the account cannot open, on both builds, and zero transport failures, so the two runs did the same work on the same data.

VM: 2 vCPU, 8 GiB, exe.dev nyc region. Both sweeps ran within four minutes of each other while LEARN was responsive. LEARN itself is intermittently slow from outside the campus (a single request occasionally stalls for tens of seconds); runs caught during a stall were discarded rather than averaged in.

| real read (cold)                       | previous build | new build    | change                  |
| -------------------------------------- | -------------- | ------------ | ----------------------- |
| get_my_grades, all courses             | 3053 ms        | 99 ms        | -97%                    |
| get_announcements, all courses         | 3564 ms        | 68 ms        | -98%                    |
| get_assignments, all courses           | 10706 ms       | 330 ms       | -97%                    |
| get_course_content, largest course     | 10138 ms       | 127 ms       | -99%                    |
| get_course_content, second course      | 608 ms         | 274 ms       | -55%                    |
| get_course_news, largest course        | 1936 ms        | 616 ms       | -68%                    |
| get_syllabus                           | 297–762 ms     | 78–231 ms    | -70% to -74%            |
| get_course_outline (gateway composite) | 595–853 ms     | 96–118 ms    | -84% to -87%            |
| read_course_topic                      | 871–1029 ms    | 176–771 ms   | -11% to -83%            |
| get_roster                             | 117–406 ms     | 86–93 ms     | -21% to -79%            |
| get_course_home (browser)              | 2158–2428 ms   | 1918–2121 ms | -6% to -15%             |
| get_odyssey_schedule (browser)         | 4284 ms        | ~4600 ms     | within run-to-run noise |
| **whole cold sweep, 51 calls**         | **52.8 s**     | **16.1 s**   | **-70%**                |

The composite reads that fan out one request per course, per module, or per folder are where the time went, exactly as the offline suite predicted: account-wide grades, announcements, and assignments and the full content tree all dropped by 97–99 percent because their independent LEARN requests now overlap instead of running one after another behind the old 3-per-second client limit. Single-request reads and the two browser-rendered pages (`get_course_home`, `get_odyssey_schedule`) are unchanged, since their cost is one round trip or the page render itself, not request serialization.

Payloads were 5–35 percent smaller for the same data (compact JSON), e.g. the largest content tree 48.4 → 32.7 KiB, all-course assignments 18.1 → 13.6 KiB.

Image on the real VM: **4.28 GB → 4.13 GB** after `npm run deploy -- HOST code` rebuilt it from the multi-stage Dockerfile. The runtime image no longer contains TypeScript or the other development packages (`node_modules` 122 → 59 MiB inside the container); the rest of the image is the pinned Playwright base, apt packages, and the transcription wheels, which were not touched. The worker starts when the gateway begins listening, so idle memory is slightly higher than the old lazy start (~103 MiB vs ~69 MiB with no worker yet), and the container peaked around 590 MiB during the browser-heavy sweep on both builds.

Reproduce on your own deployment with `npm run bench:live -- remote private/clients/NAME.token --courses 3 --browser --label old`, deploy the new build, then run it again with `--label new`, and `node bench/live-compare.mjs old new`.

## Real sites

## Real sites

The public parts of the real services were measured from the same laptop on 2026-09-09. Authenticated LEARN, Piazza, and Odyssey calls need a signed-in account; this machine had no `.env`, `private/` state, or client token, so those are covered by `npm run bench:live` below rather than by numbers here.

Round trip per request, keep-alive connection, 8 requests each:

| endpoint                                                     | first  | p50    |
| ------------------------------------------------------------ | ------ | ------ |
| learn.uwaterloo.ca `/d2l/api/versions/`                      | 444 ms | 82 ms  |
| learn.uwaterloo.ca LP `users/whoami` (403 without a session) | 81 ms  | 75 ms  |
| learn.uwaterloo.ca LE `content/root/`                        | 92 ms  | 82 ms  |
| libcal.uwaterloo.ca room page                                | 409 ms | 202 ms |
| outline.uwaterloo.ca                                         | 662 ms | 471 ms |

So a LEARN request costs about 80 ms from here, not the 50 ms the offline suite assumes by default. Re-running the offline suite at `BENCH_LATENCY_MS=80` with the previous build (`BENCH_WORKER=/path/to/old/upstream/build/index.js`) gives the numbers at the real round trip:

| tool, cold, 80 ms per request                             | baseline  | after     |
| --------------------------------------------------------- | --------- | --------- |
| get_assignments, one course (16 requests)                 | 2.10 s    | 0.28 s    |
| get_assignments, all courses (65 requests)                | 18.4 s    | 5.7 s     |
| get_course_content, full tree (14 requests)               | 1.44 s    | 0.36 s    |
| get_course_content, depth 1 (8 requests)                  | 0.70 s    | 0.27 s    |
| get_discussions, forum overview (4 requests)              | 356 ms    | 182 ms    |
| get_course_outline through the gateway (14 requests)      | 4.53 s    | 0.36 s    |
| single-request tools (check_auth, grades, news, calendar) | 99–224 ms | unchanged |
| worker startup to tools/list                              | 334 ms    | 254 ms    |
| worker idle RSS                                           | 142 MiB   | 100 MiB   |
| 8 simultaneous single-request calls on an empty bucket    | 304 ms    | 576 ms    |

Full tables: `npm run bench:compare -- baseline-80ms after-80ms`.

Real LibCal, three runs each, 23 rooms across the three libraries:

| read                                  | baseline   | after      |
| ------------------------------------- | ---------- | ---------- |
| room catalog (3 library pages)        | 665–901 ms | 283–411 ms |
| availability, all libraries (3 grids) | 455–509 ms | 342–515 ms |
| availability, one library             | 151–214 ms | 125–202 ms |

The catalog read halves because the three pages are fetched together. The three availability grids gain little when fetched together, which suggests LibCal serves them one at a time per client; the code path is the same and the result bytes are identical (6,103).

Real worker startup against learn.uwaterloo.ca (version discovery is a live request), three runs each, no session on disk:

| metric                                      | baseline    | after      |
| ------------------------------------------- | ----------- | ---------- |
| startup to tools/list                       | 577–690 ms  | 481–573 ms |
| `check_auth` without a session (error path) | 67–71 ms    | 71–74 ms   |
| worker RSS after startup                    | 145–154 MiB | 102 MiB    |

Real page reads with the browser path used by `read_course_link`, on the public page `https://uwaterloo.ca/library/`, three runs each:

| read                               | total     | of which `domcontentloaded` | of which `networkidle` wait |
| ---------------------------------- | --------- | --------------------------- | --------------------------- |
| fresh Chromium per read (baseline) | 3.5–5.0 s | 0.6–2.9 s                   | 1.6–3.6 s                   |
| shared Chromium (after)            | 3.4–3.7 s | 0.6–1.1 s                   | 2.3–3.0 s                   |

On a real page the browser launch is a small part of the total; most of the time is the page itself and the `networkidle` settle, which was left as is because it decides when a rendered page is complete.

### Measure your own account

With a signed-in checkout (`npm run setup`, `npm run login`), run the worker on this machine against LEARN:

```sh
npm run bench:live -- local --courses 2
```

Through a deployed instance, which also covers the outline composite, study rooms, and Piazza:

```sh
npm run bench:live -- remote private/clients/NAME.token --courses 2 --browser
```

Both make read-only calls, print only timings, sizes, and error codes, and write `bench/results/live-<mode>.json`. Run once on the previous deployment and once after `npm run deploy -- HOST code` to compare on real data. A session that needs renewal follows the worker's normal renewal path, the same as any agent calling `check_auth`.

## Baseline versus after

## Worker tools (cold, fresh process; simulated LEARN RTT 50 ms)

| tool                        | baseline p50 | after p50 | change | requests | bytes before | bytes after | bytes change | peak RSS before | peak RSS after |
| --------------------------- | ------------ | --------- | ------ | -------- | ------------ | ----------- | ------------ | --------------- | -------------- |
| check_auth                  | 58 ms        | 58 ms     | 1%     | 1→1      | 0.1 KiB      | 0.1 KiB     | -13%         | 157 MiB         | 105 MiB        |
| get_my_courses              | 110 ms       | 111 ms    | 1%     | 2→2      | 0.8 KiB      | 0.6 KiB     | -24%         | 160 MiB         | 114 MiB        |
| get_upcoming_due_dates      | 116 ms       | 117 ms    | 1%     | 9→9      | 12.1 KiB     | 10.0 KiB    | -17%         | 162 MiB         | 117 MiB        |
| get_my_grades:all           | 113 ms       | 112 ms    | -1%    | 5→5      | 22.8 KiB     | 17.3 KiB    | -24%         | 161 MiB         | 114 MiB        |
| get_my_grades:course        | 58 ms        | 58 ms     | 1%     | 1→1      | 5.2 KiB      | 4.3 KiB     | -17%         | 157 MiB         | 106 MiB        |
| get_announcements:all       | 113 ms       | 113 ms    | 0%     | 5→5      | 13.1 KiB     | 12.5 KiB    | -5%          | 161 MiB         | 115 MiB        |
| get_announcements:course    | 58 ms        | 58 ms     | 0%     | 1→1      | 9.0 KiB      | 8.6 KiB     | -4%          | 157 MiB         | 105 MiB        |
| get_assignments:course      | 2068 ms      | 180 ms    | -91%   | 16→16    | 78.9 KiB     | 71.5 KiB    | -9%          | 161 MiB         | 118 MiB        |
| get_assignments:all         | 18393 ms     | 5695 ms   | -69%   | 65→65    | 324.7 KiB    | 285.0 KiB   | -12%         | 166 MiB         | 126 MiB        |
| get_assignment_files:list   | 62 ms        | 59 ms     | -4%    | 1→1      | 1.2 KiB      | 0.8 KiB     | -31%         | 157 MiB         | 106 MiB        |
| get_assignment_files:read   | 137 ms       | 138 ms    | 1%     | 2→2      | 5.3 KiB      | 5.3 KiB     | -1%          | 167 MiB         | 123 MiB        |
| get_course_content:full     | 1405 ms      | 233 ms    | -83%   | 14→14    | 68.8 KiB     | 59.8 KiB    | -13%         | 161 MiB         | 116 MiB        |
| get_course_content:depth1   | 465 ms       | 182 ms    | -61%   | 8→8      | 40.3 KiB     | 35.3 KiB    | -12%         | 161 MiB         | 116 MiB        |
| get_classlist_emails        | 178 ms       | 180 ms    | 1%     | 3→3      | 5.5 KiB      | 4.1 KiB     | -26%         | 160 MiB         | 114 MiB        |
| get_roster:staff            | 58 ms        | 59 ms     | 1%     | 2→2      | 0.6 KiB      | 0.4 KiB     | -33%         | 157 MiB         | 105 MiB        |
| get_roster:students         | 178 ms       | 178 ms    | 0%     | 3→3      | 6.2 KiB      | 4.1 KiB     | -33%         | 161 MiB         | 115 MiB        |
| get_syllabus                | 142 ms       | 140 ms    | -1%    | 2→2      | 10.0 KiB     | 9.9 KiB     | -0%          | 166 MiB         | 124 MiB        |
| get_discussions:forums      | 231 ms       | 113 ms    | -51%   | 4→4      | 8.9 KiB      | 7.6 KiB     | -15%         | 161 MiB         | 114 MiB        |
| get_discussions:forum       | 283 ms       | 179 ms    | -37%   | 5→5      | 40.2 KiB     | 36.1 KiB    | -10%         | 160 MiB         | 115 MiB        |
| get_discussions:topic       | 115 ms       | 117 ms    | 1%     | 2→2      | 12.8 KiB     | 11.9 KiB    | -7%          | 160 MiB         | 115 MiB        |
| read_course_topic:pdf       | 138 ms       | 139 ms    | 1%     | 2→2      | 5.3 KiB      | 5.3 KiB     | -1%          | 167 MiB         | 122 MiB        |
| read_course_topic:html      | 115 ms       | 116 ms    | 1%     | 2→2      | 4.9 KiB      | 4.8 KiB     | -1%          | 161 MiB         | 115 MiB        |
| read_course_topic:txt       | 112 ms       | 113 ms    | 1%     | 2→2      | 5.4 KiB      | 5.3 KiB     | -1%          | 161 MiB         | 114 MiB        |
| read_course_link:external   | 56 ms        | 58 ms     | 3%     | 1→1      | 0.2 KiB      | 0.2 KiB     | -7%          | 157 MiB         | 105 MiB        |
| get_course_news             | 67 ms        | 62 ms     | -8%    | 1→1      | 10.8 KiB     | 10.0 KiB    | -7%          | 159 MiB         | 109 MiB        |
| get_course_calendar         | 57 ms        | 58 ms     | 1%     | 1→1      | 14.4 KiB     | 11.6 KiB    | -20%         | 157 MiB         | 106 MiB        |
| get_course_checklists:list  | 57 ms        | 58 ms     | 1%     | 1→1      | 2.6 KiB      | 2.5 KiB     | -6%          | 157 MiB         | 106 MiB        |
| get_course_checklists:items | 57 ms        | 58 ms     | 0%     | 1→1      | 6.7 KiB      | 6.4 KiB     | -6%          | 157 MiB         | 106 MiB        |
| download_file               | 59 ms        | 60 ms     | 1%     | 1→1      | 0.4 KiB      | 0.3 KiB     | -7%          | 158 MiB         | 106 MiB        |

## Worker tools (warm, same process, repeated call)

| tool                        | baseline p50 | after p50 | change | requests |
| --------------------------- | ------------ | --------- | ------ | -------- |
| check_auth                  | 53 ms        | 54 ms     | 1%     | 1→1      |
| get_my_courses              | 0 ms         | 1 ms      | 153%   | 0→0      |
| get_upcoming_due_dates      | 1 ms         | 1 ms      | 74%    | 0→0      |
| get_my_grades:all           | 0 ms         | 1 ms      | 36%    | 0→0      |
| get_my_grades:course        | 0 ms         | 0 ms      | 34%    | 0→0      |
| get_announcements:all       | 0 ms         | 1 ms      | 30%    | 0→0      |
| get_announcements:course    | 0 ms         | 0 ms      | 52%    | 0→0      |
| get_assignments:course      | 334 ms       | 124 ms    | -63%   | 1→1      |
| get_assignments:all         | 1319 ms      | 499 ms    | -62%   | 4→4      |
| get_assignment_files:list   | 0 ms         | 0 ms      | -25%   | 0→0      |
| get_assignment_files:read   | 330 ms       | 123 ms    | -63%   | 1→1      |
| get_course_content:full     | 4 ms         | 4 ms      | -2%    | 0→0      |
| get_course_content:depth1   | 2 ms         | 2 ms      | 7%     | 0→0      |
| get_classlist_emails        | 0 ms         | 0 ms      | 26%    | 0→0      |
| get_roster:staff            | 0 ms         | 0 ms      | 28%    | 0→0      |
| get_roster:students         | 0 ms         | 0 ms      | -3%    | 0→0      |
| get_syllabus                | 331 ms       | 123 ms    | -63%   | 1→1      |
| get_discussions:forums      | 0 ms         | 0 ms      | -9%    | 0→0      |
| get_discussions:forum       | 5 ms         | 3 ms      | -39%   | 0→0      |
| get_discussions:topic       | 2 ms         | 1 ms      | -53%   | 0→0      |
| read_course_topic:pdf       | 664 ms       | 248 ms    | -63%   | 2→2      |
| read_course_topic:html      | 666 ms       | 250 ms    | -62%   | 2→2      |
| read_course_topic:txt       | 666 ms       | 249 ms    | -63%   | 2→2      |
| read_course_link:external   | 332 ms       | 125 ms    | -62%   | 1→1      |
| get_course_news             | 332 ms       | 125 ms    | -62%   | 1→1      |
| get_course_calendar         | 333 ms       | 125 ms    | -63%   | 1→1      |
| get_course_checklists:list  | 332 ms       | 125 ms    | -63%   | 1→1      |
| get_course_checklists:items | 333 ms       | 124 ms    | -63%   | 1→1      |
| download_file               | 333 ms       | 124 ms    | -63%   | 1→1      |

## Worker process

| metric                             | baseline | after    | change |
| ---------------------------------- | -------- | -------- | ------ |
| startup to tools/list              | 295 ms   | 217 ms   | -26%   |
| idle RSS after startup             | 149 MiB  | 100 MiB  | -33%   |
| RSS after all tools (warm)         | 153 MiB  | 183 MiB  | 19%    |
| CPU seconds, whole warm pass       | 1.36     | 1.15     | -15%   |
| worker tools/list bytes (22 tools) | 18.1 KiB | 18.1 KiB | 0%     |

## Gateway

| metric                                  | baseline | after    | change |
| --------------------------------------- | -------- | -------- | ------ |
| /status with token (p50)                | 1 ms     | 1 ms     | 2%     |
| /status unauthenticated (p50)           | 1 ms     | 1 ms     | 7%     |
| tools/list (p50)                        | 3 ms     | 3 ms     | 11%    |
| tools/list bytes                        | 29.1 KiB | 29.1 KiB | 0%     |
| tools/list est. tokens                  | 7456     | 7456     | 0%     |
| tools/call check_auth via gateway (p50) | 59 ms    | 58 ms    | -2%    |
| tools/call unknown tool (p50)           | 2 ms     | 2 ms     | -16%   |
| get_course_outline cold                 | 4535 ms  | 562 ms   | -88%   |
| get_course_outline cold requests        | 14       | 14       | 0%     |
| get_course_outline warm                 | 2 ms     | 2 ms     | 2%     |
| 8 concurrent get_my_grades              | 318 ms   | 977 ms   | 207%   |
| 5 concurrent distinct outlines          | 19992 ms | 7002 ms  | -65%   |
| 5 concurrent outlines: SERVICE_BUSY     | 1        | 1        | 0%     |
| approval request (p50)                  | 3 ms     | 3 ms     | 25%    |
| worker RSS at end                       | 178 MiB  | 132 MiB  | -26%   |
| gateway+harness RSS at end              | 148 MiB  | 122 MiB  | -18%   |

## Gateway-local tools

| metric                               | baseline | after   | change |
| ------------------------------------ | -------- | ------- | ------ |
| LibCal room catalog (3 libraries)    | 124 ms   | 42 ms   | -66%   |
| LibCal availability, all libraries   | 148 ms   | 55 ms   | -63%   |
| LibCal availability, one library     | 43 ms    | 42 ms   | -2%    |
| LibCal availability bytes            | 8.1 KiB  | 8.1 KiB | 0%     |
| Piazza thread render (341 nodes) p50 | 16 ms    | 15 ms   | -2%    |
| Piazza get_piazza_post in-memory p50 | 0 ms     | 0 ms    | -3%    |
| approval record write p50            | 0 ms     | 0 ms    | 1%     |
| read cache store 1 MiB p50           | 0 ms     | 1 ms    | 73%    |

## Browser lifecycle

| metric                                    | baseline | after   | change |
| ----------------------------------------- | -------- | ------- | ------ |
| fresh Chromium per call: total p50        | 152 ms   | 146 ms  | -4%    |
| fresh Chromium per call: launch p50       | 74 ms    | 73 ms   | -1%    |
| fresh Chromium per call: peak tree RSS    | 423 MiB  | 414 MiB | -2%    |
| shared Chromium: context+page+close p50   | 53 ms    | 51 ms   | -3%    |
| shared Chromium: idle tree RSS            | 442 MiB  | 444 MiB | 0%     |
| worker pool: first call (launch included) | -        | 111 ms  | -      |
| worker pool: later calls p50              | -        | 37 ms   | -      |

Token estimates use 4 characters per token. `bytes` is the exact size of the text the model receives.

Reading the tables:

- **Cold worker tools.** The composite reads got the large gains: all-course assignments 18.4 s to 5.7 s, single-course assignments 2.1 s to 0.18 s, the full content tree 1.4 s to 0.23 s, forum overviews halved, forum detail a third faster. Single-request tools were already one round trip and did not change.
- **Warm worker tools.** Tools whose reads are not cached by the worker (topic files, news, calendar, checklists, downloads) used to wait about 330 ms for a rate-limit token when called after a burst; they now wait about 125 ms.
- **Payload size.** Every worker response is 5 to 33 percent smaller with identical fields, because responses are no longer indented.
- **Process memory.** Idle worker RSS fell by a third and startup by a quarter because Playwright loads on first use. The "RSS after all tools" row rose; `bench/memory-soak.mjs` with `NODE_ARGS=--max-old-space-size=64` shows both builds flat for 100 rounds (new build 142 MiB, baseline 150 MiB), so this is V8 growing its heap lazily under the new concurrent allocation pattern, not retained memory.
- **Gateway.** The outline composite went from 4.5 s to 0.56 s. The one regression is eight simultaneous single-request calls arriving on an already empty bucket: 318 ms to 977 ms. The old limiter let all eight through after one shared wait, exceeding its own configured rate; the new one serves them in order at the configured rate. With the bucket now refilling to 20 within 2.5 s of idle time, this only shows up under sustained concurrent load.
- **Browser lifecycle.** On this laptop a fresh headless Chromium costs about 146 ms per call and the shared browser about 37 to 51 ms, so each page read saves roughly 100 ms and one browser launch. The tree RSS rows include the benchmark process itself and are only comparable with each other. Launch cost on a small exe.dev VM is several times higher than on this machine, which is where the shared browser matters most; the price is that the browser process stays resident for up to 60 s after a page read.
- **Study rooms.** The three library catalog pages and the per-library availability grids are read together, so both reads cost one LibCal round trip instead of three or four.

## Docker image

Local image builds were not possible on the measuring machine (no running Docker daemon), so the image numbers are from the layer contents rather than a built image:

| layer              | before                                                      | after                            |
| ------------------ | ----------------------------------------------------------- | -------------------------------- |
| npm dependencies   | 122 MiB (with TypeScript, vitest, prettier, rolldown, vite) | 53 MiB (production only)         |
| `upstream/` copied | sources, tests, config, build output                        | `package.json` and `build/` only |
| build context      | included `docs/`, `bench/`, `upstream/tests/`               | excluded                         |

The runtime stage no longer contains a compiler, test runner, or the TypeScript sources. Verify on the VM after the next `npm run deploy -- HOST code` with `sudo docker image ls waterloo-mcp-mcp`. The base image, apt packages (poppler, ffmpeg, python venv), and the transcription wheels are unchanged; they remain most of the image.

## What changed

- Independent LEARN reads overlap instead of running one after another: module children at each tree level, assignment submissions and feedback (per folder and across folders), quiz attempts after a single probe, forum topic lists, and topic post lists. Concurrency is capped at six per group; the rate limiter still bounds the total.
- The client-side LEARN rate limit is 8 requests per second with a burst of 20 (was 3 per second, burst 10). The limiter now serves waiters strictly in order; the old one let concurrent waiters overshoot. 429 responses with Retry-After are honored as before.
- Worker responses are compact JSON.
- Page reads share one headless Chromium with a fresh isolated context per read and a 60 s idle shutdown. Playwright is imported on first use in both processes.
- LibCal library pages and availability grids are fetched together.
- The gateway starts the worker when it begins listening; the worker skips its npm update check in service mode; the worker's response cache holds at most 2000 entries.
- The Docker build has a separate build stage.

## Deliberately unchanged

- **Membership check on every Piazza call** (`user.status` before each read). It is a security check, not overhead worth removing.
- **Study-room checkout browser.** Bookings are rare write actions; each still gets its own browser.
- **`networkidle` waits** on LEARN, outline, and Odyssey pages (10 to 15 s ceilings). They decide when a rendered page is complete; shortening them could change what a read returns.
- **Response shapes.** Several tools return both `markdown` and `html` for the same rich text (assignment instructions, feedback, topic descriptions). The HTML is usually two to five times the markdown and is the largest remaining token cost in those tools. Dropping it would change the output contract, so it is left for a separate decision.
- **Tool descriptions and schemas.** `tools/list` is 29 KiB (about 7,500 tokens) for 34 tools. The text is what lets a model pick the right tool; it was not trimmed.

## Follow-ups worth a separate decision

- A worker that exits (out of memory, crash) is not restarted: the gateway keeps its dead client and every tool answers `UPSTREAM_UNAVAILABLE` until the container restarts, while the health check stays green because `/status` does not touch the worker. Reconnecting on transport close would fix this; it is a behavior change and was not made here.
- The D2L content table-of-contents endpoint returns a whole course tree in one request instead of one per module. Its field set differs from the per-module endpoint, so switching needs verification against a live course.
- A slimmer base image (Node plus only Chromium) would remove roughly a gigabyte, at the cost of leaving the pinned Playwright image and its tested user and library layout.

## Shared hosting and optional Racket

The measurements above describe the school-data worker. Each hosted user has a separate worker, cache, and browser process; memory and concurrent work therefore increase with active users. They do not share cached school responses.

Racket runs use a separate per-user container with one active run at a time. Its time, memory, and output limits are documented in [Racket](racket.md#execution-and-data-protection). The LEARN benchmark does not measure Racket execution, image-build time, browser editing latency, or shared-host capacity. Do not use its numbers as sizing evidence for those workloads.
