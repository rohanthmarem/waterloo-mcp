import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const tokenHash = (token) =>
  createHash("sha256").update(token).digest("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieName = (config) =>
  config.origin.startsWith("https:")
    ? "__Host-waterloo_owner"
    : "waterloo_owner";
const lifetime = 8 * 3600000;
export async function provisionOwner(secretsDir, tokenFile) {
  const token = "wo1_" + randomBytes(32).toString("base64url");
  await writeFile(
    path.join(secretsDir, "owner-auth.json"),
    JSON.stringify({
      tokenHash: tokenHash(token),
      sessionKey: randomBytes(32).toString("hex"),
    }),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
}
export class PortableAuth {
  constructor(config) {
    this.config = config;
    this.failures = [];
  }
  async owner() {
    const owner = JSON.parse(
      await readFile(
        path.join(this.config.secretsDir, "owner-auth.json"),
        "utf8",
      ),
    );
    if (
      !/^[a-f0-9]{64}$/.test(owner.tokenHash) ||
      !/^[a-f0-9]{64}$/.test(owner.sessionKey)
    )
      throw new Error("CONFIG_INVALID");
    return owner;
  }
  validHost(req) {
    return req.headers.host === new URL(this.config.origin).host;
  }
  sign(payload, key) {
    return createHmac("sha256", Buffer.from(key, "hex"))
      .update(this.config.origin + "\nowner-session:v1\n" + payload)
      .digest("base64url");
  }
  async login(token) {
    this.failures = this.failures.filter((t) => t > Date.now() - 60000);
    const owner = await this.owner();
    if (typeof token === "string") token = token.trim();
    if (
      typeof token !== "string" ||
      !equal(tokenHash(token), owner.tokenHash)
    ) {
      if (this.failures.length >= 10) throw new Error("LOGIN_RATE_LIMITED");
      this.failures.push(Date.now());
      throw new Error("AUTH_REQUIRED");
    }
    const payload = Buffer.from(
      JSON.stringify({
        exp: Date.now() + lifetime,
        nonce: randomBytes(16).toString("hex"),
      }),
    ).toString("base64url");
    return `${cookieName(this.config)}=${payload}.${this.sign(payload, owner.sessionKey)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime / 1000}${this.config.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  async authenticate(req) {
    // An explicit bearer token takes precedence. Never fall back to an owner cookie
    // when an invalid/revoked agent token was supplied in the same request.
    if (req.headers.authorization !== undefined) {
      const token = req.headers.authorization.match(
        /^Bearer ([A-Za-z0-9_-]{40,100})$/,
      )?.[1];
      if (!token) return null;
      const digest = tokenHash(token);
      const owner = await this.owner();
      if (equal(digest, owner.tokenHash))
        return { role: "owner", id: "owner-browser" };
      const clients = JSON.parse(
        await readFile(
          path.join(this.config.secretsDir, "clients.json"),
          "utf8",
        ),
      );
      const client = clients.find(
        (c) =>
          c.enabled && c.expiresAt > Date.now() && equal(digest, c.tokenHash),
      );
      return client ? { role: "mcp", id: client.id } : null;
    }
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName(this.config) + "="))
      ?.slice(cookieName(this.config).length + 1);
    if (!cookie || cookie.length > 1000) return null;
    const [payload, signature, extra] = cookie.split(".");
    const owner = await this.owner();
    if (extra || !equal(signature, this.sign(payload, owner.sessionKey)))
      return null;
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      return Number.isFinite(value.exp) &&
        value.exp > Date.now() &&
        value.exp <= Date.now() + lifetime
        ? { role: "owner", id: "owner-browser" }
        : null;
    } catch {
      return null;
    }
  }
}
