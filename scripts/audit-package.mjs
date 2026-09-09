import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { root } from "../src/config.mjs";

// Inspect exactly the files Git would share, including staged additions.
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
if (!files.length) {
  console.error(
    "PACKAGE_EMPTY: stage the intended source files before auditing.",
  );
  process.exit(1);
}
const blocked =
  /(^|\/)(private|node_modules|build|\.env)(\/|$)|\.(token|pem|key|secret|log|zip)$|authenticator\.encrypted\.json$/i;
const patterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /exe0\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{50,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
];
const failures = [];
for (const file of files) {
  if (blocked.test(file)) {
    failures.push(file);
    continue;
  }
  const content = await readFile(path.join(root, file), "utf8");
  if (patterns.some((pattern) => pattern.test(content))) failures.push(file);
}
if (failures.length) {
  console.error(
    JSON.stringify({
      error: {
        code: "PACKAGE_PRIVATE_DATA",
        message: "Remove these files or credentials before sharing.",
        files: failures,
      },
    }),
  );
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      status: "ok",
      trackedFiles: files.length,
      check: "No blocked private paths or recognized token/private-key values.",
    }),
  );
