// Local HTTPS stand-in for learn.uwaterloo.ca. Serves deterministic fixtures with a
// configurable per-request delay and records every request for counting.
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as fx from "./fixtures.mjs";

const exec = promisify(execFile);
export const TOKEN = "bench-access-token";

export async function selfSignedCert() {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-cert-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "2",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  return {
    key: await readFile(key),
    cert: await readFile(cert),
    certPath: cert,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startFakeLearn({ latencyMs = 50 } = {}) {
  const { key, cert, certPath } = await selfSignedCert();
  const requests = [];
  const le = new RegExp(`^/d2l/api/le/${fx.versions.le}/(\\d+)(/.*)$`);
  function route(url) {
    const u = new URL(url, "https://127.0.0.1");
    const p = u.pathname;
    if (p === "/d2l/api/versions/")
      return {
        json: [
          { ProductCode: "lp", LatestVersion: fx.versions.lp },
          { ProductCode: "le", LatestVersion: fx.versions.le },
        ],
      };
    if (p === `/d2l/api/lp/${fx.versions.lp}/users/whoami`)
      return {
        json: {
          Identifier: "5",
          FirstName: "Bench",
          LastName: "User",
          UniqueName: fx.USERNAME,
          ProfileIdentifier: "x",
        },
      };
    if (p === `/d2l/api/lp/${fx.versions.lp}/enrollments/myenrollments/`) {
      const items = fx.enrollments(u.searchParams.get("isActive") === "true");
      const bookmark = u.searchParams.get("bookmark");
      const start = bookmark ? Number(bookmark) : 0;
      const page = items.slice(start, start + 4);
      const more = start + 4 < items.length;
      return {
        json: {
          PagingInfo: {
            Bookmark: more ? String(start + 4) : "",
            HasMoreItems: more,
          },
          Items: page,
        },
      };
    }
    const m = p.match(le);
    if (!m)
      return { status: 404, json: { Errors: [{ Message: "Not Found" }] } };
    const courseId = Number(m[1]);
    const rest = m[2];
    if (!fx.COURSES.includes(courseId))
      return { status: 403, json: { Errors: [{ Message: "Not Authorized" }] } };
    let mm;
    if (rest === "/content/root/") return { json: fx.contentRoot(courseId) };
    if ((mm = rest.match(/^\/content\/modules\/(\d+)\/structure\/$/)))
      return { json: fx.moduleStructure(courseId, Number(mm[1])) };
    if (rest === "/content/userprogress/") return { json: [] };
    if ((mm = rest.match(/^\/content\/topics\/(\d+)$/)))
      return { json: fx.topicById(courseId, Number(mm[1])) };
    if ((mm = rest.match(/^\/content\/topics\/(\d+)\/file$/))) {
      const f = fx.topicFile(courseId, Number(mm[1]));
      return {
        raw: f.body,
        type: f.type,
        disposition: `attachment; filename="${f.name}"`,
      };
    }
    if (rest === "/news/") return { json: fx.news(courseId) };
    if (rest === "/grades/values/myGradeValues/")
      return { json: fx.gradeValues(courseId) };
    if (rest === "/grades/") return { json: fx.gradeObjects(courseId) };
    if (rest === "/dropbox/folders/")
      return { json: fx.dropboxFolders(courseId) };
    if (
      (mm = rest.match(
        /^\/dropbox\/folders\/(\d+)\/submissions\/mysubmissions\/$/,
      ))
    )
      return { json: fx.submissions(courseId, Number(mm[1])) };
    if (
      (mm = rest.match(/^\/dropbox\/folders\/(\d+)\/feedback\/myFeedback\/$/))
    )
      return { json: fx.feedback(courseId, Number(mm[1])) };
    if ((mm = rest.match(/^\/dropbox\/folders\/(\d+)\/attachments\/(\d+)$/))) {
      const id = Number(mm[2]);
      return id % 2
        ? {
            raw: fx.tinyPdf(id, 80),
            type: "application/pdf",
            disposition: 'attachment; filename="spec.pdf"',
          }
        : {
            raw: Buffer.from("starter file contents ".repeat(200)),
            type: "text/plain",
            disposition: 'attachment; filename="starter.txt"',
          };
    }
    if (rest === "/quizzes/") return { json: fx.quizzes(courseId) };
    if (/^\/quizzes\/\d+\/attempts\/$/.test(rest))
      return { status: 403, json: { Errors: [{ Message: "Not Authorized" }] } };
    if (rest === "/discussions/forums/") return { json: fx.forums(courseId) };
    if ((mm = rest.match(/^\/discussions\/forums\/(\d+)$/)))
      return {
        json:
          fx.forums(courseId).find((f) => f.ForumId === Number(mm[1])) ?? null,
      };
    if ((mm = rest.match(/^\/discussions\/forums\/(\d+)\/topics\/$/)))
      return { json: fx.topics(courseId, Number(mm[1])) };
    if ((mm = rest.match(/^\/discussions\/forums\/(\d+)\/topics\/(\d+)$/)))
      return {
        json:
          fx
            .topics(courseId, Number(mm[1]))
            .find((t) => t.TopicId === Number(mm[2])) ?? null,
      };
    if (
      (mm = rest.match(
        /^\/discussions\/forums\/(\d+)\/topics\/(\d+)\/posts\/$/,
      ))
    )
      return { json: fx.posts(courseId, Number(mm[1]), Number(mm[2])) };
    if (rest === "/classlist/paged/")
      return {
        json: fx.classlist(courseId, {
          roleId: u.searchParams.get("roleId"),
          bookmark: u.searchParams.get("bookmark"),
        }),
      };
    if (rest === "/overview") return { json: fx.overview(courseId) };
    if (rest === "/overview/attachment")
      return {
        raw: fx.tinyPdf(courseId, 120),
        type: "application/pdf",
        disposition: 'attachment; filename="outline.pdf"',
      };
    if (rest === "/calendar/events/") return { json: fx.calendar(courseId) };
    if (rest === "/checklists/") return { json: fx.checklists(courseId) };
    if ((mm = rest.match(/^\/checklists\/(\d+)\/items\/$/)))
      return { json: fx.checklistItems(courseId, Number(mm[1])) };
    return { status: 404, json: { Errors: [{ Message: "Not Found" }] } };
  }
  const server = https.createServer({ key, cert }, async (req, res) => {
    requests.push({ url: req.url, at: Date.now() });
    if (
      req.headers.authorization !== `Bearer ${TOKEN}` &&
      req.url !== "/d2l/api/versions/"
    ) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    await sleep(latencyMs);
    const r = route(req.url);
    if (r.raw) {
      res.writeHead(r.status ?? 200, {
        "Content-Type": r.type,
        "Content-Length": r.raw.length,
        "Content-Disposition": r.disposition,
      });
      return res.end(r.raw);
    }
    const body = JSON.stringify(r.json);
    res.writeHead(r.status ?? 200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  server.keepAliveTimeout = 30000;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `https://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    certPath,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
