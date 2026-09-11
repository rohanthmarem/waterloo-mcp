// Real isolated runtime tests. No school credentials or user state are mounted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { root } from "../src/config.mjs";
const image = "waterloo-racket-fixture:local";
function docker(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-3000))),
    );
    child.stdin.end(input);
  });
}
await docker(["build", "-t", image, "racket-runner"]);
const run = async (code, language = "racket") =>
  JSON.parse(
    await docker(
      [
        "run",
        "--rm",
        "-i",
        "--network=none",
        "--read-only",
        "--user=65534:65534",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--memory=512m",
        "--cpus=1",
        "--pids-limit=64",
        "--tmpfs=/tmp:size=32m,mode=1777",
        image,
        "python3",
        "-I",
        "-c",
        "import sys,json; sys.path.insert(0,'/runner'); import server; print(json.dumps(server.execute(json.load(sys.stdin))))",
      ],
      JSON.stringify({ language, code }),
    ),
  );
for (const language of [
  "htdp/bsl",
  "htdp/bsl+",
  "htdp/isl",
  "htdp/isl+",
  "htdp/asl",
]) {
  const r = await run(
    "(define (square x) (* x x))\n(check-expect (square 4) 16)",
    language,
  );
  assert.equal(r.status, "completed", JSON.stringify(r));
  console.log(language + ": teaching program passed");
}
let r = await run("(displayln (+ 20 22))");
assert.equal(r.status, "completed", JSON.stringify(r));
assert.match(r.stdout, /42/);
r = await run("(check-expect 1 2)", "htdp/bsl");
assert.match(r.stdout + r.stderr, /fail|actual|expected/i, JSON.stringify(r));
for (const [name, code] of [
  ["filesystem read", '(displayln (file->string "/etc/passwd"))'],
  [
    "filesystem write",
    '(call-with-output-file "/tmp/escape" (lambda (p) (display "x" p)))',
  ],
  ["network", '(tcp-connect "127.0.0.1" 8010)'],
  ["process", '(system "/bin/true")'],
  [
    "unsafe FFI",
    '(require ffi/unsafe) (get-ffi-obj "system" #f (_fun _string -> _int))',
  ],
  ["unapproved reader", '#reader(lib "read.rkt" "wxme") fake'],
]) {
  r = await run(code);
  assert.equal(r.status, "error", name + ": " + JSON.stringify(r));
  console.log(name + ": denied");
}
r = await run('(displayln (getenv "HOME"))');
assert.equal(r.stdout.trim(), "#f");
r = await run("(let loop () (loop))");
assert.equal(r.status, "error");
r = await run('(let loop () (display "output flood") (loop))');
assert.equal(r.code, "RACKET_OUTPUT_LIMIT");
assert(Buffer.byteLength(r.stdout + r.stderr) <= 32768);
console.log("RACKET_RUNNER_PASSED");
