# Implementation Plan: Copilot Web Console — Mobile Usability

**Spec**: `specs/001-copilot-web-usability/spec.md`
**Date**: 2026-09-30
**Status**: Implemented; deployment pending sudo

## Context (verified on the Pi)

| Item | Value |
| --- | --- |
| Service | `copilot-web.service` ("Web Terminal for GitHub Copilot CLI (ttyd)") |
| Command | `ttyd -p 7681 -c admin:**** -W tmux new -A -s copilot ~/.local/bin/copilot` |
| ttyd | 1.7.7-40e79c7, page is a single self-contained HTML (Preact + xterm.js 5.x) |
| Public entry | `https://oaiccopilot.duckdns.org` (reverse proxy terminates TLS, forwards WS) |
| Client protocol | basic auth; `GET /token` → `{"token":"<base64 user:pass>"}`; `WebSocket(url, ["tty"])` |
| Frame format | client → server: `'0'` (INPUT) + UTF-8 payload; `'1'` RESIZE; `'2'` PAUSE; `'3'` RESUME |
| Verified DOM | `#terminal-container` (height 100%) → `.terminal.xterm`; `.xterm-helper-textarea` |

## Approach

Do **not** fork or rebuild ttyd. Instead:

1. Fetch ttyd's stock `index.html` from the running service (`web/build.mjs`).
2. Inline two small assets into it:
   - a `viewport` meta tag (fixes US2.1),
   - `web/overlay.js` + `web/overlay.css`, inserted **immediately before ttyd's bundle**
     so the script runs before any WebSocket is created.
3. Serve the result with `ttyd --index` (`-I`) from `systemd/copilot-web-run`.

The stock bundle is preserved byte-for-byte; only our block is prepended to its `<script>`.

## Key decisions

### D1 — Reuse ttyd's socket (chosen) over a second connection

`overlay.js` replaces `window.WebSocket` with a thin wrapper that records the instance ttyd
creates (`Patched.prototype = Native.prototype`, static constants copied, idempotent via a
flag). Key presses are written as `INPUT` frames on that socket.

*Rejected:* opening a second WebSocket. ttyd would treat it as another client and the shared
tmux window can resize to the smallest/latest client, disturbing the visible terminal.

*Rejected:* dispatching synthetic `KeyboardEvent`s to `.xterm-helper-textarea`. It depends on
xterm internals and cannot be verified without a browser; exact frames can be verified.

**Verification:** `INPUT` framing was validated against real ttyd 1.7.7 on a throwaway port
(`ttyd -W /bin/cat` + a protocol client): the payload was echoed back, confirming the frame
header byte and encoding.

### D2 — Font size via URL client option

ttyd's client merges options from `-t`, `/token`, and the **URL query**
(`parseOptsFromUrlQuery`). Because the overlay runs before the bundle, it can
`history.replaceState` a stored `?fontSize=N` into place on first paint — no reload, no
flicker. `A±` changes persist to `localStorage` and reload with the new parameter, which is
the only way to re-initialise xterm cleanly.

### D3 — Reserve toolbar space and re-fit

