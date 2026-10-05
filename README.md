# copilot-web

A mobile-friendly front-end for the **GitHub Copilot CLI running on the Raspberry Pi**,
served by [ttyd](https://github.com/tsl0922/ttyd) at `https://oaiccopilot.duckdns.org`.

ttyd's stock page was built for a desktop browser on a LAN: it ships **no responsive
viewport meta** (so phones render a ~980 px page scaled down to unreadable text) and it has
**no on-screen key controls**, so Copilot's interactive `↑/↓/←/→` menus cannot be driven
from a touch screen.

This project generates a patched ttyd page that fixes both, without forking ttyd and
without running any extra service.

## What the overlay does

| Problem | Fix |
| --- | --- |
| Text unreadably small | Injects `viewport` + `viewport-fit=cover`, raises the terminal default font and adds `A− / A+ / ↺` controls (4–32 px, persisted in `localStorage`). Each press updates the live terminal, repaints it and mirrors the size into `?fontSize=`, so the buttons keep responding instead of re-applying a stale size; a button that cannot change the size is disabled. |
| Copilot menus unusable on touch | A `role="toolbar"` key bar with `← ↑ ↓ →`, `Enter`, `Esc`, `Tab`, `Shift+Tab`, `Ctrl+C`, `Ctrl+D`, `PgUp`, `PgDn`. Only the key pad scrolls sideways, so the text-size controls stay on screen on a narrow phone. |
| Silent failures | ARIA live status pill: "Connecting…" → hidden when connected, "Disconnected — tap Reconnect" with a button on close/error, and a timeout message if no connection is ever made. |
| Toolbar covering the terminal | Collapsible bar that reserves space (`--cw-keyspace`) and re-fits the terminal, plus safe-area insets for iPhone. |
| Keys too big, arrows that vanish, bar too tall | One compact row of shrinking keys (`flex-wrap: nowrap`) — `← ↑ ↓ →`, `Enter`, `Esc`, `A−`, `A+` — that cannot wrap, scroll out of reach or be pushed off screen. The less-used keys (`Tab`, `Shift+Tab`, `Ctrl+C`, `Ctrl+D`, `PgUp`, `PgDn`, `↺`) sit behind the `⋯` button: 39 px tall by default, 72 px when expanded. |
| Vertical bar / dead space down the right edge | That was xterm's scrollbar: xterm always reserves one (`overflow-y: scroll`) and the overlay used to theme it, which cost 10px of the grid's width on top of ttyd's own 5px padding on `.terminal`. Nothing here scrolls through it — the transcript is scrolled by the CLI's own wheel — so it is now hidden (`scrollbar-width: none`) and the padding zeroed, which gives the grid roughly a column and a half of width back. Both rules are scoped to `#terminal-container`, not to `.xterm`, because ttyd fits the terminal *while* xterm is adding its class, so `.xterm …` rules are not in force yet at the moment the size is measured. |
| No vertical scroll | There is no scrollback to scroll: the TUI renders in the **alternate screen**, where tmux keeps no history (`history_size` measured **0**), so xterm is left with nothing either. Drop `smcup`/`rmcup` from `terminal-overrides` and the history is still empty — the lines are lost *inside* tmux's pane, not at the terminal. What does work is the wheel the TUI implements itself: mouse support is left on (`--mouse on`, alt screen mode only) and tmux's own `mouse` option is kept **off** so tmux passes the event through to the CLI, which scrolls its transcript (measured: one notch = 3 lines). |
| Swiping does nothing on a phone | xterm skips *both* of its touch handlers while mouse reporting is active (`if (!coreMouseService.areMouseEventsActive)` in `touchstart` and `touchmove`), so a swipe never reaches the TUI. The overlay therefore watches the stream for the mouse protocol and the SGR (1006) encoding, and turns a vertical swipe into the same report a desktop wheel sends — SGR button 64/65 at the touched cell — on the existing socket. Cells are located from the size ttyd's client reports (`{"AuthToken":…,"columns":…,"rows":…}` on open, then a `1`+JSON RESIZE frame on every relayout), not from the DOM, because ttyd defaults to the webgl renderer where there is no node per row; the last row is avoided, since tmux draws its status line there and swallows a wheel aimed at it. One notch is sent per three cells of finger travel, the distance one notch scrolls the transcript. Without mouse reporting the swipe is left to xterm. |

### How the keys reach Copilot

`web/overlay.js` is inlined **before** ttyd's own bundle so it can wrap `window.WebSocket`
and capture the connection ttyd opens. Tapping a button sends a ttyd protocol `INPUT` frame
(`0x30` + UTF-8 payload) over that **existing, already-authenticated** socket.

Reusing the socket is deliberate: a second connection would register a second ttyd client
and could resize the shared tmux window.

## Layout

```
web/overlay.js        key bar, font controls, status, WebSocket capture
web/overlay.css       toolbar / status styles
web/build.mjs         fetches ttyd's page and inlines the overlay -> web/index.html
web/index.html        build artifact (git-ignored); regenerate with `npm run build`
diagnose.sh           read-only end-to-end check: ttyd -> proxy -> public endpoint
test-service.sh       curl pass/fail checks of the same chain
systemd/              unit + launcher wrapper using /etc/copilot-ttyd/env
install.sh            idempotent installer (run with sudo)
deploy/               one-off maintenance scripts (run with sudo); see below
deploy/nginx-cookie-auth.conf, deploy/apply-cookie-auth.sh
                      cookie auth for the ttyd instance behind a reverse proxy
deploy/enable-scroll.sh
                      re-asserts the setup transcript scrolling needs (mouse support
                      on, tmux `mouse` off) and restarts the service — see
                      Troubleshooting, "Cannot scroll the transcript"
tests/overlay.test.mjs  jsdom unit tests for the overlay
specs/001-copilot-web-usability/   spec, plan, tasks, quickstart
```

## Diagnose

Two read-only scripts, no sudo required. Run them first whenever the console
misbehaves, and again after any proxy change.

`diagnose.sh` walks the whole chain and reports where it breaks:

```bash
cd ~/src/copilot-web
./diagnose.sh                                    # defaults to the public host
./diagnose.sh http://192.168.0.156:7681          # or any other URL
```

It reports the service state, ttyd's auth mode (`-H` vs `-c`) and origin-check setting,
whether the local ttyd accepts a connection, whether the public endpoint authenticates
anyone, and then prints a verdict — including shouting if the endpoint is open to a forged
header.

`test-service.sh` is the curl equivalent, with pass/fail per check. Credentials come from
the environment so they never appear in `ps`:

```bash
./test-service.sh
COPILOT_USER=me COPILOT_PASS=secret ./test-service.sh
```

Expected outcome for a correctly protected service:

| Check | Expected |
| --- | --- |
| local page (header mode) | `200` |
| public page, anonymous | `401` |
| public page, forged `X-Copilot-Auth` | `401` (never `200`) |
| public WebSocket, anonymous | `401` |
| public page, authenticated | `200` |
| public WebSocket, authenticated | `101` |

A `407` on the authenticated checks means the proxy authenticated you but is **not**
injecting the header ttyd requires.

## Build & test

**Do not build against the installed service.** It runs with `-I web/index.html`, so it serves
the *already patched* page — `injectOverlay()` sees its own `id="cw-script"` marker and writes
the file back unchanged (`Already patched web/index.html`), silently regenerating nothing. The
build needs ttyd's embedded **stock** page, which only a ttyd started *without* `-I` provides.
This also means the installer cannot bootstrap itself: `copilot-web-run` exits if
`web/index.html` is missing, yet the build needs a running ttyd.

So build against a throwaway instance on a spare port:

```bash
npm install
npm test && npm run lint

# 1. temporary stock ttyd: no -I, so it serves its built-in page
ttyd -p 7682 -c tmp:build sleep 120 &

# 2. build from it (any credential works; it is a local throwaway)
TTYD_URL=http://127.0.0.1:7682/ TTYD_AUTH='tmp:build' npm run build

# 3. stop it, then install
kill %1
sudo ./install.sh
```

Add `--save-reference` to also keep `web/stock-index.html` for diffing after a ttyd upgrade.
`web/index.html` must be regenerated after a **ttyd upgrade** — it embeds a copy of ttyd's own
bundle. The same procedure applies: a fresh stock page can only come from a ttyd started
without `-I`.

## Configuration

Read from `/etc/copilot-ttyd/env` (mode `600`, loaded by the systemd unit):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TTYD_CREDENTIAL` | *(required unless header auth)* | `user:password` for HTTP basic auth. Visible in `ps`; prefer `TTYD_AUTH_HEADER`. |
| `TTYD_LISTEN` | `0.0.0.0` | Bind address. Installer sets the LAN IP. |
| `TTYD_PORT` | `7681` | Listen port. |
| `TTYD_INDEX` | `~/src/copilot-web/web/index.html` | Patched page to serve. |
| `TTYD_FONT_SIZE` | `16` | Initial terminal font size; `A−` goes down to 4 px. |
| `TTYD_SCROLLBACK` | `5000` | xterm scrollback size and tmux `history-limit`. |
| `TTYD_AUTH_HEADER` | *(empty)* | ttyd `-H`: trust this proxy-injected header instead of a credential. |
| `TTYD_AUTH_HEADER_VALUE` | *(generated)* | Shared value the proxy must inject; kept only for the proxy config. |
| `TTYD_NO_AUTH` | *(empty)* | Run ttyd with **no auth of its own**. Only set when a reverse proxy in front authenticates *and* ttyd is bound to loopback — see Cookie-based auth. The wrapper otherwise refuses to start, so a half-applied config cannot silently expose an unauthenticated shell. |
| `TTYD_CHECK_ORIGIN` | `1` | ttyd `-O`: reject cross-origin WebSocket upgrades. Set to `0` if iOS devices connect from a Home Screen icon (see Troubleshooting). |
| `TTYD_BASE_PATH` | *(empty)* | ttyd `-b`, if mounted behind a sub-path. |
| `COPILOT_BIN` | `~/.local/bin/copilot` | Command to expose. |
| `COPILOT_ARGS` | `--mouse on` | Extra CLI arguments. Mouse support must stay **on**: the wheel is the only way this TUI can be scrolled (`--mouse … Enable mouse support in alt screen mode`). `--no-mouse` overrides the CLI's own `mouse: true`, and nothing replaces it. |
| `COPILOT_TMUX_SESSION` | `copilot` | tmux session name (persists across reloads). |

## Deploy / upgrade

```bash
cd ~/src/copilot-web
TTYD_AUTH='admin:YOUR_PASSWORD' npm run build
sudo ./install.sh
```

If the console connects on desktop but not from an iPhone Home Screen icon, add
`--allow-ios` (see Troubleshooting for why):

```bash
sudo ./install.sh --allow-ios
```

To stop the password living in the process argument list, switch to proxy header
auth (this needs the proxy to inject the header, so do both together):

```bash
sudo ./install.sh --auth-header X-Copilot-Auth
# it prints the `proxy_set_header` line to add, plus a rate limit;
# the full snippet is in deploy/nginx-copilot.conf
```

The installer backs up the existing unit to `copilot-web.service.bak-<timestamp>`,
installs the wrapper to `/usr/local/bin/copilot-web-run`, adds any missing variables to
`/etc/copilot-ttyd/env` (generating and printing a new credential if none is set), then
reloads and restarts `copilot-web`.

Rollback:

```bash
sudo cp /etc/systemd/system/copilot-web.service.bak-<timestamp> /etc/systemd/system/copilot-web.service
sudo systemctl daemon-reload && sudo systemctl restart copilot-web
```

## Reverse proxy (nginx-proxy-manager)

The public host is `oaiccopilot.duckdns.org`, served by an
**nginx-proxy-manager (NPM) container on a separate N100 server**, which forwards to this
Pi on port 7681. Nothing about that proxy lives on the Pi: do not look for it here. Proxy
changes are made in the NPM web UI (port 81) on the N100.

### Proxy Host — Details

| Field | Value |
| --- | --- |
| Domain Names | `oaiccopilot.duckdns.org` |
| Scheme | `http` |
| Forward Hostname / IP | this Pi (e.g. `192.168.0.156`) |
| Forward Port | `7681` |
| Cache Assets | **off** |
| Block Common Exploits | **off** — its rules can reject terminal/WebSocket traffic |
| **Websockets Support** | **on** — mandatory; without it the console never connects |
| Access List | see *Authentication* below |

### SSL

Request a Let's Encrypt certificate, enable **Force SSL** and **HTTP/2**. The WebSocket
then becomes `wss://`, which ttyd's page derives automatically. Take care with HSTS
`includeSubDomains`/`preload` — it is hard to reverse.

### Advanced — this is what keeps a phone connected

```nginx
# NPM defaults to 60s. A phone that idles or locks its screen has the
# terminal killed; a focused desktop never notices.
proxy_read_timeout 7d;
proxy_send_timeout 7d;
proxy_connect_timeout 30s;

# Stream the terminal rather than buffering it.
proxy_buffering off;
```

Do **not** set `proxy_set_header Connection "close"`; it breaks the upgrade.

### Authentication

- **Simplest:** no Access List — ttyd's own basic auth (`TTYD_CREDENTIAL`) prompts the
  browser. Fewer moving parts, but the password stays visible in `ps` on the Pi.
- **Fallback (what `deploy/nginx-copilot.conf` assumes):** NPM authenticates and injects
  the header, so ttyd holds no password. Run `sudo ./install.sh --auth-header
  X-Copilot-Auth` on the Pi, attach an **Access List** to the proxy host, and add:

  ```nginx
  proxy_set_header X-Copilot-Auth "REPLACE_WITH_TTYD_AUTH_HEADER_VALUE";
  ```

  nginx replaces any client-supplied copy, which is what stops forgery.

  Note that an Access List is also `auth_basic`, so the browser must still send credentials
  on the WebSocket handshake. If iOS is failing at authentication, this alone will not cure
  it — see the troubleshooting entry below. Because the header only proves the request came
  through the proxy, and Basic auth is a weak gate for a shell, treat this as the *least*
  preferred option and read **Hardening** below before deploying it.

#### Reverting header auth

Go back to ttyd's own basic auth — useful as a fail-closed move, or to take the proxy out
of the equation while diagnosing:

```bash
cd ~/src/copilot-web
sudo ./install.sh            # no flags: reverts to TTYD_CREDENTIAL
```

It comments out `TTYD_AUTH_HEADER` / `TTYD_AUTH_HEADER_VALUE` and restores the existing
`TTYD_CREDENTIAL` line, so the previous password keeps working. If no credential was ever
stored, it generates one and prints it.

Then remove (or stop relying on) the `proxy_set_header X-Copilot-Auth` line in the proxy
host, since ttyd no longer wants that header — leaving it does no harm, but the Access List
is what will actually be authenticating.

Verify:

```bash
ps -eo args | grep "[t]tyd"        # expect -c admin:…, no -H
journalctl -u copilot-web -n 20 --no-pager | grep denied
```

> Historical note: before this was fixed, running `install.sh` with no flags left
> `TTYD_AUTH_HEADER` set, and `copilot-web-run` prefers `-H` whenever that variable exists
> — so the revert silently kept header mode while printing a new password that did nothing.
> The installer now clears the header explicitly.

#### Cookie-based auth — the fix that actually works on iOS

Basic auth cannot protect a WebSocket (see the troubleshooting entry below), so if you must
keep the public URL, authenticate with a **cookie** instead: cookies *are* sent on WebSocket
handshakes, which is exactly the property Basic auth lacks. Ready-made config:
**`deploy/nginx-cookie-auth.conf`**.

Note this is a **WebKit** limitation, not a Safari one. On iOS every browser — Chrome and
Firefox included — must use WebKit, so all of them fail identically; on desktop those browsers
use their own engines and therefore work. Switching browsers on the phone will not help; only
changing the credential type does.

The trick is that this runs **on the Pi**, so **nothing changes on the N100**: the block takes
over port 7681 (where the N100 already forwards) and ttyd moves to a loopback-only port
behind it.

```
browser -> N100 nginx (proxy to Pi:7681) -> this block on the Pi
        -> ttyd on 127.0.0.1:7682 (no auth of its own)
```

One command does the whole change, with automatic rollback if anything fails:

```bash
cd ~/src/copilot-web
sudo ./deploy/apply-cookie-auth.sh
```

It installs nginx if needed, reuses ttyd's **existing** credential as the login (so the
password does not change), generates the session secret, moves ttyd to loopback, and swaps the
port — restoring the previous configuration automatically if any step fails. It also verifies
and prints the revert command.

