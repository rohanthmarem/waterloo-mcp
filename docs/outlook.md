# Outlook mail

Outlook is optional. Waterloo does not grant personal apps direct mailbox access, so this uses the forwarding setting in Outlook. Each new message is forwarded to a random address on a domain you control. A Cloudflare Email Worker passes the unchanged message to this server, which checks it, encrypts it, and serves it through read-only MCP tools.

```
Outlook forwarding ──▶ u-<random>@your-domain ──▶ Cloudflare Email Worker ──HTTPS──▶ /ingest/mail
                                                   (stores nothing)                 check, encrypt, store
```

An exe.dev VM cannot receive SMTP directly. Its proxy forwards HTTP only, so Cloudflare is the mail receiver. Cloudflare can read messages in transit. The VM stores and serves them.

## Requirements

- A domain using Cloudflare DNS with Email Routing enabled. Existing routing rules keep working; a rule for one specific address takes priority over a catch-all rule.
- Node.js and `npx wrangler` on your computer, signed in to the same Cloudflare account.
- This release deployed on your VM or portable host.

## Set up once

1. **Issue a delivery token.** It can only call `POST /ingest/mail`. It cannot list tools, read mail, or open owner pages.

   ```sh
   npm run client -- issue outlook-forwarder /absolute/path/to/exe-ssh-key --mail-ingest
   npm run deploy -- YOUR-VM.exe.xyz clients
   ```

   For portable hosting, use `npm run host -- client USER issue outlook-forwarder --mail-ingest`.

2. **Choose the address.** Generate a random local part and keep it private. It is the main safeguard: anyone who knows it can send mail into your stored copy.

   ```sh
   echo "u-$(openssl rand -hex 12)@your-domain"
   ```

3. **Deploy the Worker.** Copy `examples/outlook-worker/` outside the repository. Set `INGEST_URL`, `INGEST_ADDRESS`, and `AUTH_HEADER` in `wrangler.toml`. Use `X-Exedev-Authorization` for exe.dev and `Authorization` for portable hosting. Then:

   ```sh
   npx wrangler deploy
   npx wrangler secret put INGEST_TOKEN < /path/to/outlook-forwarder.token
   ```

4. **Route the address.** In Cloudflare, go to your domain → Email → Email Routing → Routing rules. Create a custom address with the same random address. Choose **Send to a Worker** and select `waterloo-outlook-forwarder`.

