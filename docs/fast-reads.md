# Faster MCP reads

Use `read_many` for independent requests whose IDs you already know. It accepts
up to eight requests and runs at most three at once, returning results in input
order. Each user gateway allows at most two active batches. This reduces agent/network round trips across all supported services.
Dependent discovery still needs a second call: list courses first, then read their
projects/content. Do not invent IDs.

```json
{
  "requests": [
    { "name": "get_my_courses", "arguments": {} },
    { "name": "get_odyssey_schedule", "arguments": {} },
    { "name": "list_piazza_classes", "arguments": {} },
    { "name": "list_marmoset_courses", "arguments": {} }
  ]
}
```

Each result includes `index`, `name`, and the original MCP `result`, including
per-tool errors. The entire batch is rejected before any call if it contains a
write, download, nested batch, authorization ID, PDF rendering or media
transcription. A result larger than 128 KiB gets `BATCH_RESULT_TOO_LARGE`; request
that item individually. At most four expensive gateway reads and the existing
per-service limits still apply. Parallel calls from a capable client remain valid;
a batch is not inherently faster than unlimited client-side parallelism.

## Which paths use a browser?

| Path                                                              | Read method                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| LEARN courses, news, grades, assignments, content, rosters, files | Existing authenticated HTTP API; independent requests already run concurrently                             |
| Files linked inside LEARN course HTML                             | `read_course_file` uses the saved school cookies and a same-course URL check; no browser login             |
| Piazza                                                            | Existing direct HTTP RPC with encrypted per-user login                                                     |
| Room catalog and availability                                     | Existing direct HTTP reads                                                                                 |
| Marmoset                                                          | Scripted Playwright login only when needed; subsequent pages fetched directly with a per-user HTTP session |
| Odyssey                                                           | Same HTTP-session approach; parsed assessments preserve rowspan cells, TBA and missing values              |
| Course homepages and dynamic linked outlines                      | Browser rendering retained because server HTML omits visible widgets and embedded content                  |
| Room booking/cancellation and other writes                        | Existing approved workflows; excluded from batching                                                        |

Marmoset and Odyssey session jars are separate objects within each user's gateway.
Only cookies matching the target service are imported. Redirects stay on approved
read paths; cookies are never forwarded to another origin. Source-session or key
changes invalidate the jar. Missing/corrupt encrypted source state fails closed.
Jars expire after five minutes idle or thirty minutes total. Responses are disposed
after parsing; there are no new session files or downloaded page caches on disk.
These tools fetch fresh data. Existing gateway read caches (for example the
30-second Odyssey result cache) retain their existing behavior.

Tool definitions are cached for the lifetime of the worker and discarded when it
is replaced. Authentication and client revocation checks still happen on every
request, including batches and tool discovery. No owner approval is cached.

## Measurements and reproduction

A sequential live comparison on September 22, 2026 used the same exe.dev VM and
student account, deployed baseline `e5b27ad`, and three optimized reads per case.
All eighteen optimized results matched baseline content: Marmoset text was
compared after whitespace and its page-clock footer normalization, with links
compared exactly; Odyssey data matched exactly after removing `retrievedAt`.
Preformatted diagnostics have a separate exact-whitespace test.

| Read                        | Baseline | Optimized warm reads |
| --------------------------- | -------- | -------------------- |
| Marmoset auth               | 5.04 s   | 232–234 ms           |
| Marmoset courses            | 4.36 s   | 235–240 ms           |
| Marmoset projects           | 5.21 s   | 242–342 ms           |
| Marmoset project history    | 6.02 s   | 407–499 ms           |
| Marmoset submission results | 6.63 s   | 556–644 ms           |
| Odyssey schedule            | 4.40 s   | 320–352 ms           |

First-use login still cost 4.84 s for Marmoset and 4.12 s for Odyssey. These are
small samples, not latency guarantees. No failing site reads were discarded from
this final sequential run. An earlier temporary-copy benchmark had broken module
resolution and overlapping output files; it was invalid and is not used here.

On the same local HTTP gateway simulator (80 ms upstream latency), median tool
discovery changed from 3.04 to 2.25 ms; single auth reads stayed about 90 ms.
The large gain is eliminating repeated browser login and serial agent requests,
not microseconds of JSON processing.

`node bench/batch.mjs` compares identical eight-read workloads. In three local
runs: serial client calls took 687–700 ms; one bounded batch took 247–249 ms;
eight fully parallel client calls took 87–92 ms. Batching uses one MCP call instead
of eight and limits server load; it does not claim to beat unlimited concurrency.

Use the repository's `bench/live.mjs` for API/browser read sweeps and
`bench/gateway-bench.mjs` for gateway/worker overhead. Record errors as well as
latency, distinguish cold login from warm sessions and result-cache hits, and
compare complete output before moving a rendered page to HTTP. A real LEARN
homepage check found 436 static characters versus 1,448 rendered characters and
three frames, so replacing that page with raw HTML would have lost content.
