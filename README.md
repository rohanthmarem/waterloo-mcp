# Waterloo MCP

Give your cloud agents access to your Waterloo LEARN courses, Piazza discussions, Odyssey assessment schedule, published course outlines, and library study-room bookings. Host on a Docker-capable computer or server and connect any MCP client that supports Streamable HTTP with a custom authentication header. Choose one user or several isolated users on the same device.

**Each person gets a separate instance and signs in with their own Waterloo account.** A shared host runs a separate container, keys, saved state, browser process, cache, and approvals for every user. Sharing this repository does not share an account, a session, or access to course material.

This is an unofficial personal project, based on [Rohan Muppa’s Brightspace MCP server](https://github.com/RohanMuppa/brightspace-mcp-server). It is not affiliated with Waterloo, D2L, Duo, Piazza, or exe.dev.

Optional: [Racket workspaces driven through MCP](docs/racket.md), with assignment text, code editing, test runs, and an owner browser view. Add `--racket` to a hosted user.

## What you get

- 34 tools for courses, announcements, grades, assignments, discussions, course content, outlines, Piazza, Odyssey, and library study rooms.
- Text extraction from HTML, PDFs and Office files; PDF page images for handwritten notes; local audio/video transcription.
- Separate tokens for your agents, with expiry and revocation.
- Browser approval before a tool saves a download, books a room, or cancels a booking. Agents cannot approve their own requests through their MCP token.
- Encrypted saved login state, repeatable Docker deployment, and errors with a code and a next step.

See [Piazza setup](docs/piazza.md), [study-room booking](docs/study-rooms.md) and [tool coverage and limits](docs/tools.md). Outlook mail is not included.

## Recommended: host on your chosen device

See [portable hosting and multi-user setup](docs/hosting.md). No exe.dev account is required.

| Mode                          | What runs                                                    | Authentication                                           |
| ----------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| One device, one user          | One container and one private data directory                 | Private owner key plus separate agent tokens             |
| One device, multiple users    | One isolated container and private data directory per person | Separate hostnames, keys, cookies, tokens, and approvals |
| Existing exe.dev installation | Existing personal deployment                                 | Original private exe.dev proxy and tokens                |

```sh
npm ci
npm run build
npm run host -- init --mode=single
npm run host -- add alice --origin=http://localhost:8001 --owner=alice@example.com --username=alice@uwaterloo.ca --port=8001
npm run host -- start
npm run host -- client alice issue school-agent
```

Use `--mode=multi` for a shared host, with a different HTTPS hostname per person. Users can send a verified login from their own computer to a headless host. `host audit --running` checks for shared keys/mounts and unsafe container settings; it reports failures and counts, not an assurance that the host cannot be compromised. The host administrator remains trusted. [Full instructions and limits](docs/hosting.md).

## exe.dev-specific setup

You need Node.js 22 or later, Git, OpenSSH with `ssh-keygen -Y sign`, and a local browser. Use macOS or Linux; Windows users should use WSL with working browser display support. Your exe.dev VM needs Docker and Docker Compose. Allow several GB of disk space for Chromium and transcription dependencies.

### 1. Install and configure

Download or clone this repository, then enter its directory:

```sh
npm ci
npm run setup
npm run build
npx playwright install chromium
```

Setup asks for:

| Setting                    | Example                   |
| -------------------------- | ------------------------- |
| Private exe.dev URL        | `https://YOUR-VM.exe.xyz` |
| Your exe.dev account email | `you@example.com`         |
| Your Waterloo login        | `youruserid@uwaterloo.ca` |

It creates `.env` and a `private/` directory with restricted file permissions. Both stay out of Git and Docker images. Keep this local directory for later login and token updates. Setup refuses to replace existing keys.

### 2. Sign in once

```sh
npm run login
npm run doctor
```

Complete the normal Waterloo sign-in and Duo prompt in the opened browser. Press Enter in the terminal when LEARN shows your homepage. The command checks the account through the LEARN API, then encrypts the saved session. It does not save your password.

The default mode reuses this session and attempts renewal using saved browser state. Waterloo can still require another sign-in. For the optional dedicated software authenticator experiment, see [unattended renewal](docs/authentication.md) **before deploying**.

### 3. Issue a token for an agent

Use an SSH key already registered to the exe.dev account that owns this VM:

```sh
npm run client -- issue school-agent /absolute/path/to/exe-ssh-key
```

The command prints the path to a token file under `private/clients/`. It does not print the token. Import that file into the agent host’s secret store. Keep your SSH private key on your computer.

Tokens expire after 90 days. Issue a different token for each agent. See [client setup](docs/clients.md).

### 4. Deploy through SSH

Keep the preview private and select the application port:

```sh
ssh exe.dev share set-private YOUR-VM
ssh exe.dev share port YOUR-VM 8000
npm run deploy -- YOUR-VM.exe.xyz init
```

The deploy command creates `/home/exedev/workspace/waterloo-mcp` on the VM, transfers code and encrypted state through SSH, builds the image, and starts Docker Compose. It refuses to replace an existing installation. Your saved state is mounted separately from the image.

The gateway trusts identity headers supplied by exe.dev’s authenticated proxy. **Use the private exe.dev preview; do not expose the raw application port or put this service behind an unconfigured public proxy.** [exe.dev proxy documentation](https://exe.dev/docs/proxy), [authentication headers](https://exe.dev/docs/login-with-exe).

### 5. Connect and verify

Open `https://YOUR-VM.exe.xyz/` while signed in to exe.dev. Add a remote MCP server to your agent:

```json
{
  "url": "https://YOUR-VM.exe.xyz/mcp",
  "headers": {
    "X-Exedev-Authorization": "Bearer <token from your secret store>"
  }
}
```

The exact configuration wrapper differs by client. The URL and header above are required. Clients with OAuth-only remote connections or no custom-header support need a compatible adapter.

Verify the transport, then make read-only Waterloo checks:

```sh
npm run smoke -- private/clients/YOUR-TOKEN-FILE.token
npm run smoke -- private/clients/YOUR-TOKEN-FILE.token --live
```

The first check lists tools. `--live` checks authentication, courses, and Odyssey. Success means those checks passed for your account; it does not prove every course resource is readable.

### 6. Connect Piazza (optional)

Open `https://YOUR-VM.exe.xyz/setup/piazza` as the owner. Enter your Piazza login and wait for **Piazza connected**. Refresh the MCP tool list, then call `check_piazza_auth` and `list_piazza_classes`. The encrypted login renews on the VM; your local computer can be offline. See [Piazza setup and limits](docs/piazza.md).

## Everyday use

| Task                               | Command                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| Check local setup                  | `npm run doctor`                                                                    |
| Refresh an expired login           | `npm run login`, then `npm run deploy -- YOUR-VM.exe.xyz session`                   |
| Add an agent                       | `npm run client -- issue NAME /absolute/path/to/exe-ssh-key`, then deploy `clients` |
| Revoke an agent                    | `npm run client -- revoke NAME`, then `npm run deploy -- YOUR-VM.exe.xyz clients`   |
| List agents without showing tokens | `npm run client -- list`                                                            |
| Deploy a code update               | `npm run deploy -- YOUR-VM.exe.xyz code`                                            |
| Test source changes                | `npm run check && npm run test:upstream`                                            |

When an action returns `APPROVAL_REQUIRED`, open its approval URL yourself. Review the tool and exact arguments. After approval, the same agent retries those arguments with `authorizationId`. Approval lasts 15 minutes and can be used once.

Read [error codes](docs/errors.md), [operations and recovery](docs/operations.md), [security](SECURITY.md), [verification results](docs/verification.md), and [performance measurements](docs/performance.md).

## Project layout

```text
gateway.mjs          Private HTTP MCP server and owner pages
authorization.mjs    Tool allowlist and one-use approvals
outlines.mjs         Course outline discovery
libcal.mjs           Study-room tools and encrypted booking history
piazza.mjs           Read-only Piazza classes, feeds, search, and discussions
src/                 Configuration, errors, bounded read cache
scripts/             Setup, login, client tokens, deploy, diagnostics
upstream/            Vendored MIT Brightspace client plus Waterloo readers
renew.mjs            Saved-session and optional authenticator renewal
tests/               Access, approval, error, cache and setup tests
bench/               Offline performance suite against a fake LEARN; see docs/performance.md
private/             Your local secrets and state; never shared
```

Release 0.4.0 adds portable authentication, single/multi-user hosting, remote login import, and isolation audits. The tool catalog remains at 34. Study-room booking still requires exact owner approval. See [contributing](CONTRIBUTING.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
