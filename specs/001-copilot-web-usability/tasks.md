# Tasks: Copilot Web Console — Mobile Usability

Ordered by dependency. `[x]` = done, `[ ]` = open.

## Phase 1 — Reconnaissance

- [x] T001 Identify the service: ttyd 1.7.7 on port 7681 behind
      `https://aiccopilot.duckdns.org`, unit `copilot-web.service` (mode 600, root-owned).
- [x] T002 Confirm the mobile text defect: ttyd's page has **no** `<meta name="viewport">`.
- [x] T003 Confirm the menu defect: no on-screen key controls exist in the stock page.
- [x] T004 Map the ttyd client protocol: `GET /token`, `WebSocket(url, ["tty"])`,
      `'0'`-prefixed INPUT frames, and URL-based client options.
- [x] T005 Locate the DOM contracts: `#terminal-container`, `.terminal.xterm`,
      `.xterm-helper-textarea`.

## Phase 2 — Overlay

- [x] T006 `web/overlay.js`: wrap `window.WebSocket` (idempotent, prototype + statics
      preserved) and record the instance ttyd opens.
- [x] T007 `web/overlay.js`: `encodeFrame()` producing `0x30` + UTF-8, and `sendKey()`.
- [x] T008 `web/overlay.js`: key map for `← ↑ ↓ → Enter Esc Tab Shift+Tab Ctrl+C Ctrl+D
      PgUp PgDn` with the correct byte sequences.
- [x] T009 `web/overlay.js`: toolbar with `role="toolbar"`, per-button accessible names,
      click handlers, and a collapse toggle plus floating show button.
- [x] T010 `web/overlay.js`: font controls clamped to 6–32 px, persisted in
      `localStorage`, applied pre-bundle via `history.replaceState('?fontSize=N')`.
- [x] T011 `web/overlay.js`: ARIA live status (`Connecting…` / hidden / disconnected +
      Reconnect), driven by socket `open`/`close`/`error` and a 15 s timeout.
- [x] T012 `web/overlay.js`: publish `--cw-keyspace` and dispatch `resize` so the terminal
      re-fits above the toolbar.
- [x] T013 `web/overlay.css`: dark high-contrast palette, ≥44 px targets, `:focus-visible`
      rings, safe-area insets, `prefers-reduced-motion`, compact landscape rules.

## Phase 3 — Build pipeline

- [x] T014 `web/build.mjs`: fetch the stock page with basic auth from `TTYD_URL`.
- [x] T015 `web/build.mjs`: inject the viewport meta and inline CSS + JS **before** ttyd's
      bundle; detect the bundle marker and refuse double injection.
- [x] T016 `web/build.mjs`: verify the output (viewport, overlay markers, bundle intact)
      and fail clearly on 401 / unreachable ttyd. `--save-reference` keeps the stock page.

## Phase 4 — Service & hardening

- [x] T017 `systemd/copilot-web-run`: read `TTYD_*` from the environment, validate the index
      file exists, build the ttyd argv, `exec` it.
- [x] T018 `systemd/copilot-web.service`: `EnvironmentFile=/etc/copilot-ttyd/env`,
      `Restart=on-failure`, `NoNewPrivileges=true`.
- [x] T019 `install.sh`: back up the unit, install wrapper + unit, append missing
      `TTYD_CREDENTIAL`/`TTYD_LISTEN`, reload and restart, print rollback instructions.

## Phase 5 — Tests & docs

- [x] T020 `tests/overlay.test.mjs`: 18 jsdom tests (framing, key map, toolbar, clicks,
      status/ARIA, collapse, font clamp/persist/URL precedence, disconnected send, plus
      regressions for the stale-`?fontSize=` font buttons, the pre-connect no-reload path
      and the single-emit re-fit).
- [x] T021 `npm run lint` (`node --check`) clean; `sh -n` / `bash -n` clean on shell scripts.
- [x] T022 Verify the INPUT frame against a real ttyd on a throwaway port (echo round-trip).
- [x] T023 Verify `ttyd -I web/index.html` serves the patched page (HTTP 200, overlay before
      bundle).
- [x] T024 README with configuration table, deploy/upgrade, rollback and troubleshooting.
- [x] T025 `specs/001-copilot-web-usability/` spec, plan, tasks, quickstart.

## Phase 6 — Deployment & device verification (needs sudo + a phone)

- [ ] T026 `sudo ./install.sh` on the Pi; confirm the credential is no longer in the unit and
      that the printed/kept password works.
- [ ] T027 Load `https://aiccopilot.duckdns.org` on the phone: text legible (US2).
- [ ] T028 Drive a real Copilot selection menu with the toolbar arrows + `Enter` (US1).
- [ ] T029 Kill the Wi-Fi briefly and confirm the Disconnected/Reconnect state (US3).
- [ ] T030 Confirm `systemctl restart copilot-web` leaves the `copilot` tmux session intact.

## Phase 7 — Mobile scroll, sizing and proxy auth

- [x] T031 Lower the font floor from 6 px to 4 px (`MIN_FONT`), and cover it in the tests.
- [x] T032 Size the key bar from one compact variable (`--cw-btn: 30px`, 26 px in
      landscape) and hide the key pad scrollbar.
- [x] T033 Fit the keys without an off-screen strip. Three attempts, each rejected on the
      phone: `touch-action: pan-x` (still depended on touch scrolling), wrapping (stacked into
      a column that covered half the screen), and finally one non-wrapping row of shrinking
      keys with the less-used keys behind `⋯`.
- [x] T034 Drop `smcup`/`rmcup` from tmux's `terminal-overrides` and set `TTYD_SCROLLBACK`,
      so a full-screen TUI still leaves a scrollback the terminal can swipe through
      (verified with a pty capture that no `\e[?1049h` reaches the outer terminal).
      **Reverted (2026-10-05):** `history_size` stayed `0` — the transcript is discarded inside
      tmux's pane, not at the outer terminal — so the override was removed and scrolling now
      rides on the CLI's own mouse wheel plus an SGR wheel report synthesised from a swipe.
      See README *Cannot scroll the transcript*.
- [x] T035 `TTYD_AUTH_HEADER` support in `copilot-web-run`, `install.sh --auth-header` and
      `build.mjs`, so no credential is passed in argv.
- [x] T036 `deploy/nginx-copilot.conf`: `limit_req` brute-force protection plus the
      `proxy_set_header` the header auth depends on.
- [ ] T037 Apply the tmux scrollback options to the running session and confirm swipe scroll
      works on the phone.
- [ ] T038 `sudo ./install.sh --auth-header X-Copilot-Auth` and confirm `ttyd` no longer shows
      a credential in `ps` (needs the proxy up, or the console becomes unreachable).
- [x] T039 Guarantee `← ↑ ↓ →` are always on screen: a single `nowrap` row whose keys shrink
      to fit cannot wrap, scroll or be pushed off screen. Verified in headless Chromium at
      240/320/360/740x360 — one row, 0 clipped, arrows visible; 39 px collapsed, 72 px expanded.
- [x] T040 Theme and thin xterm's always-present viewport scrollbar, so the column on the
      right of the console does not read as dead black space.