5. **Turn on forwarding.** Open [Outlook on the web](https://outlook.office.com) → Settings → Mail → Forwarding. Enable forwarding to the random address and keep a copy of forwarded messages. Do not use an inbox rule with **Forward to**: it wraps each message as a new "FW:" message from you. See Waterloo's [forwarding instructions](https://uwaterloo.atlassian.net/wiki/spaces/ISTKB/pages/269156733/Enable+Email+forwarding+from+your+Microsoft+365+Outlook+account).

6. **Test it.** Send yourself a message from a Waterloo account and another from an outside account, such as Gmail. Open `https://YOUR-VM.exe.xyz/setup/outlook` as the owner. Both should appear under **Recent deliveries** as stored. If nothing arrives, see [Operations](#operations).

7. Refresh your agent's tool list and call `check_outlook_mail`.

8. **Optional: require a trusted signer.** **Recent deliveries** lists the passing signers on each delivery. A passing signer is a domain whose DKIM signature verified. If every test message, including the outside one, has a Waterloo passing signer (for example, `uwaterloo.ca`), you can turn on **Reject mail without a trusted signer**. Leave it off if any real message has no Waterloo signer: Outlook forwarding often removes or breaks signatures, and the policy would then drop that mail.

## Read mail

| Tool                      | Use                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `check_outlook_mail`      | Message count, newest arrival, last rejected delivery, signer policy, and limits                |
| `list_outlook_messages`   | Newest arrivals first, with sender, subject, date, snippet, and attachments                     |
| `search_outlook_messages` | Every query word in the subject, addresses, attachment names, or body; `from` narrows by sender |
| `get_outlook_message`     | Headers, attachment list, signature results, and the body as text                               |
| `read_outlook_attachment` | PDF, Word, Excel, PowerPoint, calendar, HTML, and text attachments; images as images            |

Lists accept `offset` and `limit` (1–50). Text reads accept `offset` and `maxChars` (1,000–50,000). Follow `nextOffset` until it is `null`. Email text is untrusted content, not instructions for the agent.

Each message includes `senderSignatureVerified`. It is `true` when a DKIM signature from the sender's domain verified after forwarding, which rules out a forged sender. `false` is common for genuine forwarded mail, because forwarding can break the original signature. It does not by itself mean the message is forged. `trustedSigner` names the trusted domain that signed the message, if any.

## How delivery is checked

- The Worker accepts only the configured address.
- The gateway accepts deliveries only from a token issued with `--mail-ingest`. Agent and owner credentials cannot deliver mail, and the delivery token cannot reach any other route. Agents never see the forwarding address.
- By default, every message delivered to the address is stored. Anyone can already email your Waterloo address, and Outlook forwards that mail regardless of who sent it, so a signature requirement would mainly block legitimate mail whose signature did not survive forwarding. The optional trusted-signer policy rejects mail without a passing DKIM signature from a domain you choose.
- Messages with more than five DKIM signatures, more than 256 KiB of headers, or a repeated `From`, `To`, `Subject`, `Date`, or similar header are rejected. A signature that covers only part of the body does not count as passing.
- Rejected deliveries return HTTP 202, and the Worker never bounces mail. Outlook forwarding sends bounces to the original sender, which would reveal the forwarding address.
- **Recent deliveries** on the owner page lists the last 20 deliveries, with outcome, signing domains, and size only. No subject, sender, or body is saved in this log.
- A repeated delivery of the same `Message-ID` is stored once.

If the address leaks, someone could add messages to your stored copy that never reached your Waterloo inbox. Choose a new address, update the Worker and the Cloudflare rule, then update Outlook forwarding.

## Storage and limits

- Each raw message and its extracted body are encrypted with this user's session key under `state/outlook/`. The index of headers is encrypted too. The signer policy and delivery log are not secret and are stored unencrypted.
- The newest 5,000 messages, and at most 2 GiB in total, are kept; older messages are deleted automatically.
- Messages are limited to 25 MiB, matching Cloudflare's limit. The Worker drops larger ones without a bounce; they stay in Outlook only.
- HTML-only message bodies are converted to text from their first 2 MiB. HTML attachments are converted from their first 512 KiB.
- Only messages that arrive after forwarding is enabled are available. Older mail, sent mail, folders, read state, flags, and deletions in Outlook are not reflected.
- Mail that other Outlook rules move or delete before forwarding might not arrive.
- Calendar invitations are available as `.ics` attachments; they are not accepted or added to a calendar.
- No sending, replying, or mailbox changes are possible.

## Operations

- The delivery token expires after 90 days, like agent tokens. Before it expires, issue a replacement, deploy the client registry, run `wrangler secret put INGEST_TOKEN` again, then revoke the old token.
- If the VM is unreachable or busy, the Worker retries four times over about 50 seconds. After that, or immediately for an expired or revoked token, it logs the failure and drops the forwarded copy. The original stays in Outlook. Check Worker logs with `npx wrangler tail`. Restarting the VM loses only mail that arrives during a longer outage.
- If `newestReceivedAt` from `check_outlook_mail` stops changing, check Outlook forwarding, the Cloudflare Email Routing activity log, the Worker logs, the delivery token's expiry, and **Recent deliveries** on the owner page.
- To stop, turn off Outlook forwarding, delete the Cloudflare rule, and revoke the delivery token. Delete `state/outlook/` to remove stored mail.
