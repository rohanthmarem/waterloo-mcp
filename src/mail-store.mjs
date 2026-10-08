import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export class MailError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const mailFail = (code) => {
  throw new MailError(code);
};
export const MAIL_LIMITS = {
  // Cloudflare Email Routing accepts at most 25 MiB per message.
  maxMessageBytes: 25 * 1024 * 1024,
  maxMessages: 5000,
  maxStoredBytes: 2 * 1024 * 1024 * 1024,
  maxBodyChars: 1000000,
  // Converting HTML to text is bounded; longer HTML-only bodies are cut.
  maxHtmlBytes: 2 * 1024 * 1024,
  // Legitimate mail carries a few signatures. Each one costs a DNS lookup and,
  // with distinct body lengths, a full body hash.
  maxSignatures: 5,
  maxHeaderBytes: 256 * 1024,
  deliveriesKept: 20,
};
// Every message sent to the secret address is stored by default: anyone can already
// email the Waterloo address, and Outlook forwards that mail regardless. Requiring a
// trusted signer is an owner opt-in once a test shows real forwarded mail carries one.
export const DEFAULT_MAIL_POLICY = {
  requireTrustedSigner: false,
  trustedSigners: ["uwaterloo.ca"],
};
const MAGIC = Buffer.from("WMO1");
const domain =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function seal(plaintext, key, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]);
}
function unseal(sealed, key, aad) {
  if (sealed.length < 32 || !sealed.subarray(0, 4).equals(MAGIC))
    mailFail("MAIL_STATE_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(4, 16));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(16, 32));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(32)),
      decipher.final(),
    ]);
  } catch {
    mailFail("MAIL_STATE_INVALID");
  }
}
export function parseTrustedSigners(value) {
  const list = String(value ?? "")
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  if (!list.length || list.length > 10 || !list.every((d) => domain.test(d)))
    mailFail("INPUT_INVALID");
  return [...new Set(list)];
}
const addresses = (field) =>
  (Array.isArray(field) ? field : field ? [field] : [])
    .flatMap((f) => f.value ?? [])
    .filter((a) => typeof a.address === "string")
    .slice(0, 100)
    .map((a) => ({ name: a.name || "", address: a.address.toLowerCase() }));

