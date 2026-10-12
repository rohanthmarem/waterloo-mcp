import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { sha256, FILE_LIMIT } from "../src/crowdmark-files.mjs";

// Tokens stay in a protected file, never in command arguments or output.
const [command, filename, ticketUrl, tokenFile] = process.argv.slice(2);
try {
  if (!["inspect", "send"].includes(command) || !filename) throw Error("USAGE");
  if ((await stat(filename)).size > FILE_LIMIT) throw Error("FILE_TOO_LARGE");
  const bytes = await readFile(filename),
    type = await fileTypeFromBuffer(bytes);
  if (!["image/png", "image/jpeg"].includes(type?.mime))
    throw Error("JPEG_OR_PNG_REQUIRED");
  const metadata = {
    filename: path.basename(filename),
    mimeType: type.mime,
    size: bytes.length,
    sha256: sha256(bytes),
  };
  if (command === "inspect") console.log(JSON.stringify(metadata, null, 2));
  else {
    const origin = new URL(process.env.WATERLOO_ORIGIN ?? "");
    const url = new URL(ticketUrl);
    if (
      url.origin !== origin.origin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/crowdmark\/uploads\/[a-f0-9]{48}$/.test(url.pathname)
    )
      throw Error("UPLOAD_URL_REJECTED");
    if (!tokenFile) throw Error("TOKEN_FILE_REQUIRED");
    const token = (await readFile(tokenFile, "utf8")).trim();
    const header =
      process.env.WATERLOO_AUTH_MODE === "portable"
        ? "Authorization"
        : "X-Exedev-Authorization";
    const response = await fetch(url, {
      method: "PUT",
      redirect: "error",
      headers: { [header]: "Bearer " + token, "Content-Type": type.mime },
      body: bytes,
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw Error("UPLOAD_REJECTED_" + response.status);
    const data = await response.json();
    console.log(
      JSON.stringify({
        status: data.status,
        fileId: data.fileId,
        filename: data.filename,
        sha256: data.sha256,
      }),
    );
  }
} catch (e) {
  console.error(
    [
      "USAGE",
      "FILE_TOO_LARGE",
      "JPEG_OR_PNG_REQUIRED",
      "UPLOAD_URL_REJECTED",
      "TOKEN_FILE_REQUIRED",
    ].includes(e.message) || /^UPLOAD_REJECTED_\d+$/.test(e.message)
      ? e.message
      : "CROWDMARK_TRANSFER_FAILED",
  );
  console.error(
    "Usage: node scripts/crowdmark-upload.mjs inspect PHOTO\n       WATERLOO_ORIGIN=https://YOUR-HOST node scripts/crowdmark-upload.mjs send PHOTO APPROVED_UPLOAD_URL TOKEN_FILE",
  );
  process.exitCode = 1;
}
