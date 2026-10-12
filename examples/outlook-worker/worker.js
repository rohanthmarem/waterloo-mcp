// Cloudflare Email Worker: passes forwarded Outlook mail, unchanged, to Waterloo MCP.
// It stores nothing. See docs/outlook.md for setup.
//
// Variables (wrangler.toml):  INGEST_URL, INGEST_ADDRESS, AUTH_HEADER
// Secret (wrangler secret put): INGEST_TOKEN — a token issued with --mail-ingest
//
// Outlook forwarding rewrites the return path to the original sender, so a rejected
// or failed delivery would bounce to that sender and reveal the forwarding address.
// Mail for the configured address is therefore never rejected. If the server cannot
// take it, the failure is logged and this copy is dropped; the original stays in Outlook.

const MAX_BYTES = 25 * 1024 * 1024;
const RETRY_DELAYS_MS = [1000, 5000, 15000, 30000];

export default {
  async email(message, env) {
    if (!env.INGEST_URL || !env.INGEST_ADDRESS || !env.INGEST_TOKEN)
      throw new Error("Worker is not configured; see docs/outlook.md.");
    // Only the configured secret address is accepted; other domain rules are unaffected.
    if (message.to.toLowerCase() !== env.INGEST_ADDRESS.toLowerCase()) {
      message.setReject("Unknown recipient");
      return;
    }
    if (message.rawSize > MAX_BYTES) {
      console.error(`Dropped a ${message.rawSize}-byte message over 25 MiB.`);
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    let lastStatus = "network error";
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      let response;
      try {
        response = await fetch(env.INGEST_URL, {
          method: "POST",
          headers: {
            "Content-Type": "message/rfc822",
            [env.AUTH_HEADER || "X-Exedev-Authorization"]:
              "Bearer " + env.INGEST_TOKEN,
          },
          body: raw,
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        continue;
      }
      // 200 stored, 202 received but not stored (shown on /setup/outlook).
      if (response.ok) return;
      lastStatus = String(response.status);
      // Authentication and request errors need the owner, not a retry.
      if (response.status < 500 && response.status !== 429) break;
    }
    console.error(
      "Waterloo MCP did not accept a message (" +
        lastStatus +
        "). Check the delivery token and /setup/outlook.",
    );
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