Expect a few seconds where nothing listens on 7681 during the swap. ttyd runs in tmux, so an
open console session survives the restart.

<details>
<summary>Or do it by hand</summary>

```bash
# 1. nginx + htpasswd tooling
sudo apt-get update && sudo apt-get install -y nginx apache2-utils

# 2. a login, and a session secret (keep the secret — anyone who learns it skips the password)
sudo htpasswd -c /etc/nginx/copilot.htpasswd YOURUSER
SECRET="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"

# 3. install the block, substituting the secret
sudo sed "s|<REPLACE_WITH_SESSION_SECRET>|$SECRET|g" \
  ~/src/copilot-web/deploy/nginx-cookie-auth.conf \
  | sudo tee /etc/nginx/conf.d/copilot.conf >/dev/null

# 4. move ttyd behind it: loopback only, new port, NO auth of its own
sudo sed -i 's|^TTYD_LISTEN=.*|TTYD_LISTEN=127.0.0.1|; s|^TTYD_PORT=.*|TTYD_PORT=7682|' /etc/copilot-ttyd/env
grep -q '^TTYD_PORT=' /etc/copilot-ttyd/env || echo 'TTYD_PORT=7682' | sudo tee -a /etc/copilot-ttyd/env
sudo sed -i 's|^TTYD_CREDENTIAL=|#TTYD_CREDENTIAL=|; s|^TTYD_AUTH_HEADER=|#TTYD_AUTH_HEADER=|' /etc/copilot-ttyd/env
# REQUIRED: copilot-web-run refuses to start with no auth configured, so opt in
# explicitly — without this line ttyd exits and the console stays down.
grep -q '^TTYD_NO_AUTH=' /etc/copilot-ttyd/env || echo 'TTYD_NO_AUTH=1' | sudo tee -a /etc/copilot-ttyd/env

# 5. start nginx and restart ttyd
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl restart copilot-web
```

