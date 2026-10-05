# Feature Specification: Copilot Web Console — Mobile Usability

**Feature branch**: `001-copilot-web-usability`
**Status**: Implemented (deployment pending sudo)
**Created**: 2026-09-30

## Problem

The GitHub Copilot CLI on the Raspberry Pi is exposed over the web with `ttyd` and reached
from a phone at `https://oaiccopilot.duckdns.org`. Two defects make it unusable on a mobile
browser:

1. **Unreadable text.** ttyd's page has no responsive viewport declaration, so mobile
   browsers lay it out at a ~980 px desktop width and scale it down. The terminal font is
   also fixed at 13 px with no way to change it.
2. **Interactive menus cannot be operated.** Copilot's selection prompts require arrow keys,
   `Enter`, `Esc` and `Tab`. A touch device has none of these, and ttyd's UI offers no
   on-screen controls, so the user cannot complete any selection.

Additionally there is no feedback when the connection drops, and no accessible control
surface for touch use.

## User stories

### US1 — Choose an option from a Copilot menu on a phone (P1)

As a phone user, I want on-screen keys for the menu, so that I can move the highlight and
confirm a choice without a hardware keyboard.

**Acceptance criteria**

1. The page shows a control bar with `←`, `↑`, `↓`, `→`, `Enter`, `Esc`, `Tab`,
   `Shift+Tab`, `Ctrl+C`, `Ctrl+D`, `PgUp`, `PgDn`.
2. Each control sends exactly the escape sequence a terminal expects
   (`↑` = `ESC [ A`, `Tab` = `0x09`, `Shift+Tab` = `ESC [ Z`, `Enter` = `CR`, …).
3. Sequences are delivered over the terminal's existing connection, so the terminal size
   and the tmux session are unaffected.
4. Pressing a control does not require the terminal to have focus first, and focus returns
   to the terminal afterwards so hardware/soft typing still works.
5. Controls are usable with one thumb: at least 44×44 px, and they never cover the bottom
   rows of the terminal.

### US2 — Read the console comfortably (P1)

As a phone user, I want legible text, so that I can read Copilot's output without zooming.

**Acceptance criteria**

1. A responsive viewport declaration is present so text renders at device scale.
2. The default terminal font size is at least 16 px.
3. `A−`, `A+` and `↺` controls adjust the size, clamped to 4–32 px. A control that
   cannot change the size (at a limit, or below a size ttyd applied from the URL) is
   disabled rather than silently doing nothing.
4. The chosen size survives a reload.
5. A saved size applies on load without an extra reload.

### US3 — Know what the connection is doing (P2)

As a phone user, I want clear connection feedback, so that I know whether to wait or retry.

**Acceptance criteria**

1. A visible "Connecting…" state appears until the terminal connects.
2. On connect, the status disappears.
3. On close/error, a "Disconnected — tap Reconnect" state with a Reconnect button appears.
4. If no connection is ever established within 15 s, an explanatory message appears instead
   of an indefinite spinner.
5. Status changes are announced to assistive technology (`role="status"`, `aria-live`).

### US4 — Operate the console with assistive technology (P2)

1. The key bar is exposed as `role="toolbar"` and every button has an accessible name.
2. Focus is always visible (`:focus-visible` outline).
3. Controls are compact enough for the whole key bar to stay usable one-handed on a
   phone (30 px targets, 26 px in landscape) and keep a high-contrast palette. This
   lowers the 44 px target from the first draft: fitting twelve keys plus the text-size
   controls on a phone screen was chosen over the larger tap target.
4. Motion respects `prefers-reduced-motion`.

### US5 — Keep the endpoint reasonably hardened (P3)

1. The HTTP basic-auth credential is not stored in the systemd unit file.
2. Cross-origin WebSocket upgrades are rejected.
3. The service does not listen on all interfaces when a LAN address is known.

### US6 — Read output and reach the controls on a phone (P1)

1. The console can be scrolled back vertically with a touch swipe, instead of showing
   nothing because the full-screen TUI put the terminal on the alternate screen.
2. `← ↑ ↓ →`, `Enter` and `Esc` are always visible in a single row that cannot wrap, scroll
   or be pushed off screen; the less-used keys are one tap away behind `⋯`.
3. The font floor and key size keep a usable number of columns and rows on a narrow phone.

## Out of scope

- Replacing ttyd or writing a native/capacitor app.
- Multi-user accounts, session pickers, or per-user terminals.
- Terminal multiplexing UI beyond the single existing `copilot` tmux session.
- Rebuilding ttyd or forking its front-end bundle.

## Success signal

On a phone, a first-time user can open the URL, read the output, navigate a Copilot
selection menu, confirm a choice, and recover from a dropped connection — without a
hardware keyboard and without pinch-zooming.
