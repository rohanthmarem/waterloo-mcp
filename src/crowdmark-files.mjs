import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  open,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { encrypt, decrypt } from "../upstream/build/auth/encrypted-store.js";

export class CrowdmarkError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const cmFail = (code) => {
  throw new CrowdmarkError(code);
};
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const FILE_LIMIT = 12 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const ID = /^[a-f0-9]{48}$/;

// Each gateway already has a separate user's state directory and encryption key.
// Transfer tickets bind the approved name, bytes, digest and caller. They are not
// bearer credentials: the HTTP request must also pass the gateway's client auth.
export class CrowdmarkFiles {
  constructor(config, { now = Date.now } = {}) {
    this.config = config;
    this.now = now;
    this.dir = path.join(config.stateDir, "crowdmark-files");
    this.queue = Promise.resolve();
    this.pending = 0;
  }
  async serial(fn) {
    if (this.pending >= 4) cmFail("SERVICE_BUSY");
    this.pending++;
    const task = this.queue.catch(() => {}).then(fn);
    this.queue = task;
    try {
      return await task;
    } finally {
      this.pending--;
    }
  }
  async key() {
    const key = Buffer.from(
      (
        await readFile(path.join(this.config.secretsDir, "session-key"), "utf8")
      ).trim(),
      "hex",
    );
    if (key.length !== 32) cmFail("CROWDMARK_STORAGE_UNAVAILABLE");
    return key;
  }
  async cleanup() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const rows = [];
    for (const name of await readdir(this.dir)) {
      if (!/^[a-f0-9]{48}\.json$/.test(name)) continue;
      const row = JSON.parse(await readFile(path.join(this.dir, name), "utf8"));
      if (
        row.id !== name.slice(0, -5) ||
        !ID.test(row.id) ||
        !Number.isSafeInteger(row.size) ||
        row.size < 16 ||
        row.size > FILE_LIMIT ||
        !Number.isFinite(row.expiresAt)
      )
        cmFail("CROWDMARK_STORAGE_UNAVAILABLE");
      if (row.expiresAt <= this.now()) {
        for (const ext of [".json", ".encrypted", ".used"])
          await rm(path.join(this.dir, row.id + ext), { force: true });
      } else rows.push(row);
    }
    return rows;
  }
  async create(args, caller) {
    return this.serial(async () => {
      const rows = await this.cleanup();
      if (
        rows.length >= 50 ||
        rows.reduce((n, r) => n + r.size, 0) + args.size > 100 * 1024 * 1024
      )
        cmFail("CROWDMARK_STORAGE_FULL");
      const id = randomBytes(24).toString("hex");
      const row = {
        ...args,
        id,
        caller,
        expiresAt: this.now() + TTL,
        uploadExpiresAt: this.now() + 15 * 60000,
      };
      await writeFile(path.join(this.dir, id + ".json"), JSON.stringify(row), {
        mode: 0o600,
        flag: "wx",
      });
      return {
        fileId: id,
        uploadUrl: this.config.origin + "/crowdmark/uploads/" + id,
        method: "PUT",
        contentType: args.mimeType,
        size: args.size,
        sha256: args.sha256,
        uploadExpiresAt: new Date(row.uploadExpiresAt).toISOString(),
        instructions:
          "PUT the exact raw image bytes with your existing MCP authentication header. Do not send multipart or base64. This ticket works once for this client only. Then use fileId in save_crowdmark_answers.",
      };
    });
  }
  async metadata(id) {
    if (!ID.test(id)) cmFail("CROWDMARK_FILE_INVALID");
    try {
      const row = JSON.parse(
        await readFile(path.join(this.dir, id + ".json"), "utf8"),
      );
      if (row.id !== id || row.expiresAt <= this.now())
        cmFail("CROWDMARK_FILE_INVALID");
      return row;
    } catch {
      cmFail("CROWDMARK_FILE_INVALID");
    }
  }
  async receive(id, caller, req) {
    return this.serial(async () => {
      const row = await this.metadata(id);
      if (row.caller !== caller || row.uploadExpiresAt <= this.now())
        cmFail("CROWDMARK_FILE_INVALID");
      if (req.headers["content-type"]?.split(";")[0] !== row.mimeType)
        cmFail("CROWDMARK_FILE_INVALID");
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > row.size || size > FILE_LIMIT)
          cmFail("CROWDMARK_FILE_INVALID");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length !== row.size ||
        sha256(bytes) !== row.sha256 ||
        (await fileTypeFromBuffer(bytes))?.mime !== row.mimeType
      )
        cmFail("CROWDMARK_FILE_INVALID");
      let mark;
      try {
        mark = await open(path.join(this.dir, id + ".used"), "wx", 0o600);
      } catch {
        cmFail("CROWDMARK_FILE_INVALID");
      }
      await mark.close();
      const key = await this.key();
      try {
        await writeFile(
          path.join(this.dir, id + ".encrypted"),
          JSON.stringify(
            encrypt(
              bytes.toString("base64"),
              key,
              "waterloo-crowdmark-file:v1:" + id,
            ),
          ),
          { mode: 0o600, flag: "wx" },
        );
      } finally {
        key.fill(0);
        bytes.fill(0);
      }
      return {
        fileId: id,
        filename: row.filename,
        size: row.size,
        sha256: row.sha256,
        status: "ready",
      };
    });
  }
  async get(id, caller) {
    const row = await this.metadata(id);
    if (caller !== undefined && row.caller !== caller)
      cmFail("CROWDMARK_FILE_INVALID");
    const key = await this.key();
    try {
      const encrypted = JSON.parse(
        await readFile(path.join(this.dir, id + ".encrypted"), "utf8"),
      );
      const bytes = Buffer.from(
        decrypt(encrypted, key, "waterloo-crowdmark-file:v1:" + id),
        "base64",
      );
      if (bytes.length !== row.size || sha256(bytes) !== row.sha256)
        cmFail("CROWDMARK_FILE_INVALID");
      return { ...row, bytes };
    } catch {
      cmFail("CROWDMARK_FILE_INVALID");
    } finally {
      key.fill(0);
    }
  }
}