</details>
> ⚠️ **Step 4 is security-critical.** ttyd ends up with **no authentication of its own**, so it
> must be bound to loopback and unreachable from the LAN or the N100. If it is ever bound to a
> routable address in that state, anyone who can reach the port has a shell.

Verify:

```bash
# ttyd must NOT be reachable from the LAN any more:
curl -s -o /dev/null -w "direct(no auth) %{http_code}\n" --max-time 5 http://192.168.0.156:7682/   # expect 000

# the gate redirects an unauthenticated browser to the login:
curl -s -o /dev/null -w "anon %{http_code}\n" --max-time 8 http://192.168.0.156:7681/             # expect 302

# a session cookie opens it, including the WebSocket:
NJ=$(mktemp)
curl -s -o /dev/null -c "$NJ" -u YOURUSER:PASS http://192.168.0.156:7681/cw-login
curl -s -o /dev/null -b "$NJ" -w "authed %{http_code}\n" --max-time 8 http://192.168.0.156:7681/ # expect 200
```

Then reload on the iPhone: it will prompt **once**, and unlike before the WebSocket will
connect, because the cookie rides the upgrade.

To revert: `sudo rm /etc/nginx/conf.d/copilot.conf`, restore `TTYD_LISTEN`/`TTYD_PORT` **and
the credential**, and **remove `TTYD_NO_AUTH`** in `/etc/copilot-ttyd/env`, then
`sudo systemctl restart copilot-web`.

