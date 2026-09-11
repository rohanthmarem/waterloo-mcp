# Host on your own device

Use one Docker-capable computer or server. Choose **single** for one Waterloo account, or **multi** for several people on the same machine. Both modes run one container per person. Each person can connect several agents using separate revocable tokens.

## Requirements and tested limits

- Node.js 22+, Git, Docker Engine with Compose v2 on Linux, or Docker Desktop/another Linux container runtime on macOS or Windows. On Windows, run these commands inside WSL2 and keep private files in its Linux filesystem, where restrictive file permissions work.
- Budget several GB for the image and at least 2 GB RAM per active user, plus memory for the host. The generated configuration limits each container to 2 CPUs, 2 GB RAM, and 512 processes. Large transcription jobs may need a reviewed limit change; an audit rejects manual changes until the generator is updated to match.
- The pinned Playwright base image supplies Linux AMD64 and ARM64 variants. The complete application still needs platform-compatible transcription dependencies. See [verification](verification.md) for the platforms actually tested; do not interpret a manifest entry as an end-to-end ARM test.
- A browser-capable computer for the initial Waterloo/Duo login. A headless server receives that login through the owner-authenticated HTTPS import described below. Phones and tablets can use the owner pages but are not supported as Docker hosts or login-CLI devices.
- For remote access, use a hostname and HTTPS reverse proxy, such as Caddy. No exe.dev account or SSH signing key is needed for portable mode.

