# Quickstart — building and checking the mobile console

## 1. Prerequisites

Node 18+ (Node 22 is installed on the Pi) and a running `copilot-web` service to copy the
page from. You need its basic-auth password for the build step.

```bash
cd ~/src/copilot-web
npm install
```

## 2. Generate the page

```bash
TTYD_AUTH='admin:YOUR_PASSWORD' npm run build
```

Re-run this after any **ttyd upgrade**; the page embeds a copy of ttyd's bundle.

Expected output:

```
Generated web/index.html (728 KB) from http://localhost:7681/
```

## 3. Run the tests and lint

```bash
npm test      # 12 jsdom tests
npm run lint  # syntax check
```

## 4. Preview without touching the live service

Serve the generated page on a spare port with a harmless command, then open it on your
phone over the LAN (`http://<pi-ip>:7694`):

```bash
ttyd -p 7694 -W -I web/index.html /bin/cat
```

Check that:

- the text is readable without zooming,
- the key bar is visible and tappable (44 px targets),
- `A+` / `A−` change the size and the choice persists after a reload,
- collapsing the bar (▾) frees the whole screen, and the ⌨ button brings it back.

Try the arrow keys against a real menu:

```bash
ttyd -p 7695 -W -I web/index.html /bin/bash
```

Run `select x in one two three; do echo "$x"; done`, then use the toolbar arrows and
`Enter` to pick an option.

## 5. Deploy

```bash
TTYD_AUTH='admin:YOUR_PASSWORD' npm run build
sudo ./install.sh
```

The installer prints a new password if `/etc/copilot-ttyd/env` had no credential, and shows
the rollback command.

## 6. Verify through the public URL

Open `https://oaiccopilot.duckdns.org`, log in, and confirm the key bar drives a Copilot
menu. If the WebSocket is rejected right after enabling `TTYD_CHECK_ORIGIN`, set
`TTYD_CHECK_ORIGIN=0` in `/etc/copilot-ttyd/env` and restart the service.

## Troubleshooting the build

| Message | Cause |
| --- | --- |
| `Cannot reach ttyd at ...` | The service is stopped; `systemctl start copilot-web`. |
| `Authentication failed (401)` | Wrong `TTYD_AUTH`. Use `user:password`. |
| `could not find the bundle <script> marker` | ttyd changed its page; inspect `web/stock-index.html` and adjust `BUNDLE_MARKER` in `build.mjs`. |
