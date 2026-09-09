# Authentication and unattended renewal

## Default: saved session

`npm run login` opens a normal local Chromium browser. You enter your own password and complete Duo. The command verifies the Waterloo account through LEARN, then saves encrypted browser and API session data. It does not save your password or clone a personal passkey.

After deployment, the server can use the saved API session without a browser. If that session expires, it attempts a headless browser renewal using saved state. If Waterloo asks for credentials or another factor, it stops and requires a fresh login:

```sh
npm run login
npm run deploy -- YOUR-VM.exe.xyz session
```

A browser passkey is not a permanent API credential. Cookies can expire or be revoked. No configuration here can guarantee that Waterloo will never ask the account owner to sign in again.

## Optional experiment: a dedicated software authenticator

This mode was developed with one account in the predecessor deployment. It depends on Waterloo allowing registration and later use of a separate security key. It is not guaranteed for other accounts or future policy changes. Normal setup does not enable it.

The enrollment script uses Chromium’s virtual WebAuthn authenticator. This creates a **software-held security key**, not a physical security key or a copy of your Apple/1Password passkey. The server can perform its configured password and second-factor steps because it holds both credentials. Treat the VM accordingly, and retain a separate working factor for recovery.

Enable this only for your own account, through the normal Duo device-management process, where your account permits it:

1. Complete `npm run setup` and install Chromium locally.
2. Before the first deployment, run `npm run enroll` in an interactive terminal.
3. In the opened browser, sign in with your existing factor. Register a new security key and give it a name that clearly identifies this VM.
4. Finish the site’s registration. Press Enter in the terminal only after the site confirms the new key.
5. The script requires saved credential state before reporting success. It saves encrypted state under `private/state/authenticator/` and its key under `private/secrets/`.
6. Run `npm run login` to capture a normal LEARN session, then deploy with `init`.
7. Open your private service’s `/setup` page while signed in as the exe.dev owner. Enter your Waterloo password in that form. The server encrypts it; do not place it in chat or `.env`.
8. If you want the server to choose “Yes, this is my device” when Duo asks, set `WATERLOO_REMEMBER_DEVICE=true` in the VM’s `.env` and restart the container. The default is false.

Verify renewal on the VM, with the normal worker stopped so only one process can use the authenticator:

```sh
ssh YOUR-VM.exe.xyz
cd /home/exedev/workspace/waterloo-mcp
sudo docker compose stop mcp
sudo docker compose run --rm mcp node renew.mjs --fresh
sudo docker compose up -d
```

A successful `--fresh` check requires a fresh browser without saved cookies, an observed authenticator assertion, and successful LEARN identity and enrollment API calls. If it fails, do not claim unattended authentication works. Keep or restore normal interactive login while diagnosing the reported code.

## One active copy

Authenticator signature counters change after use. Only one running machine may own the current state. The deploy command marks the local copy as transferred before uploading private state. Local enrollment/renewal scripts reject that marker. Code and session updates do not upload authenticator state.

Do not remove the marker simply to retry enrollment. Do not copy the authenticator to multiple VMs or restore an old backup over a newer counter. If a transfer fails, determine whether the VM received state before taking recovery action. If ownership or counter state is uncertain, revoke that dedicated key in Duo and enroll a new one.

Renewal uses a process lock and a two-minute cooldown to avoid repeated sign-ins. A stale lock after a forced crash requires inspection; remove only the lock after confirming no renewal process remains. Do not delete the authenticator or its encryption key as a general troubleshooting step.
