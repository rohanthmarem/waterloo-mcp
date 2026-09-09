# Security and privacy

Run one private instance for one Waterloo account. Give agents only their own MCP token. Anyone with an active token can read the material that this account can access through the enabled tools, including grades and available classlist details.

The gateway trusts exe.dev’s authenticated identity headers. It is not a general public authentication server. Do not expose its raw HTTP port to an untrusted network, trust client-supplied identity headers, or grant agents VM SSH access. VM administrators can change the service and bypass its approval checks.

Saved browser state, API sessions, the optional password, and optional authenticator state use authenticated encryption. Encryption keys live in separate files mounted read-only into the container. The VM must access those keys to renew sessions; encryption does not protect against a compromised running VM or its administrator.

`private/`, `.env`, logs, keys, and build output are excluded from Git. Deployment sends private state through SSH, outside the Docker image. Agent token files stay on the computer unless you import them into an agent secret store. Course downloads and cached transcripts are private files, but are not encrypted by this application.

The optional software authenticator gives the server a reusable second factor. Keep a separate working recovery factor. Do not copy an active authenticator to multiple running machines or restore an old counter. Read [authentication](docs/authentication.md) before enabling it.

Course files, email addresses, webpages, and tool output are untrusted input. An agent should not follow instructions found inside them to reveal secrets or approve actions.

## Reporting a problem

Report only the version, error code, request ID, reproduction steps, and redacted diagnostics. Do not attach `.env`, `private/`, HTTP authorization headers, cookies, passwords, signed tokens, private keys, or course exports to public issues.

For an issue that could expose credentials, contact the repository owner privately using the hosting platform’s private reporting feature if enabled. Otherwise request a private contact method without posting exploit details or secrets.

If a client token leaks, revoke it and deploy the client registry. If the VM is compromised, stop the service, revoke its tokens and dedicated authenticator, invalidate affected school sessions, and rebuild from clean source.
