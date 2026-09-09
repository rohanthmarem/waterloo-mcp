# Operations and recovery

## Server state

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
  private/state/models/         Downloaded transcription model
  private/secrets/session-key   Encryption key
  private/secrets/clients.json  Enabled clients and expiries, no bearer tokens
  private/secrets/authenticator-key  Optional second encryption key
```

The Docker process runs as user 1001, with read-only application files and secret mounts. Writable state belongs to user 1001. Secrets belong to root:1001 with directory mode 750 and file mode 640. Local files use mode 600. Do not solve permission problems with `chmod 777`.

The Compose port is bound to VM loopback and reached through exe.dev’s private proxy. Keep the preview private. The package is not a multi-user service: deploying several instances needs separate VMs, owners, keys, and sessions.

## Inspect and restart

```sh
ssh YOUR-VM.exe.xyz
cd /home/exedev/workspace/waterloo-mcp
sudo docker compose ps
sudo docker compose logs --tail 50 mcp
sudo docker compose restart mcp
```

The Docker health check proves the gateway responds and denies unauthenticated access. It does not verify your Waterloo session. `npm run smoke -- TOKEN_FILE --live` performs actual reads from the configured account.

A normal restart preserves state. Enable Docker at VM boot through the operating system’s service manager if it is not already enabled. Compose’s restart policy needs the Docker daemon running.

## Updates

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

The gateway shares a single Brightspace worker across clients. Expensive page, link, outline, and Odyssey reads share in-progress work and use a 30-second cache. That cache holds at most 32 entries, each no larger than 2 MiB, and permits four different expensive reads at once. Errors and approved writes are not cached there. The underlying Brightspace client also caches selected reads.

A changed course page may take up to the relevant cache duration to appear. Restarting the service clears in-memory caches. Pagination prevents long texts from overwhelming a client. Transcription streams to temporary disk, limits input size and time windows, and runs one job at a time. Downloading the speech model on first use takes extra time and storage.

## Share a clean copy

Use a Git archive of a reviewed commit:

```sh
git archive --format=zip --prefix=waterloo-mcp/ -o waterloo-mcp.zip HEAD
```

Do not ZIP the working directory: ignored files can contain credentials. Review `git ls-files` before publishing and run the secret scan described in `docs/verification.md`. Share code; each recipient supplies their own VM and account.
