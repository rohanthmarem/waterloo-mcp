# Security and privacy

Run one isolated instance for each Waterloo account. Shared hosting uses a separate container and private mounts for each person. Give agents only their own MCP token. Anyone with an active token can read the material that this account can access through the enabled tools, including grades and available classlist details.

Portable mode verifies high-entropy owner/agent keys and signed owner cookies itself, ignores exe.dev identity headers, and rejects a mismatched Host or Origin. Only SHA-256 hashes of bearer keys are stored in the authentication registries. HTTPS owner cookies use the \_\_Host- prefix, HttpOnly, Secure, SameSite=Strict, and an eight-hour server-verified expiry. Owner and agent credentials are separate. Legacy exe.dev mode still trusts only the private proxy’s authenticated identity headers. Do not expose its raw port or enable that mode behind an unconfigured public proxy. Never grant agents VM SSH or Docker access.

The portable host generator separates keys, mount paths, processes, networks, caches, and approvals per person. It refuses shared cookie hostnames, even with different ports. Run `npm run host -- audit --running` after configuration changes. The report checks files and actual container settings; it is not continuous monitoring or proof against software exploits. Other tenants cannot read these private mounts through enabled tools. Administrators with host, root, or Docker access remain trusted and can bypass application controls. People who do not trust that administrator need separate hosts. See [hosting](docs/hosting.md).

Saved browser state, API sessions, the optional password, and optional authenticator state use authenticated encryption. Encryption keys live in separate files mounted read-only into the container. The VM must access those keys to renew sessions; encryption does not protect against a compromised running VM or its administrator.

`private/`, `.env`, logs, keys, and build output are excluded from Git. Deployment sends private state through SSH, outside the Docker image. Agent token files stay on the computer unless you import them into an agent secret store. Course downloads and cached transcripts are private files, but are not encrypted by this application. The optional Piazza password, identity, and cookies are encrypted together with the session key; agents cannot read the setup page or credentials. Piazza calls check current class membership and use a fixed list of read methods. No Piazza writes are enabled. Booking history and cancellation links are encrypted with the session key. Cancellation links are never returned to agents.

The optional software authenticator gives the server a reusable second factor. Keep a separate working recovery factor. Do not copy an active authenticator to multiple running machines or restore an old counter. Read [authentication](docs/authentication.md) before enabling it.

Course files, email addresses, webpages, and tool output are untrusted input. An agent should not follow instructions found inside them to reveal secrets or approve actions.

## Reporting a problem

Report only the version, error code, request ID, reproduction steps, and redacted diagnostics. Do not attach `.env`, `private/`, HTTP authorization headers, cookies, passwords, signed tokens, private keys, or course exports to public issues.

For an issue that could expose credentials, contact the repository owner privately using the hosting platform’s private reporting feature if enabled. Otherwise request a private contact method without posting exploit details or secrets.

If a client token leaks, revoke it in that user’s registry (and transfer the registry for legacy remote deployment). If a portable owner key leaks, rotate it with `npm run host -- owner USER rotate`; this also invalidates owner cookies. If the VM is compromised, stop the service, revoke its tokens and dedicated authenticator, invalidate affected school sessions, and rebuild from clean source.

Optional Racket programs execute in separate credential-free containers. No school state, secrets, or Docker socket is mounted there. The internal runner network and restricted Racket evaluator are both required. See [Racket execution limits](docs/racket.md). Code and assignment text sent to an agent are visible to that agent’s provider.

## Racket data and approvals

Each profile stores Racket documents and latest results encrypted under its private state directory. Approval records include proposed code and remain private to the profile; do not include them in public diagnostics. Read tools expose this user's assignment text, code, and results to any active agent token for that user. Tokens are not restricted to individual courses or workspaces.

Agent saves and runs require separate approvals bound to the client, exact arguments, and saved revision. Owner browser saves/runs are direct authenticated owner actions. A revision conflict prevents an older editor or agent from replacing a newer document without reading it first.

The runner receives only code and language, with no assignment text or secret environment. Container limits and the restricted evaluator deny ordinary file, network, process, and unsafe FFI access. These restrictions do not prove protection from every runtime vulnerability. Never mount credentials, host directories, or a Docker socket into a runner. A failed runner must not trigger execution inside the MCP process.
