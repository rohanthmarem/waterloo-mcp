import {
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  stat,
  chown,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readConfig } from "../src/config.mjs";
import { tokenHash } from "../src/portable-auth.mjs";
let lock, file;
try {
  const config = readConfig();
  if (config.authMode !== "portable" || process.argv[2] !== "rotate")
    throw new Error("Use npm run owner -- rotate in portable mode.");
  file = path.join(config.secretsDir, "owner-auth.json");
  lock = await open(file + ".lock", "wx", 0o600);
  await readFile(file); // Rotation is not initialization.
  const tokenFile = path.join(config.home, "private/owner.token"),
    token = "wo1_" + randomBytes(32).toString("base64url");
  await writeFile(tokenFile + ".pending", token + "\n", { mode: 0o600 });
  await writeFile(
    file + ".pending",
    JSON.stringify({
      tokenHash: tokenHash(token),
      sessionKey: randomBytes(32).toString("hex"),
    }),
    { mode: 0o600 },
  );
  if (process.getuid?.() === 0) {
    const { uid, gid } = await stat(file);
    await chown(file + ".pending", uid, gid);
  }
  await rename(file + ".pending", file);
  await rename(tokenFile + ".pending", tokenFile);
  console.log(
    "Owner key rotated; all previous owner browser sessions are invalid. New key file: " +
      tokenFile +
      ". School encryption keys and agent tokens are unchanged.",
  );
} catch {
  console.error(
    "OWNER_ROTATION_FAILED: check portable setup and any owner-auth.json.lock; confirm no rotation is running before removing a stale lock.",
  );
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(file + ".lock");
  }
}