export class MailStore {
  constructor(config, { verify, resolver } = {}) {
    this.dir = path.join(config.stateDir, "outlook");
    this.secretsDir = config.secretsDir;
    this.verify = verify;
    // mailauth uses the system resolver when none is supplied.
    this.resolver = resolver;
    this.queue = Promise.resolve();
  }
  exclusive(run) {
    const task = this.queue.catch(() => {}).then(run);
    this.queue = task;
    return task;
  }
  async key() {
    const raw = (
      await readFile(path.join(this.secretsDir, "session-key"), "utf8")
    ).trim();
    if (!/^[a-f0-9]{64}$/i.test(raw)) mailFail("CONFIG_INVALID");
    return Buffer.from(raw, "hex");
  }
  async write(file, data) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // A unique temporary name keeps concurrent writers from renaming each other's file.
    const pending = `${file}.${randomBytes(6).toString("hex")}.pending`;
    await writeFile(pending, data, { mode: 0o600 });
    await rename(pending, file);
  }
  async readSealed(file, aad) {
    const key = await this.key();
    try {
      return unseal(await readFile(file), key, aad);
    } catch (error) {
      if (error.code === "ENOENT") mailFail("MAIL_NOT_FOUND");
      throw error instanceof MailError
        ? error
        : new MailError("MAIL_STATE_INVALID");
    } finally {
      key.fill(0);
    }
  }
  async writeSealed(file, plaintext, aad) {
    const key = await this.key();
    try {
      await this.write(file, seal(plaintext, key, aad));
    } finally {
      key.fill(0);
    }
  }
  messageFile(id, kind) {
    if (!/^[a-f0-9]{32}$/.test(id)) mailFail("MAIL_NOT_FOUND");
    return path.join(this.dir, "messages", `${id}.${kind}`);
  }
  async messages() {
    // The decrypted index stays in memory; only writes run in the queue.
    this.index ??= this.readSealed(
      path.join(this.dir, "index.sealed"),
      "waterloo-outlook-index:v1",
    )
      .then((data) => {
        const list = JSON.parse(data.toString("utf8"));
        if (!Array.isArray(list)) mailFail("MAIL_STATE_INVALID");
        return list;
      })
      .catch((error) => {
        this.index = undefined;
        if (error.code === "MAIL_NOT_FOUND") return [];
        throw error;
      });
    return this.index;
  }
  async policy() {
    try {
      const policy = JSON.parse(
        await readFile(path.join(this.dir, "policy.json"), "utf8"),
      );
      return {
        requireTrustedSigner: policy.requireTrustedSigner === true,
        trustedSigners: parseTrustedSigners(policy.trustedSigners),
      };
    } catch (error) {
      if (error.code === "ENOENT") return DEFAULT_MAIL_POLICY;
      mailFail("MAIL_STATE_INVALID");
    }
  }
  async setPolicy({ requireTrustedSigner, trustedSigners }) {
    const policy = {
      requireTrustedSigner: requireTrustedSigner === true,
      trustedSigners: parseTrustedSigners(trustedSigners),
    };
    await this.exclusive(() =>
      this.write(path.join(this.dir, "policy.json"), JSON.stringify(policy)),
    );
    return policy;
  }
  async deliveries() {
    try {
      return JSON.parse(
        await readFile(path.join(this.dir, "deliveries.json"), "utf8"),
      );
    } catch {
      return [];
    }
  }
  // The delivery log keeps signing domains, outcome, and size only, never message
  // content, so the owner can see which signer real forwarded mail carries.
  async logDelivery(entry, signers, size) {
    const list = await this.deliveries();
    list.unshift({
      at: new Date().toISOString(),
      ...entry,
      passingSigners: signers
        .filter((s) => s.result === "pass")
        .map((s) => s.domain),
      failingSigners: signers
        .filter((s) => s.result !== "pass")
        .map((s) => s.domain),
      size,
    });
    await this.write(
      path.join(this.dir, "deliveries.json"),
      JSON.stringify(list.slice(0, MAIL_LIMITS.deliveriesKept)),
    );
  }
  async reject(reason, signers, size) {
    await this.exclusive(() =>
      this.logDelivery({ stored: false, reason }, signers, size),
    );
    return { stored: false, reason };
  }
  async signers(raw) {
    // Count signatures in the header block before verifying any of them.
    const head = raw
      .subarray(0, MAIL_LIMITS.maxHeaderBytes)
      .toString("latin1")
      .split(/\r?\n\r?\n/);
    if (head.length < 2) return null;
    const count = (head[0].match(/(?:^|\n)dkim-signature:/gi) ?? []).length;
    if (count > MAIL_LIMITS.maxSignatures) return null;
    let result;
    try {
      // Mail libraries load on first delivery to keep gateway memory low.
      const verify =
        this.verify ?? (await import("mailauth/lib/dkim/verify.js")).dkimVerify;
      result = await verify(raw, {
        ...(this.resolver ? { resolver: this.resolver } : {}),
      });
    } catch {
      // Retryable: the Worker tries again instead of losing the message.
      mailFail("UPSTREAM_UNAVAILABLE");
    }
    return (result.results ?? [])
      .filter((r) => typeof r.signingDomain === "string")
      .map((r) => ({
        domain: r.signingDomain.toLowerCase(),
        // A signature with an l= body length does not cover appended content.
        result: r.status?.underSized
          ? "partial"
          : String(r.status?.result ?? "none"),
      }));
  }
  // Reading attachments skips the HTML-to-text step that only ingest needs.
  async parse(raw, { attachmentsOnly = false } = {}) {
    try {
      const { simpleParser } = await import("mailparser");
      return await simpleParser(raw, {
        skipHtmlToText: attachmentsOnly,
        maxHtmlLengthToParse: MAIL_LIMITS.maxHtmlBytes,
        skipTextToHtml: true,
        skipTextLinks: true,
        skipImageLinks: true,
      });
    } catch {
      mailFail("MAIL_MESSAGE_INVALID");
    }
  }
  async ingest(raw) {
    if (!Buffer.isBuffer(raw) || !raw.length) mailFail("MAIL_MESSAGE_INVALID");
    if (raw.length > MAIL_LIMITS.maxMessageBytes) mailFail("REQUEST_TOO_LARGE");
    const policy = await this.policy();
    const signers = await this.signers(raw);
    if (!signers) return this.reject("HEADERS_TOO_LARGE", [], raw.length);
    const within = (d, parent) => d === parent || d.endsWith("." + parent);
    const trusted = signers.filter((s) =>
      policy.trustedSigners.some((d) => within(s.domain, d)),
    );
    const signer = trusted.find((s) => s.result === "pass");
    if (policy.requireTrustedSigner && !signer) {
      // A DNS failure for a trusted signer is temporary; ask the Worker to retry.
      if (trusted.some((s) => s.result === "temperror"))
        mailFail("UPSTREAM_UNAVAILABLE");
      return this.reject("SIGNATURE_UNTRUSTED", signers, raw.length);
    }
    let parsed;
    try {
      parsed = await this.parse(raw);
    } catch {
      return this.reject("MESSAGE_UNPARSEABLE", signers, raw.length);
    }
    // DKIM verifies the last copy of a header; readers show the first. A repeated
    // header could make a replayed signed message display different content.
    const counts = {};
    for (const { key } of parsed.headerLines ?? [])
      counts[key] = (counts[key] ?? 0) + 1;
    if (
      [
        "from",
        "sender",
        "reply-to",
        "to",
        "cc",
        "subject",
        "date",
        "message-id",
      ].some((k) => counts[k] > 1)
    )
      return this.reject("HEADER_REPEATED", signers, raw.length);
    const internetMessageId =
      typeof parsed.messageId === "string" ? parsed.messageId : null;
    const id = createHash("sha256")
      .update(
        internetMessageId
          ? "message-id\n" + internetMessageId
          : "raw\n" + createHash("sha256").update(raw).digest("hex"),
      )
      .digest("hex")
      .slice(0, 32);
    const body = (parsed.text ?? "").slice(0, MAIL_LIMITS.maxBodyChars);
    const from = addresses(parsed.from);
    const fromDomain = from[0]?.address.split("@").pop() ?? "";
    const attachments = (parsed.attachments ?? []).map((a, index) => ({
      index,
      filename: typeof a.filename === "string" ? a.filename.slice(0, 300) : "",
      contentType: String(a.contentType ?? "application/octet-stream"),
      size: a.size ?? a.content?.length ?? 0,
      inline: !!a.related,
    }));
    const summary = {
      messageId: id,
      internetMessageId,
      subject: String(parsed.subject ?? "").slice(0, 2000),
      from,
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      replyTo: addresses(parsed.replyTo),
      date:
        parsed.date instanceof Date && !isNaN(parsed.date)
          ? parsed.date.toISOString()
          : null,
      receivedAt: new Date().toISOString(),
      snippet: body.replace(/\s+/g, " ").trim().slice(0, 300),
      attachments: attachments.filter((a) => !a.inline),
      hasCalendarInvite: attachments.some((a) =>
        a.contentType.toLowerCase().startsWith("text/calendar"),
      ),
      size: raw.length,
      storedBytes: raw.length + Buffer.byteLength(body),
      signatures: signers.slice(0, MAIL_LIMITS.maxSignatures),
      trustedSigner: signer?.domain ?? null,
      // Whether the From domain's own signature survived forwarding. False is
      // common for genuine forwarded mail; true rules out a forged sender.
      senderSignatureVerified: signers.some(
        (s) =>
          s.result === "pass" &&
          !!fromDomain &&
          (within(fromDomain, s.domain) || within(s.domain, fromDomain)),
      ),
    };
    return this.exclusive(async () => {
      const list = await this.messages();
      if (list.some((m) => m.messageId === id))
        return { stored: true, duplicate: true, messageId: id };
      await this.logDelivery({ stored: true }, signers, raw.length);
      await this.writeSealed(
        this.messageFile(id, "eml"),
        raw,
        "waterloo-outlook-message:v1:" + id,
      );
      await this.writeSealed(
        this.messageFile(id, "body"),
        Buffer.from(body, "utf8"),
        "waterloo-outlook-body:v1:" + id,
      );
      // Newest first by arrival; keep within the message count and storage limits.
      const next = [summary, ...list];
      let bytes = next.reduce((n, m) => n + m.storedBytes, 0);
      const evicted = [];
      while (
        next.length > 1 &&
        (next.length > MAIL_LIMITS.maxMessages ||
          bytes > MAIL_LIMITS.maxStoredBytes)
      ) {
        const old = next.pop();
        bytes -= old.storedBytes;
        evicted.push(old.messageId);
      }
      await this.writeSealed(
        path.join(this.dir, "index.sealed"),
        Buffer.from(JSON.stringify(next), "utf8"),
        "waterloo-outlook-index:v1",
      );
      this.index = Promise.resolve(next);
      for (const old of evicted)
        for (const kind of ["eml", "body"])
          await unlink(this.messageFile(old, kind)).catch(() => {});
      return { stored: true, duplicate: false, messageId: id };
    });
  }
  async summary(id) {
    const found = (await this.messages()).find((m) => m.messageId === id);
    if (!found) mailFail("MAIL_NOT_FOUND");
    return found;
  }
  async bodyText(id) {
    return (
      await this.readSealed(
        this.messageFile(id, "body"),
        "waterloo-outlook-body:v1:" + id,
      )
    ).toString("utf8");
  }
  async attachment(id, index) {
    const summary = await this.summary(id);
    const raw = await this.readSealed(
      this.messageFile(id, "eml"),
      "waterloo-outlook-message:v1:" + id,
    );
    const a = (await this.parse(raw, { attachmentsOnly: true })).attachments?.[
      index
    ];
    // Inline images referenced by the HTML body are not offered as attachments.
    if (!a || !summary.attachments.some((x) => x.index === index))
      mailFail("MAIL_NOT_FOUND");
    return {
      filename: typeof a.filename === "string" ? a.filename : "",
      contentType: String(a.contentType ?? "application/octet-stream"),
      content: a.content,
    };
  }
  async status() {
    const list = await this.messages();
    const deliveries = await this.deliveries();
    return {
      messageCount: list.length,
      storedBytes: list.reduce((n, m) => n + m.storedBytes, 0),
      newestReceivedAt: list[0]?.receivedAt ?? null,
      oldestReceivedAt: list.at(-1)?.receivedAt ?? null,
      lastRejectedAt: deliveries.find((d) => !d.stored)?.at ?? null,
      ...(await this.policy()),
      limits: {
        maxMessageBytes: MAIL_LIMITS.maxMessageBytes,
        maxMessages: MAIL_LIMITS.maxMessages,
        maxStoredBytes: MAIL_LIMITS.maxStoredBytes,
      },
    };
  }
}
