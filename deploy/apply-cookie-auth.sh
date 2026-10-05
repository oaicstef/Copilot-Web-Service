#!/usr/bin/env bash
#
# Put cookie-based authentication in front of ttyd, so the console works on iOS.
#
#   sudo ./deploy/apply-cookie-auth.sh
#
# Why: HTTP Basic cannot protect a WebSocket. A browser attaches Basic
# credentials only after a 401 challenge on that request, and a WebSocket
# handshake cannot prompt the user — so the upgrade fails on clients that do not
# reuse the credentials cached from the page load. Chrome/Firefox do; Safari
# does not, which is why "desktop works, iPhone doesn't". Cookies ARE sent on a
# WebSocket handshake, so authenticate once over HTTP and let the cookie carry
# the upgrade. See deploy/nginx-cookie-auth.conf for the config itself.
#
# The change is a port swap, and for a few seconds nothing is listening on 7681:
#
#     before:  N100 -> Pi:7681 ttyd (basic auth)
#     after:   N100 -> Pi:7681 nginx (cookie auth) -> Pi:127.0.0.1:7682 ttyd (no auth)
#
# The swap and its rollback happen in one place, and any failure restores the
# previous configuration automatically. ttyd ends up with NO authentication of
# its own, so it is bound to loopback only; if it were reachable it would be an
# open shell.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_SRC="$PROJECT_DIR/deploy/nginx-cookie-auth.conf"
CONF_DST="/etc/nginx/conf.d/copilot.conf"
ENV_FILE="/etc/copilot-ttyd/env"
HTPASSWD="/etc/nginx/copilot.htpasswd"
STAMP="$(date +%Y%m%d-%H%M%S)"
ENV_BAK="/etc/copilot-ttyd/env.bak-$STAMP"
TTYD_BACKEND_PORT="${TTYD_BACKEND_PORT:-7682}"

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[[ "$(id -u)" -eq 0 ]] || die "run with sudo: sudo $0"
[[ -f "$CONF_SRC" ]] || die "$CONF_SRC not found"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found"

# ---------------------------------------------------------------- rollback ---
# Restore the previous ttyd configuration and take nginx out of the path. Safe
# to call repeatedly.
rollback() {
  echo
  echo "!! rolling back to the previous configuration" >&2
  if [[ -f "$ENV_BAK" ]]; then
    cp -a "$ENV_BAK" "$ENV_FILE" || true
  fi
  systemctl stop nginx 2>/dev/null || true
  rm -f "$CONF_DST" || true
  systemctl restart copilot-web 2>/dev/null || true
  echo "   ttyd restored; nginx stopped. Check: systemctl status copilot-web" >&2
}
trap 'rollback' ERR

# ------------------------------------------------------------- dependencies ---
if ! command -v nginx >/dev/null 2>&1; then
  say "installing nginx"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx apache2-utils
fi
command -v htpasswd >/dev/null 2>&1 || {
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq apache2-utils
}

# ------------------------------------------------------------ credentials ----
# Reuse ttyd's existing credential so the password does not change. It is stored
# as user:pass, which is exactly what htpasswd needs.
CRED="$(sed -n 's/^TTYD_CREDENTIAL=//p' "$ENV_FILE")"
if [[ -z "$CRED" ]]; then
  read -r -p "No TTYD_CREDENTIAL to reuse. Login username: " NEW_USER
  read -r -s -p "Password for $NEW_USER: " NEW_PASS; echo
  [[ -n "$NEW_USER" && -n "$NEW_PASS" ]] || die "a username and password are required"
  CRED="$NEW_USER:$NEW_PASS"
fi
LOGIN_USER="${CRED%%:*}"

say "backing up $ENV_FILE -> $ENV_BAK"
cp -a "$ENV_FILE" "$ENV_BAK"

say "writing login for '$LOGIN_USER' to $HTPASSWD"
htpasswd -bc "$HTPASSWD" "${CRED%%:*}" "${CRED#*:}" >/dev/null
# nginx's worker processes do not run as root, so root-only permissions would
# make every login fail. Give the nginx group read access (www-data on Debian,
# nginx on RHEL) and keep it off every other account.
chown root:www-data "$HTPASSWD" 2>/dev/null || chown root:nginx "$HTPASSWD" 2>/dev/null || true
chmod 640 "$HTPASSWD"

# `|| true`: `head -c` closing the pipe early raises SIGPIPE in `tr`, which
# `set -o pipefail` would otherwise turn into a failure and trip the rollback.
SECRET="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 || true)"
[[ -n "$SECRET" ]] || die "could not generate a session secret"