> ⚠️ Do not leave `TTYD_NO_AUTH=1` in place while ttyd is bound to a routable address and no
> credential is set — that combination is an unauthenticated shell. The wrapper only lets
> no-auth through because of that flag, so removing it restores the fail-closed default.
> (The apply script's rollback does all of this for you.)

### ⚠️ Verify the overwrite — the endpoint is open without it

ttyd's `-H` only checks that the header is **present and non-empty**; it never validates the
value. That is deliberate, because the proxy is supposed to replace whatever the client sent.
**Until the overwrite is proven, anyone on the internet can open this console by adding the
header themselves** — an unauthenticated remote shell on the Pi. This is not hypothetical:
it was observed live, where `curl -H "X-Copilot-Auth: forged-by-anyone" …/ws` returned
`101 Switching Protocols` and streamed terminal data.

Check it after any proxy change:

```bash
# Must NOT be 200. Expect 401 (Access List) or 407 (ttyd, header missing).
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-Copilot-Auth: forged" https://oaiccopilot.duckdns.org/

# Real credentials must still work (expect 200).
curl -s -o /dev/null -w "%{http_code}\n" \
  -u USER:PASS https://oaiccopilot.duckdns.org/
```

`200` on the first command means the overwrite is **not** in effect. Common causes:

- the Advanced config was saved but nginx was never reloaded;
- the header was added to a different proxy host;
- the value is a **pass-through variable** (e.g. `$http_x_copilot_auth`) instead of a fixed
  secret — this produces exactly the dangerous pattern where a client-supplied value is
  honoured and an absent one is refused;
- **the directive landed in the wrong scope** — see below.

#### The scope trap (nginx-proxy-manager)

nginx inherits `proxy_set_header` from an outer block **only if the inner block defines none
of its own**:

> These directives are inherited from the previous configuration level if and only if there
> are no `proxy_set_header` directives defined on the current level.

NPM's generated `location /` block already defines `proxy_set_header Upgrade` and
`proxy_set_header Connection`, so a `proxy_set_header X-Copilot-Auth …` placed at **`server`
level is discarded entirely**. The symptom is a `407` *after* a successful login, with
nothing obviously wrong in the UI. Two places bite here: the Advanced tab should inject
inside `location /`, whereas files dropped in `/data/nginx/custom/server_proxy.conf` are
included at `server` level and will be ignored.

Confirm which block it landed in — `nginx -T` prints the fully expanded config:

```bash
C=$(docker ps --format '{{.Names}}' | grep -i proxy | head -1)
docker exec "$C" nginx -T 2>/dev/null | grep -n -B6 -A2 "X-Copilot-Auth"
```

It must appear **inside `location / { … }`**, together with `proxy_http_version 1.1;`.

`install.sh --auth-header … --public-url <url>` performs this check automatically and shouts
if it finds a bypass.

### Rate limiting

`limit_req_zone` is only valid in the `http` context. On the N100 host create/append
`/data/nginx/custom/http.conf` (the `./data` bind-mount):

```nginx
limit_req_zone $binary_remote_addr zone=copilot_login:10m rate=10r/m;
```

Then in the proxy host's Advanced tab:

```nginx
limit_req zone=copilot_login burst=5 nodelay;
limit_req_status 429;
```

That file is read only at startup — **restart the container**, not just save the UI.

### Applying and verifying

UI changes reload nginx on save; after editing `custom/http.conf` run
`docker restart nginx-proxy-manager` on the N100. From the Pi:

```bash
# HTTP + TLS + auth reach ttyd (expect 401 with: Basic realm="ttyd", or 200 without basic auth)
curl -sI https://oaiccopilot.duckdns.org/ | head -3

# WebSocket upgrade end-to-end: expect 101
# (502 = ttyd closed the upgrade, usually an origin or auth rejection)
curl -s -o /dev/null -w "%{http_code}\n" --http1.1 -u USER:PASS \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Protocol: tty" \
  https://oaiccopilot.duckdns.org/ws
```

## Hardening — prefer this over the proxy header

The `-H X-Copilot-Auth` scheme works, but it is fragile by design and should be treated as a
fallback, not the goal:

- ttyd's `-H` checks only that the header is **present and non-empty** — it never validates
  the value. ttyd therefore authenticates *nothing*; every request depends on the proxy
  replacing the client's header, and a single misconfiguration opens the shell.
- HTTP Basic (the Access List) is the wrong mechanism for WebSockets: browsers attach Basic
  credentials only after a `401` challenge *on that exact request*, which is why the upgrade
  is always the part that breaks.
- A shared password with no MFA and no per-user identity is a weak gate for what is, in the
  end, a **remote shell**.

The strongest move is to stop exposing the console to the internet rather than guard it.

### 1. Tailscale (recommended)

Put the Pi and the phone on a private WireGuard tailnet. Nothing listens publicly, so there is
no Basic auth to satisfy, no header to inject, and no WebSocket auth to break.

On the Pi:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh        # sign in; note the 100.x.y.z address it prints
```

Install the Tailscale app on the phone, sign in to the same account, then browse to
`http://rpi-mad:7681` (with MagicDNS) or `http://<100.x.y.z>:7681`. `--ssh` also replaces the
public port-22 exposure with key/identity-based SSH. Turn on 2FA for the Tailscale account and
add a tailnet ACL if anyone else uses it.

Then remove the public path entirely: delete the `oaiccopilot` Proxy Host (and its
certificate) in NPM, and close the WAN port-forward for 80/443 on the router. ttyd's own auth
is no longer load-bearing but can stay as defence-in-depth.

> **Do this in order — verify before you remove.** Confirm the console loads *and the
> terminal connects* over the tailnet from the phone **first**, and keep a fallback path
> (an SSH session you already have open, or physical access) before closing the router's
> 80/443 forward. Closing the public path is what makes the change valuable, but doing it
> before the tailnet is proven can lock you out of the only shell you have.
> Also note `--ssh` moves SSH onto the tailnet: if the tailnet later breaks, that path goes
> with it, so keep a second way in.

> `tailscale serve` can publish the UI inside the tailnet with a real certificate. Do **not**
> use `tailscale funnel` for a shell — that exposes it to the public internet again.

### 2. Cloudflare Tunnel + Access

No open ports, and identity-based auth (email OTP / SSO) if you would rather not run a VPN app
on the phone. A `cloudflared` tunnel dials *out*, and Cloudflare Access gates it:

```bash
cloudflared tunnel login
cloudflared tunnel create copilot-web
cloudflared tunnel route dns copilot-web copilot.example.com
```

Point the tunnel's ingress at `http://192.168.0.156:7681`, then create an Access application
for the hostname with a policy restricted to your email. Sessions ride on cookies, which *are*
sent on WebSocket handshakes, so the terminal authenticates normally. Note that traffic
terminates at Cloudflare's edge — a trust decision to make knowingly for a shell — but all
inbound exposure is gone.

### 3. Authelia forward-auth (keep the domain and NPM)

Replace the Access List with [Authelia](https://www.authelia.com/) in front of the proxy host.
You get per-user accounts and real MFA (TOTP / WebAuthn), and Authelia issues a **session
cookie** — which, unlike Basic credentials, is sent on WebSocket handshakes. This fixes the
WebSocket problem properly and keeps everything on your own hardware. It is the most work of
the three: another container, a user database and a forward-auth config.

### 4. Client certificates (mTLS)

Require a client certificate on the NPM proxy host. Nothing to brute-force and no shared
secret, but iOS provisioning and rotation are manual — usually enough friction to make it a
poor fit for a phone-first console.

### Worth adding whichever you choose

- If you must stay public, restrict the proxy host to your own IPs/geo (a complement, never a
  substitute — home IPs change).
- Apply the `limit_req` login throttle (see *Rate limiting*) so the password cannot be sprayed.
- Keep `TTYD_LISTEN` off `0.0.0.0` and use a static DHCP lease, so the bind address survives
  the nightly eth0 flap.

## Troubleshooting

- **Header auth enabled but no password is ever asked for** — the `proxy_set_header` rule is
  not overwriting the client's copy, so the console is **open to anyone** who sends the
  header (ttyd accepts any non-empty value). Confirm with the forged-header `curl` under
  *Verify the overwrite* above, then fix the proxy or fall back to basic auth
  (`sudo ./install.sh`).
- **No connection / Reconnect banner** — `systemctl status copilot-web`, then `journalctl -u copilot-web -n 50`.
- **Terminal dies after about a minute, worst on mobile** — the reverse proxy's read timeout.
  nginx-proxy-manager defaults `proxy_read_timeout` to 60s, so a phone that locks its screen
  or switches apps has the connection closed, while a desktop kept in the foreground never
  notices. Set `proxy_read_timeout 7d;` (and `proxy_send_timeout 7d;`) in the proxy host's
  Advanced config. See *Reverse proxy* above.
- **Page looks unchanged** — you are probably still being served the old page; rebuild and re-run the installer.
- **WebSocket rejected after enabling `TTYD_CHECK_ORIGIN`** — the reverse proxy is not
  preserving the `Origin`/`Host` pair. Set `TTYD_CHECK_ORIGIN=0` in the env file and restart.
- **Cannot scroll the transcript** — scrolling is the TUI's own wheel handling, and it needs
  three things to line up. Check them in this order:
  1. **The CLI must have mouse support on.** Ask the CLI: the pane should report a mouse mode
     (`tmux display-message -p '#{mouse_any_flag}'` → `1`). If it is `0`, something passed
     `--no-mouse`, which silently overrides the CLI's stored `mouse: true`; remove it from
     `COPILOT_ARGS` in `/etc/copilot-ttyd/env` (or run `sudo ./deploy/enable-scroll.sh`, which
     sets `--mouse on`). This is what broke desktop scrolling here once.
  2. **tmux's own `mouse` option must be off** (`tmux show-options -g mouse` → `off`). With it
     `on`, tmux keeps the wheel for its copy-mode bindings and the application never receives
     it — measured: a wheel-up delivered to the pane produced **0 bytes** of response with
     `mouse on` and a repaint with `mouse off`.
  3. **On a phone, the page has to be the current one.** xterm ignores touch entirely while
     mouse reporting is active, so the swipe is only useful because `web/overlay.js` converts
     it into an SGR wheel report. That is page code: `npm run build && sudo ./install.sh`.
     Watch out for the one gotcha that cost a debugging session: tmux re-applies the pane's
     mouse state around its own redraws, so a single frame routinely contains a **disable
     followed by an enable** (`…\e[?1003l` then `\e[?1006h\e[?1000h\e[?1002h\e[?1003h`).
     The overlay must therefore apply the switches **in order, last one wins**; testing for
     `h` and `l` separately leaves any such frame disabled and the swipe silently dead, even
     though xterm itself ends up with `enable-mouse-events` on.

  Rolling back to `--no-mouse` is **not** a fix and makes things worse: there is no scrollback
  behind the TUI for xterm's native touch scrolling to take over. The transcript lives on the
  pane's alternate screen, where tmux keeps no history (`#{history_size}` measured **0**), so
  with the wheel disabled nothing can scroll at all. `PageUp`/`PageDown` only repaint.
- **Connects on desktop, fails on iPhone (page loads, terminal never appears)** — `-O`
  compares the WebSocket `Origin` against `Host`, and iOS/WebKit does not always send a
  usable `Origin`: Safari opened from a **Home Screen icon** (standalone web-app mode) or
  from many in-app browsers sends `Origin: null` or omits it. The page and `/token` succeed,
  so the console renders, but the upgrade is refused and the log repeats
  `W: User code denied connection`. Symptom is usually intermittent, because a normal Safari
  tab sends a real `Origin` and does connect. Test in a plain tab before changing anything;
  to keep using the Home Screen icon, `TTYD_CHECK_ORIGIN=0` is required (it cannot be fixed
  by the proxy, since `Origin` is set by the browser).
- **Page and `/token` load, but the terminal never connects (denied)** — this is the main
  iOS failure mode and it is **client-side**. Measured on this deployment: supplying
  credentials to the WebSocket makes it succeed (`101` through the proxy) and the page
  returns `200`, so the server chain is correct; from the iPhone, ttyd logs
  `W: User code denied connection` while `/token` still succeeds. The cause is that
  **WebKit does not send HTTP Basic credentials on the WebSocket handshake**, whereas
  Chrome and Firefox on desktop use their own engines and reuse the credentials cached from
  the page load — which is exactly why the desktop browser works and the phone does not.
  Because **every iOS browser is WebKit** (Safari, Chrome and Firefox alike), all of them
  fail identically, so changing browser on the phone cannot help. It also cannot be worked
  around by changing *which* server issues the challenge: **a browser cannot satisfy a
  Basic-auth challenge on a WebSocket at all**, because there is no prompt for it (`401` from
  ttyd and `401` from the proxy are equally unsatisfiable). Disabling `TTYD_CHECK_ORIGIN` is
  unrelated — that is the origin check, not the credential check. See the next entry for what
  does work.
- **The fix for the above** — **a VPN, or cookie-based auth. There is no nginx/ttyd setting
  that fixes it.** Measured on this deployment: with credentials supplied, the WebSocket
  returns `101` through the proxy and the page returns `200` — so the server side is correct.
  From the iPhone, ttyd logs `User code denied connection` while `/token` succeeds. The
  difference is that **Safari does not send HTTP Basic credentials on the WebSocket
  handshake**, whereas Chrome and Firefox reuse the credentials cached from the page load.
  A browser cannot satisfy a Basic-auth challenge on a WebSocket *at all* — it cannot prompt
  for one — so switching the challenge from ttyd to the proxy (the `-H X-Copilot-Auth`
  scheme) does **not** help while the proxy still challenges the upgrade with Basic auth;
  only the `401` source changes. Remedies that actually work remove the browser-supplied
  credential from the WS path:
  1. **VPN** (Tailscale/WireGuard) — nothing public, no auth in the path at all. Simplest.
  2. **Cookie-based auth** — browsers *do* send cookies on WebSocket handshakes, so an
     Access session cookie (Cloudflare Access, or Authelia/authentik forward-auth behind
     NPM) authenticates the upgrade where Basic auth cannot.

  Note that the `-H X-Copilot-Auth` scheme has a second consequence: once ttyd requires the
  header, the **direct LAN URL stops working** — requests must go through the proxy.
- **Browser fails with `ERR_UNEXPECTED_PROXY_AUTH` just after the password prompt** — this is
  a header-injection bug in the proxy, not a browser problem. With `-H X-Copilot-Auth`, ttyd
  answers **`407 Proxy Auth Required`** (not `401`) whenever a request reaches it without the
  header, and Chrome reports a `407` it did not send through a proxy as
  `ERR_UNEXPECTED_PROXY_AUTH` — so even the **page** fails, not just the WebSocket. The proxy
  is not *replacing* the header: it either never applied the Advanced config or forwards the
  client's copy, so a browser (which sends no `X-Copilot-Auth`) is challenged by ttyd and
  fails. Diagnose by hitting the origin directly — `curl -sI http://<pi>:7681/` returning
  `407` with `proxy-authenticate: Basic realm="ttyd"` proves ttyd is refusing for a missing
  header — then fix and verify as in *⚠️ Verify the overwrite* above. Through the domain,
  `curl -u USER:PASS https://…/` returning `407` instead of `200` is the same bug.
- **Reachable from the LAN IP but not through the domain** — confirm the proxy forwards to
  `TTYD_LISTEN:TTYD_PORT` and supports WebSocket upgrades.
- **Arrow keys do nothing in a menu** — the tmux session must be attached (it is, by design);
  check `tmux ls`.
- **Header auth answers 407** — the proxy is not injecting `TTYD_AUTH_HEADER`. Check that the
  `proxy_set_header` name matches `/etc/copilot-ttyd/env`, and that the proxy is running.
- **Scrolling back stops after a while** — the wheel scrolls the CLI's own transcript buffer, so
  a very long conversation can only be scrolled back as far as that in-memory buffer, and
  anything from before the page was last loaded is gone. `history_size` staying **0** is
  expected here, not a fault: the transcript lives on the alternate screen, which tmux does not
  keep.
# Copilot-Web-Service
