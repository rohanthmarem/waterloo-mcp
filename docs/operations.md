# Operations and recovery

## Portable hosting

Run commands from the repository directory. Generated profiles live under `private/hosting/users/USER/`. Each profile has its own `.env`, `private/state/`, and `private/secrets/`; its owner and agent token files also remain private. The host manifest and generated Compose file live in `private/hosting/`.

```sh
npm run host -- status
npm run host -- doctor alice
npm run host -- audit --running
npm run host -- client alice list
npm run host -- client alice revoke school-agent
npm run host -- owner alice rotate
```

Use the profile's own owner key for `/login`, approval pages, `/setup/piazza`, and optional `/racket`. Never use another user's token file or restore their data into this profile. For an expired school session, follow [remote login](hosting.md#sign-in-from-a-different-computer).

To inspect or restart one user's services:

```sh
docker compose -f private/hosting/compose.json logs --tail 50 alice
docker compose -f private/hosting/compose.json restart alice
# Only when this user has Racket enabled:
docker compose -f private/hosting/compose.json logs --tail 50 racket_alice
docker compose -f private/hosting/compose.json restart racket_alice
npm run host -- audit --running
```

Logs are private diagnostics. Review and redact them before sharing. `host stop` stops all users. To stop just Alice, stop `alice` and, if enabled, `racket_alice` with Compose. A deliberately stopped service causes the running audit to fail. `host start` starts every configured user.

For code updates, back up private data first, update to the intended source revision, then run:

```sh
npm ci
npm run check
npm run host -- start
npm run host -- audit --running
```

Startup rebuilds services. Use `host render` when changing the host manifest; do not edit generated Compose settings directly. Enabling Racket adds another image and container. Its startup happens after the MCP services start, so a failed optional runner can leave school tools available. Inspect the reported error and running audit before retrying.

Interrupted admin commands retain their lock until the Docker subprocess exits. On `HOST_INTERRUPTED`, inspect status before retrying. On `HOST_ADMIN_BUSY`, wait for the active command; do not remove `.admin.lock` while a command or its subprocess is still running.

### Private backups and Racket recovery

Stop the affected user's MCP and runner before taking a consistent backup. Keep that profile's configuration, state, and matching encryption keys together in an encrypted backup destination. Protect the host manifest and any owner/agent token files separately as well. Do not mix profiles during restore.

Racket documents and latest results live under `private/state/racket/` within the profile. They are encrypted with that user's session key. A save clears the previous run result; there is no version-history, export, or delete MCP tool. Preserve needed revisions before replacing them. Disabling Racket hides its tools but retains workspace files.

For `RACKET_STATE_INVALID`, preserve the unreadable file and restore it only with its matching key. For `RACKET_STORAGE_UNAVAILABLE`, inspect free space and permissions. For a stale workspace lock after a crash, first stop the user's MCP and verify no run remains active; remove only the identified stale lock. Restart and audit afterward. Never clear state or a key as a general fix.

The runner needs no data backup: it stores no workspace documents or credentials. Keep the source and image version so it can be rebuilt. Authenticator backups have stricter counter rules; see [authentication](authentication.md#one-active-copy).

## Legacy exe.dev server state

On the VM:

```text
/home/exedev/workspace/waterloo-mcp/
  .env                          URL, owner, username; no password
  private/state/browser.json    Encrypted browser state
  private/state/sessions/       Encrypted LEARN API session
  private/state/password.json   Optional encrypted password
  private/state/authenticator/  Optional encrypted software key and locks
  private/state/approvals/      One-use approval records
  private/state/downloads/      Approved downloads
  private/state/transcripts/    Cached generated transcripts
  private/state/libcal/         Encrypted booking history and write lock
  private/state/racket/         Optional encrypted workspace documents and results
  private/state/models/         Downloaded transcription model
  private/secrets/session-key   Encryption key
  private/secrets/clients.json  Enabled clients and expiries, no bearer tokens
  private/secrets/authenticator-key  Optional second encryption key
```

The Docker process runs as user 1001, with read-only application files and secret mounts. Writable state belongs to user 1001. Secrets belong to root:1001 with directory mode 750 and file mode 640. Local files use mode 600. Do not solve permission problems with `chmod 777`.

The Compose port is bound to VM loopback and reached through exe.dev’s private proxy. Keep the preview private. This legacy Compose file serves one account. For multiple users on one device, use the portable host generator above, with separate profiles and hostnames.

## Legacy exe.dev: inspect and restart

```sh
ssh YOUR-VM.exe.xyz
cd /home/exedev/workspace/waterloo-mcp
sudo docker compose ps
sudo docker compose logs --tail 50 mcp
sudo docker compose restart mcp
```

The Docker health check proves the gateway responds and denies unauthenticated access. It does not verify your Waterloo session. `npm run smoke -- TOKEN_FILE --live` performs actual reads from the configured account.

A normal restart preserves state. Enable Docker at VM boot through the operating system’s service manager if it is not already enabled. Compose’s restart policy needs the Docker daemon running.

## Legacy exe.dev: updates

Update the local source and run the tests, then deploy only code:

```sh
npm ci
npm run check
npm run test:upstream
npm run deploy -- YOUR-VM.exe.xyz code
```

Code updates leave the remote `.env` and private state in place. Configuration edits are made explicitly on the VM. Client updates replace only `clients.json`. Session updates stop the worker, replace only browser and API sessions, repair permissions, and restart it. Use the same local installation and encryption key; a different key cannot decrypt the existing state.

Do not run `init` against an existing installation. If initial deployment fails, inspect the partially created directory and the local `private/DEPLOYED.txt` marker before retrying. Never blindly resend a potentially stale authenticator.

## Backups and retention

Back up the source separately from account data. For private data, stop the service and use an encrypted backup destination. Include `.env`, state, and both encryption keys if enabled. A backup of encrypted state without its key cannot be restored.

For an authenticator, restore only the newest state with confirmed ownership. Re-enroll a new dedicated key when its counter history is uncertain. Do not put backups in Git, a release ZIP, public issues, or agent prompts.

Downloads, transcripts, model files, and approval records persist until you remove them. Inspect disk space and prune old files according to your needs. Stop the service before manual maintenance. Keep active approval records and authentication files intact.

## Performance

Each user’s gateway shares a single Brightspace worker across that user’s clients and starts it as soon as the port opens. Expensive page, link, outline, and Odyssey reads share in-progress work and use a 30-second cache. That cache holds at most 32 entries, each no larger than 2 MiB, and permits four different expensive reads at once. Errors and approved writes are not cached there. The underlying Brightspace client also caches selected reads, holds at most 2000 cached responses, and sends at most 8 LEARN requests per second with a burst of 20, honoring any 429 Retry-After.

Page reads (`get_course_home`, `read_course_link`, `get_odyssey_schedule`) share one headless Chromium inside the worker. Each read gets a fresh isolated context that is closed when the read finishes; the browser process itself closes after 60 seconds without use. Playwright is loaded on first use, so an API-only session keeps about 70 MiB less resident memory in each process. Study-room checkout still launches its own browser for each approved booking. See [performance](performance.md) for measurements and how to rerun them.

A changed course page may take up to the relevant cache duration to appear. Restarting the service clears in-memory caches. Pagination prevents long texts from overwhelming a client. Transcription streams to temporary disk, limits input size and time windows, and runs one job at a time. Downloading the speech model on first use takes extra time and storage.

## Share a clean copy

Use a Git archive of a reviewed commit:

```sh
git archive --format=zip --prefix=waterloo-mcp/ -o waterloo-mcp.zip HEAD
```

Do not ZIP the working directory: ignored files can contain credentials. Review `git ls-files` before publishing and run the secret scan described in `docs/verification.md`. Share code; each recipient supplies their own account and chooses a private host or an isolated profile on a trusted shared host.