# ----------------------------------------------------------- nginx config ----
say "installing $CONF_DST"
sed "s|<REPLACE_WITH_SESSION_SECRET>|$SECRET|g" "$CONF_SRC" > "$CONF_DST"

say "validating nginx configuration"
# Check the EXIT STATUS, not the text: a successful `nginx -t` prints
# "syntax is ok", so grepping the output for "syntax" reports success as
# failure. The `if !` form also keeps `set -e` from tripping the rollback.
if ! NGINX_TEST_OUT="$(nginx -t 2>&1)"; then
  printf '%s\n' "$NGINX_TEST_OUT" >&2
  die "nginx configuration is invalid (see the nginx -t output above)"
fi

# ------------------------------------------------------- point ttyd inward ---
# The INSTALLED launcher is a copy that an earlier install.sh placed in
# /usr/local/bin, so editing the project's copy alone changes nothing. This
# matters here: a launcher predating TTYD_NO_AUTH exits when no auth is
# configured, so ttyd would fail to start after the swap. Install the updated
# wrapper first — it is backward compatible (with a credential set it behaves
# exactly as before).
say "installing the updated launcher (adds TTYD_NO_AUTH support)"
install -o root -g root -m 0755 "$PROJECT_DIR/systemd/copilot-web-run" /usr/local/bin/copilot-web-run

# ttyd keeps running for now; these take effect on its restart during the swap.
say "moving ttyd to 127.0.0.1:$TTYD_BACKEND_PORT with no auth of its own"
set_env() { # set_env <KEY> <VALUE> — replace or append
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}
set_env TTYD_LISTEN 127.0.0.1
set_env TTYD_PORT "$TTYD_BACKEND_PORT"
# Comment out every auth mechanism: nginx authenticates now, and ttyd must not
# ask for anything itself (a second challenge would re-break the WebSocket).
sed -i 's|^TTYD_CREDENTIAL=|#TTYD_CREDENTIAL=|; s|^TTYD_AUTH_HEADER=|#TTYD_AUTH_HEADER=|' "$ENV_FILE"
# ...but copilot-web-run refuses to start with no auth configured (a deliberate
# safety default), so opt in explicitly.
set_env TTYD_NO_AUTH 1

# ------------------------------------------------------------- the swap -----
# Everything in this block runs without interruption; the ERR trap rolls back.
say "swapping: stopping ttyd, starting nginx, restarting ttyd behind it"
systemctl stop copilot-web
# `enable --now` is a no-op when nginx is already running (apt starts it), and it
# would then keep serving the OLD configuration with no listener on 7681 —
# leaving nothing on that port once ttyd moves. `restart` always reloads.
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx
systemctl restart copilot-web

# `exit` does not trigger the ERR trap, so these paths must roll back
# explicitly — they are exactly where a failure would otherwise strand the
# console with the auth chain half-swapped.
sleep 1
if ! systemctl is-active --quiet copilot-web; then
  rollback
  die "ttyd failed to start behind nginx"
fi
if ! systemctl is-active --quiet nginx; then
  rollback
  die "nginx failed to start"
fi

# End-to-end proof that the gate is actually live: an unauthenticated request
# must be sent to the login page, not served.
GATE_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:7681/ || true)"
if [ "${GATE_CODE:-000}" != "302" ]; then
  rollback
  die "the cookie gate is not responding as expected (got ${GATE_CODE:-no response})"
fi

trap - ERR

cat <<EOF

Done. The console is now served through nginx with cookie authentication.

  login user : $LOGIN_USER
  nginx conf : $CONF_DST
  htpasswd   : $HTPASSWD
  ttyd       : 127.0.0.1:$TTYD_BACKEND_PORT (loopback only, no auth)
  secret     : in $CONF_DST as cw_session (keep it secret — it bypasses the password)
  backup     : $ENV_BAK

Reload on the iPhone: it prompts ONCE and the WebSocket now connects, because
the session cookie rides the handshake.

Verify:
  # ttyd must NOT be reachable directly any more (expect 000):
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://192.168.0.156:$TTYD_BACKEND_PORT/

  # unauthenticated browser is sent to the login (expect 302):
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 http://127.0.0.1:7681/

  # with a cookie the console opens, WebSocket included (expect 200):
  J=\$(mktemp); curl -s -o /dev/null -c "\$J" -u '$LOGIN_USER:YOURPASSWORD' http://127.0.0.1:7681/cw-login
  curl -s -o /dev/null -b "\$J" -w '%{http_code}\n' --max-time 8 http://127.0.0.1:7681/

To revert:
  sudo rm -f $CONF_DST
  sudo systemctl stop nginx
  sudo cp -a $ENV_BAK $ENV_FILE
  sudo systemctl restart copilot-web
EOF