The toolbar is fixed to the bottom, so menus rendered at the bottom of the screen would be
hidden. The overlay publishes `--cw-keyspace` on `:root`; CSS shrinks
`#terminal-container`/`.xterm`, and a single synthetic `resize` event (guarded against the
module's own `resize` listener, which would otherwise recurse until the stack overflowed)
lets the fit addon recompute rows. Collapsing the bar sets the variable to `0`. Only the key
pad (`#cw-keys`) scrolls horizontally, so the text-size controls stay on screen on a phone.

### D4 — Hardening

- Credential moves from the unit file to `/etc/copilot-ttyd/env` (`EnvironmentFile=` +
  a launcher wrapper that reads it).
- `-O` (`--check-origin`) rejects cross-origin WebSocket upgrades (overridable via
  `TTYD_CHECK_ORIGIN` if the proxy rewrites origins).
- Bind to the LAN address (`TTYD_LISTEN`) rather than `0.0.0.0`.
- The unit is restarted with `NoNewPrivileges=true`.

- Password-free operation: `TTYD_AUTH_HEADER` switches ttyd to `-H <header>`, so the
  reverse proxy authenticates and injects the header and **no credential is passed in
  `argv`**. `install.sh --auth-header` opts in, and `deploy/nginx-copilot.conf` carries the
  `limit_req` brute-force zone plus the `proxy_set_header` the mode depends on. ttyd only
  checks that the header is present and non-empty (verified: a missing header is a 407), so
  the proxy must strip any client-supplied copy.

*Known limitation:* basic auth is still the default, because header auth needs the proxy to
inject the header — without it the console is unreachable. The password therefore keeps
appearing in `ps` until `--auth-header` is applied and the proxy is wired up.

### D5 — Mobile sizing and scrolling

- Keys are sized from one variable (`--cw-btn: 30px`, 26 px in landscape) instead of the
  original 44 px target: twelve keys plus the text-size controls do not fit a phone
  otherwise. The trade-off is recorded in the spec (US4.3).
- The font floor drops to 4 px so a narrow phone can reach a usable column count.
- The bar is **one non-wrapping row of shrinking keys** (`.cw-row { flex-wrap: nowrap }`,
  `.cw-btn { flex: 1 1 0; min-width: 0 }`): it cannot wrap onto extra lines, scroll, or push a
  key off screen — the three ways the arrow keys kept disappearing. The less-used keys moved
  to `#cw-extras`, revealed by `⋯`, so the default bar is 39 px tall and 72 px when expanded.
  Verified at 240/320/360/740x360: one row, 0 clipped, arrows visible.
- xterm always reserves a viewport scrollbar (`overflow-y: scroll`); it is themed and thinned
  so the right-hand column reads as a scrollbar rather than dead space.
- **Vertical scroll:** a full-screen TUI makes tmux use the alternate screen, which has no
  scrollback at all (`history_size=0`), so there is nothing to swipe to.
  `terminal-overrides ',*:smcup@:rmcup@'` stops tmux emitting `\e[?1049h` — verified with a
  pty capture, including when the pane itself asks for the alternate screen — leaving the
  outer terminal on its normal screen with history. tmux's own `alternate-screen` option had
  no effect on tmux 3.5a, so the terminfo override is what the launcher uses.

  **Superseded (2026-10-05):** keeping the outer terminal on its normal screen still leaves
  `history_size=0`, because the transcript is discarded inside tmux's pane — so the override
  changed nothing that could be scrolled and has been removed. Scrolling is the TUI's own
  wheel handling instead: `--mouse on` (alt screen mode only), with tmux's `mouse` option kept
  `off` so tmux forwards the wheel to the pane. See README *Cannot scroll the transcript*.

## Files

| File | Purpose |
| --- | --- |
| `web/overlay.js` | WebSocket capture, `INPUT` framing, key bar, font control, status |
| `web/overlay.css` | Toolbar/status layout, touch targets, safe-area, reduced motion |
| `web/build.mjs` | Fetch + inject + verify → `web/index.html` |
| `systemd/copilot-web.service` | Unit using `EnvironmentFile` + wrapper |
| `systemd/copilot-web-run` | Reads env, builds the ttyd argv, `exec`s it |
| `install.sh` | Idempotent install/upgrade with backup and env checks |
| `deploy/nginx-copilot.conf` | Proxy rate limit + `proxy_set_header` for header auth |
| `tests/overlay.test.mjs` | jsdom tests for framing, toolbar, status, fonts, mobile CSS |

## Test strategy

- **Unit (jsdom, 24 tests):** every key maps to the exact escape sequence; frame prefix is
  `0x30`; toolbar exposes one labelled button per key; tapping sends the key; status region
  has `role`/`aria-live` and reacts to socket lifecycle; collapse/expand; font clamp
  (4–32 px), persistence and URL precedence; clean failure when disconnected.
- **Stylesheet assertions:** `web/overlay.css` keeps `touch-action: pan-x` on the key pad and
  its buttons, `--cw-btn` as the single size knob, and `overscroll-behavior: contain` on the
  terminal viewport — the regressions that made the console unusable on a phone.
- **Build check:** `build.mjs` refuses to emit a page missing the viewport tag, the overlay
  markers or ttyd's bundle, and fails loudly on 401 or an unreachable ttyd.
- **Manual (needs a device):** confirm on the phone that a real Copilot menu can be driven
  with the arrows and that the page is legible.

## Risks

| Risk | Mitigation |
| --- | --- |
| ttyd changes its page/DOM on upgrade | `build.mjs` fails on a missing bundle marker; `web/stock-index.html` (git-ignored) kept for diffing. |
| Proxy rewrites `Origin` → `-O` blocks WS | `TTYD_CHECK_ORIGIN=0` escape hatch, documented. |
| LAN IP changes (DHCP) | `TTYD_LISTEN` configurable; README recommends a static lease. |
| Toolbar hides menu rows | `--cw-keyspace` reserves height and re-fits; bar collapses. |
| Overlay script would run twice | `build.mjs` detects `id="cw-root"` and will not double-inject. |

## Deployment

Run `sudo ./install.sh` (details and rollback in `README.md`). Requires a password because
the unit and wrapper live in root-owned locations; the build itself runs as the project
owner.