The [Playwright Docker guidance](https://playwright.dev/docs/docker) describes its supported container environment. Alpine/native Windows containers are not a supported browser runtime for this package. Docker isolates user processes and mounts; it is not a guarantee against a host or browser exploit. Keep the host, image, and browser dependencies updated.

## One device, one user

From the repository directory:

```sh
npm ci
npm run build
npm run host -- init --mode=single
npm run host -- add alice --origin=http://localhost:8001 --owner=alice@example.com --username=alice@uwaterloo.ca --port=8001
npm run host -- start
npm run host -- client alice issue school-agent
```

`alice` is a local profile name. Replace the owner email and Waterloo username with the real account. Setup prints the private owner-key file path, never the key itself. The client command prints a different token-file path for the agent.

Open `http://localhost:8001/login` on this computer and enter the key from `private/hosting/users/alice/private/owner.token`. Store the key in your password manager. It grants owner access to this instance, including write approvals; **never give it to an agent**. Local HTTP is allowed only for loopback use. For a server that other devices will access, use the HTTPS URL and proxy instructions below instead.

## One device, several users

On a fresh checkout, initialize with `--mode=multi`, then add each person:

```sh
npm run host -- init --mode=multi
npm run host -- add alice --origin=https://alice.school.example.com --owner=alice@example.com --username=alice@uwaterloo.ca --port=8001
npm run host -- add bob --origin=https://bob.school.example.com --owner=bob@example.com --username=bob@uwaterloo.ca --port=8002
npm run host -- start
npm run host -- client alice issue alice-agent
npm run host -- client bob issue bob-agent
```

Every user needs a distinct hostname, owner email, Waterloo account, and host port. Two ports on `localhost` are **not** separate cookie scopes, so multi-user setup rejects that arrangement. The same single-user generator is used for both modes; `single` simply refuses a second account.

The administrator securely delivers each owner key to its intended person and imports each agent token into the corresponding agent host's secret store. Do not collect everyone's Waterloo passwords in chat. Users sign in to their own Waterloo accounts on their own computers.

To expand an existing single-user host, stop it, change only `mode` to `multi` in `private/hosting/host.json`, then run `host render` and add the new user. Keep existing profile directories and encryption keys. Do not initialize a second host over existing data.

## HTTPS and routing

Setup generates `private/hosting/Caddyfile`. Its blocks route each hostname to that user's loopback port:

```caddyfile
https://alice.school.example.com {
  reverse_proxy 127.0.0.1:8001
}
https://bob.school.example.com {
  reverse_proxy 127.0.0.1:8002
}
```

Configure DNS, install Caddy on the host, and merge these blocks into its configuration. Validate and reload Caddy using its normal service commands. Do not overwrite an existing proxy configuration without preserving its other sites. For other proxies, terminate TLS and preserve the original `Host` header. See [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Only the HTTPS proxy should accept remote connections. The containers bind to `127.0.0.1`, not all host interfaces. Portable mode verifies its own tokens and ignores exe.dev identity headers. It does not trust a client to choose a user via a path, header, or tool argument.

## Sign in from a different computer

On a computer that can open a browser, install this repository and Playwright:

```sh
npm ci
npm run build
npx playwright install chromium
npm run login -- --remote=https://alice.school.example.com --token-file=/absolute/private/path/alice-owner.token
```

This command verifies the owner key against that instance before opening the browser. Complete Waterloo login and Duo, then press Enter in the terminal. The server checks `whoami` against its configured Waterloo username before saving anything, strips unrelated browser origins, and encrypts the login with that user's key. A wrong account is rejected. Encryption keys and authenticator state never leave the host through this flow. Browser state is held in memory on the login computer and sent over the authenticated HTTPS connection; the command does not write it to disk there.

For login on the same desktop that hosts the containers, use `npm run host -- login alice` after installing Chromium locally and starting the service. It imports through the running service so the worker reloads the login. Do not run that command on a headless server expecting a browser window. The imported session can expire or require another Duo challenge; repeat the remote-login command when needed. This change does not promise permanent unattended Waterloo access or silently enroll another factor.

Connect Piazza separately at `https://alice.school.example.com/setup/piazza`, after owner sign-in. Its encrypted password and cookies live only in Alice's container mounts. See [Piazza](piazza.md).

## Connect any compatible agent

Use the token issued for this user and agent, with the standard Authorization header:

```json
{
  "url": "https://alice.school.example.com/mcp",
  "headers": {
    "Authorization": "Bearer <Alice's agent token from the secret store>"
  }
}
```

This supports clients with Streamable HTTP and custom headers. OAuth-only clients still need an adapter; this release does not implement OAuth discovery or registration. The old `X-Exedev-Authorization` header is used only by legacy exe.dev mode.

Call `check_auth` and `get_my_courses`. If Piazza is connected, call `check_piazza_auth` too. Owner pages are not available to agent tokens. A write returns the approval URL for that user's hostname; the user signs in there and approves the exact request. Tokens, cookies, and approval IDs from another profile are rejected.

## Operate and check isolation

```sh
npm run host -- status
npm run host -- audit
npm run host -- audit --running
npm run host -- client alice revoke alice-agent
npm run host -- owner alice rotate
npm run host -- doctor alice
```

The audit prints JSON with `scope`, `users`, `checksPassed`, `checksTotal`, `passed`, and `findings`. It never prints keys or their hashes. Treat **any finding as a failed check**, not as a partially acceptable percentage. `start` refuses failed file checks and runs the container checks after startup. A runtime failure is reported, not silently repaired or dismissed.

- File checks detect duplicate identities/hostnames, shared or symbolic-link directories, duplicate encryption/owner/agent keys, loose key permissions, and changes to the generated Compose configuration.
- Running-container checks verify the actual user containers, exact private mounts, read-only secrets/root filesystem, non-root process, dropped capabilities, separate network/process settings, resource limits, and loopback-only ports.
- These are configuration checks, not a penetration test, continuous monitoring, or proof that a compromised host cannot leak secrets. Run the audit after administrative changes. No Docker socket is exposed inside the application.

Owner-key rotation invalidates previous owner keys and owner cookies, while keeping school encryption keys and agent tokens. Agent revocation affects subsequent requests for that user immediately. Owner browser sessions expire after eight hours. A failed owner-form sign-in is limited to ten attempts per minute per instance.

To stop one person's service, use `docker compose -f private/hosting/compose.json stop alice`. Revoke their agent tokens as well. `host stop` stops the whole host. Keep booking records until uncertain bookings are resolved. There is no automatic deletion of user data.

Update source, install dependencies, build, and run `host start` to rebuild containers. Run `host render` only when you intend to regenerate Compose/Caddy files from the manifest. Back up each profile separately with its matching encryption keys, stored securely outside the source repository. Never restore an old active software-authenticator counter or run its copy on two hosts.

## Who must be trusted

Other users and their agents receive no access to each other's keys, state, browser processes, caches, or approval records. **The host administrator and anyone with Docker/root access remain trusted:** they can read mounted keys or change the application. A person who does not trust the administrator should deploy their own host. This release does not provide hardware enclaves or protection from a compromised operating system.

Existing exe.dev installations keep their original authentication mode unless deliberately migrated. Do not copy the existing personal deployment's credentials into a multi-user demo or new person's profile.
