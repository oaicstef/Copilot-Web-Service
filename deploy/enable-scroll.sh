#!/usr/bin/env bash
#
# Keep transcript scrolling working on the phone console.
#
#   cd ~/src/copilot-web && sudo ./deploy/enable-scroll.sh
#
# Why this is needed: the Copilot TUI scrolls its transcript with the mouse wheel,
# and only in alt screen mode (`--mouse [on|off]  Enable mouse support in alt
# screen mode`). That wheel is the only scroll available — the transcript lives on
# the pane's alternate screen, where tmux keeps no history (`#{history_size}` is 0
# on this TUI), so no terminal scrollback ever accumulates for xterm to move.
#
# Two things therefore have to hold, and this script asserts both:
#
#   1. The CLI must not be started with --no-mouse. It overrides the CLI's stored
#      `mouse: true`, the wheel stops being reported, and desktop scrolling dies
#      with nothing to replace it. (An earlier version of this script set exactly
#      that flag, on the theory that disabling mouse reporting would free up
#      xterm's touch scrolling; it does not, because there is no scrollback for
#      xterm to scroll.)
#   2. tmux's own `mouse` option has to stay off. With it off tmux passes a wheel
#      event through to the pane application; with `mouse on` tmux keeps the wheel
#      for copy-mode and the application never sees it.
#
# Phones cannot send a wheel event at all — xterm skips its own touch handling
# while mouse reporting is active — so web/overlay.js translates a swipe into the
# same SGR wheel report a desktop wheel sends. That half lives in the page, so
# after changing it rebuild and reinstall: npm run build && sudo ./install.sh
#
# This RESTARTS copilot-web, which ends the running CLI session. The tmux session
# itself survives, so the console stays up and a fresh session starts.
#
# Revert:  sudo ./deploy/enable-scroll.sh --off
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER_DST="/usr/local/bin/copilot-web-run"
ENV_FILE="/etc/copilot-ttyd/env"
STAMP="$(date +%Y%m%d-%H%M%S)"
COPILOT_ARGS_VALUE="--mouse on"

# tmux belongs to the SERVICE user, not to root: this script runs with sudo, and a
# plain `tmux` here would talk to root's (usually absent) server and silently
# change nothing. The tmux options that matter are per-user.
SERVICE_USER="$(awk -F= '/^User=/{print $2; exit}' "$PROJECT_DIR/systemd/copilot-web.service" 2>/dev/null || true)"
SERVICE_USER="${SERVICE_USER:-oaicstef}"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
SERVICE_HOME="${SERVICE_HOME:-/home/$SERVICE_USER}"

as_service_user() {
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" tmux "$@"
}

MODE="on"
if [[ "${1:-}" == "--off" ]]; then
  MODE="off"
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run with sudo: sudo $0" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

echo "==> backing up $ENV_FILE"
cp -a "$ENV_FILE" "$ENV_FILE.bak-$STAMP"

# The launcher in /usr/local/bin is a COPY made by install.sh, so editing the
# project file alone does nothing — without this, COPILOT_ARGS is ignored.
echo "==> installing the launcher (restores the mouse-enabled default)"
install -o root -g root -m 0755 "$PROJECT_DIR/systemd/copilot-web-run" "$WRAPPER_DST"

if [[ "$MODE" == "on" ]]; then
  echo "==> setting COPILOT_ARGS=$COPILOT_ARGS_VALUE"
  if grep -q '^COPILOT_ARGS=' "$ENV_FILE"; then
    sed -i "s|^COPILOT_ARGS=.*|COPILOT_ARGS=$COPILOT_ARGS_VALUE|" "$ENV_FILE"
  else
    printf 'COPILOT_ARGS=%s\n' "$COPILOT_ARGS_VALUE" >>"$ENV_FILE"
  fi
else
  echo "==> clearing COPILOT_ARGS (CLI settings decide; currently 'mouse: true')"
  if grep -q '^COPILOT_ARGS=' "$ENV_FILE"; then
    sed -i 's|^COPILOT_ARGS=.*|#COPILOT_ARGS=|' "$ENV_FILE"
  fi
fi

# The wheel only reaches the CLI while tmux's own `mouse` option is off, and tmux
# options belong to the service user's server, so ask for it as that user.
echo "==> ensuring tmux mouse is off (required for the wheel to reach the CLI)"
if as_service_user set-option -g mouse off 2>/dev/null; then
  echo "    tmux mouse = $(as_service_user show-options -g mouse 2>/dev/null || echo '?')"
else
  echo "    warning: could not set tmux mouse off; run 'tmux set-option -g mouse off'" >&2
  echo "    as user $SERVICE_USER yourself, or desktop scrolling will not reach the CLI." >&2
fi
# Left over from the --no-mouse experiment. It never made anything scrollable (the
# transcript is discarded inside the pane, so `history_size` stayed 0), and this
# script does not remove it automatically because `terminal-overrides` may hold
# other entries this script must not clobber. Only report it.
if as_service_user show-options -g terminal-overrides 2>/dev/null | grep -q 'smcup@'; then
  echo "    note: tmux terminal-overrides still drops smcup/rmcup; harmless for"
  echo "    scrolling, but no longer needed. Clear it with:"
  echo "      tmux set-option -gu terminal-overrides   # as $SERVICE_USER"
fi

echo "==> restarting copilot-web"
systemctl restart copilot-web
sleep 3
systemctl --no-pager --lines=0 status copilot-web || true

echo
if [[ "$MODE" == "on" ]]; then
  echo "==> verifying"
  pane_mouse="$(as_service_user display-message -p '#{mouse_any_flag}' 2>/dev/null || echo '?')"
  tmux_mouse="$(as_service_user show-options -g mouse 2>/dev/null || echo '?')"
  echo "    CLI asked for mouse reporting: $pane_mouse   (want 1)"
  echo "    tmux mouse option:             $tmux_mouse   (want off)"
  ps -eo args | grep -q '[c]opilot --mouse on' \
    && echo "    CLI launched with:             --mouse on" \
    || echo "    warning: the running CLI is not 'copilot --mouse on' — it was started" >&2

  echo
  echo "Done. Reload the console (hard reload on iOS), then scroll with the wheel on"
  echo "a desktop or a swipe on a phone. One wheel notch moves the transcript 3 lines."
  echo
  echo "The CLI session was restarted, so the conversation it was running is over;"
  echo "the tmux session survived. If the swipe still does nothing on a phone, the"
  echo "browser is holding the old page: run 'npm run build && sudo ./install.sh' in"
  echo "$PROJECT_DIR and hard reload."
else
  echo "Reverted: COPILOT_ARGS cleared and the service restarted."
fi
echo
echo "Revert: sudo $0 --off"
echo "Backup: $ENV_FILE.bak-$STAMP"
