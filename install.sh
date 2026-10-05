#!/usr/bin/env bash
#
# Installs / upgrades the mobile-friendly Copilot web console on the Pi.
#
# Run from the project directory, as a normal user, with sudo:
#   cd ~/src/copilot-web && npm run build && sudo ./install.sh
#
#   sudo ./install.sh --auth-header X-Copilot-Auth
#     switches ttyd to reverse-proxy header auth so the password stops
#     appearing in the process argument list (see the snippet it prints).
#
# It is idempotent: the existing systemd unit is backed up first, the wrapper
# and unit are re-installed, and the environment file is only appended to.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DST="/etc/systemd/system/copilot-web.service"
WRAPPER_DST="/usr/local/bin/copilot-web-run"
ENV_DIR="/etc/copilot-ttyd"
ENV_FILE="$ENV_DIR/env"
STAMP="$(date +%Y%m%d-%H%M%S)"

usage() {
  cat <<'EOF'
Usage: sudo ./install.sh [--auth-header <Header-Name>] [--public-url <URL>] [--allow-ios]

  --auth-header <Name>  Switch ttyd to reverse-proxy header authentication.
                        ttyd then requires `Name` on every request, so no
                        credential lives in the process argument list. The
                        proxy must authenticate the user, strip any
                        client-supplied `Name` and inject its own.
                        Without this flag ttyd keeps using TTYD_CREDENTIAL.
  --allow-ios           Set TTYD_CHECK_ORIGIN=0 so iOS can connect from a
                        Home Screen icon. Safari sends `Origin: null` (or no
                        Origin) in standalone mode, which ttyd's -O refuses:
                        the page loads but the terminal never connects. This
                        removes a cross-site WebSocket protection, so use it
                        only if you need the Home Screen icon.
  --public-url <URL>    With --auth-header: after installing, check that the
                        proxy really overwrites the header, by requesting the
                        URL with a forged header. ttyd only checks that the
                        header is present, so an unverified proxy leaves the
                        console open to anyone. Strongly recommended, e.g.
                        --public-url https://oaiccopilot.duckdns.org
EOF
}

AUTH_HEADER_NAME=""
ALLOW_IOS=""
PUBLIC_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --auth-header)
      AUTH_HEADER_NAME="${2:-}"
      if [[ -z "$AUTH_HEADER_NAME" ]]; then
        echo "error: --auth-header needs a header name (e.g. X-Copilot-Auth)." >&2
        exit 1
      fi
      shift 2
      ;;
    --public-url)
      PUBLIC_URL="${2:-}"
      if [[ -z "$PUBLIC_URL" ]]; then
        echo "error: --public-url needs a URL (e.g. https://oaiccopilot.duckdns.org)." >&2
        exit 1
      fi
      shift 2
      ;;
    --allow-ios)
      ALLOW_IOS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

generate_secret() {
  # `|| true` keeps SIGPIPE from `head` closing the pipe off `pipefail`.
  head -c 32 /dev/urandom | base64 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32 || true
}

# Set KEY=VALUE in the environment file, replacing any existing assignment.
env_set() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run with sudo: sudo $0" >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/web/index.html" ]]; then
  echo "error: $PROJECT_DIR/web/index.html is missing." >&2
  echo "       Build it as the project owner first: npm run build" >&2
  exit 1
fi

echo "==> Backing up the current unit (if any)"
if [[ -f "$UNIT_DST" ]]; then
  cp -a "$UNIT_DST" "${UNIT_DST}.bak-${STAMP}"
  echo "    ${UNIT_DST}.bak-${STAMP}"
else
  echo "    no existing unit, nothing to back up"
fi

echo "==> Installing wrapper -> $WRAPPER_DST"
install -o root -g root -m 0755 "$PROJECT_DIR/systemd/copilot-web-run" "$WRAPPER_DST"

echo "==> Installing unit -> $UNIT_DST"
install -o root -g root -m 0644 "$PROJECT_DIR/systemd/copilot-web.service" "$UNIT_DST"

echo "==> Checking environment file $ENV_FILE"
install -d -o root -g root -m 0755 "$ENV_DIR"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

GENERATED_PASSWORD=""
AUTH_HEADER_SECRET=""

if [[ -n "$AUTH_HEADER_NAME" ]]; then
  # Header mode: the proxy authenticates and injects the header, so ttyd never
  # holds a credential and nothing shows up in `ps`.
  AUTH_HEADER_SECRET="$(sed -n 's/^TTYD_AUTH_HEADER_VALUE=//p' "$ENV_FILE" | head -n1)"
  if [[ -z "$AUTH_HEADER_SECRET" ]]; then
    AUTH_HEADER_SECRET="$(generate_secret)"
  fi
  env_set TTYD_AUTH_HEADER "$AUTH_HEADER_NAME"
  env_set TTYD_AUTH_HEADER_VALUE "$AUTH_HEADER_SECRET"
  if grep -q '^TTYD_CREDENTIAL=' "$ENV_FILE"; then
    sed -i 's/^TTYD_CREDENTIAL=/#TTYD_CREDENTIAL=/' "$ENV_FILE"
    echo "    commented out TTYD_CREDENTIAL (unused in header mode)"
  fi
  echo "    header auth enabled: ttyd now requires '${AUTH_HEADER_NAME}'"
else
  # Basic-auth mode. Clear any header left over from an earlier --auth-header
  # run: ./copilot-web-run prefers -H whenever TTYD_AUTH_HEADER is set, so
  # leaving it in place would silently keep header mode while this script
  # reported a new password.
  if grep -qE '^TTYD_AUTH_HEADER=' "$ENV_FILE"; then
    sed -i 's/^TTYD_AUTH_HEADER=/#TTYD_AUTH_HEADER=/' "$ENV_FILE"
    sed -i 's/^TTYD_AUTH_HEADER_VALUE=/#TTYD_AUTH_HEADER_VALUE=/' "$ENV_FILE"
    echo "    disabled header auth (TTYD_AUTH_HEADER commented out)"
  fi
  # A header-mode run comments the credential out; restore it rather than
  # generating a new one, so the existing password keeps working.
  if grep -qE '^#TTYD_CREDENTIAL=' "$ENV_FILE"; then
    sed -i 's/^#TTYD_CREDENTIAL=/TTYD_CREDENTIAL=/' "$ENV_FILE"
    echo "    restored TTYD_CREDENTIAL from the previously commented-out line"
  fi
  if ! grep -q '^TTYD_CREDENTIAL=' "$ENV_FILE"; then
    GENERATED_PASSWORD="$(generate_secret | head -c 20)"
    {
      echo ""
      echo "# Added by copilot-web install on ${STAMP}."
      echo "# Prefer header auth: sudo ./install.sh --auth-header X-Copilot-Auth"
      echo "TTYD_CREDENTIAL=admin:${GENERATED_PASSWORD}"
    } >>"$ENV_FILE"
    echo "    generated a new credential (the old one was embedded in the unit)"
  fi
fi

if ! grep -q '^TTYD_LISTEN=' "$ENV_FILE"; then
  LAN_IP="$(hostname -I | awk '{print $1}')"
  {
    echo "# Bind to the LAN interface only (set 127.0.0.1 if the proxy runs on this host)."
    echo "# NOTE: a DHCP address change requires updating this value; prefer a static lease."
    echo "TTYD_LISTEN=${LAN_IP}"
  } >>"$ENV_FILE"
  echo "    set TTYD_LISTEN=${LAN_IP}"
fi

# xterm's scrollback, and the size of the terminal history the console can
# scroll back through (see TTYD_SCROLLBACK in the wrapper).
grep -q '^TTYD_SCROLLBACK=' "$ENV_FILE" || env_set TTYD_SCROLLBACK 5000

# ttyd's -O, written explicitly so the setting is discoverable in the env file
# instead of only being implied by the wrapper's default.
grep -q '^TTYD_CHECK_ORIGIN=' "$ENV_FILE" || env_set TTYD_CHECK_ORIGIN 1
if [[ -n "$ALLOW_IOS" ]]; then
  env_set TTYD_CHECK_ORIGIN 0
  echo "    TTYD_CHECK_ORIGIN=0 (iOS Home Screen mode can connect)"
fi

echo "==> Reloading systemd and restarting copilot-web"
systemctl daemon-reload
systemctl enable copilot-web >/dev/null 2>&1 || true
systemctl restart copilot-web

sleep 1
systemctl --no-pager --lines=0 status copilot-web || true

echo
if [[ -n "$AUTH_HEADER_NAME" ]]; then
  echo "Next: let the reverse proxy authenticate and inject the header."
  echo "Attach an Access List to the proxy host, then add to its Advanced config"
  echo "(full example with rate limiting: deploy/nginx-copilot.conf):"
  echo
  echo "    proxy_set_header ${AUTH_HEADER_NAME} \"${AUTH_HEADER_SECRET}\";"
  echo
  echo "The proxy MUST replace any client-supplied ${AUTH_HEADER_NAME}, otherwise a"
  echo "client can bypass it: ttyd only checks that the header is present."
  echo
  echo "The value is stored in ${ENV_FILE} as TTYD_AUTH_HEADER_VALUE (mode 600)."
  echo
  # ttyd's -H only checks that the header is PRESENT and non-empty — it never
  # validates the value. That is deliberate: the proxy is supposed to REPLACE
  # any client-supplied copy. Until it does, anyone can reach the console by
  # adding the header themselves, which is an unauthenticated remote shell.
  echo "SECURITY — do not skip: ttyd accepts ANY non-empty '${AUTH_HEADER_NAME}',"
  echo "so the proxy MUST overwrite a client-supplied copy. Until it does, this"
  echo "endpoint is open to anyone who sends the header. Verify with:"
  echo
  printf "    curl -s -o /dev/null -w '%%{http_code}\\n' -H '%s: forged' %s/\\n" \
    "$AUTH_HEADER_NAME" "${PUBLIC_URL:-https://YOUR-HOST}"
  echo "    # 200 = STILL OPEN (fix the proxy)   401/403/407 = overwrite is working"
  echo
fi

if [[ -n "$AUTH_HEADER_NAME" && -n "$PUBLIC_URL" ]]; then
  echo "==> Verifying that the proxy overwrites ${AUTH_HEADER_NAME}"
  BYPASS_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "${AUTH_HEADER_NAME}: forged-by-install-check" "$PUBLIC_URL/" 2>/dev/null || true)"
  case "${BYPASS_CODE:-none}" in
    200)
      echo "    ** BYPASS DETECTED **" >&2
      echo "    ${PUBLIC_URL} returned 200 for a forged ${AUTH_HEADER_NAME}." >&2
      echo "    The proxy is NOT overwriting it, so anyone on the internet can" >&2
      echo "    open this console. Add a FIXED value on the proxy:" >&2
      echo "        proxy_set_header ${AUTH_HEADER_NAME} \"<TTYD_AUTH_HEADER_VALUE>\";" >&2
      echo "    A pass-through (e.g. \$http_x_...) does NOT protect it. Reload" >&2
      echo "    nginx on the proxy, then re-check. To fail closed meanwhile:" >&2
      echo "        sudo $0            # back to basic auth" >&2
      ;;
    401|403|407)
      echo "    ok — forged header rejected (${BYPASS_CODE})"
      ;;
    *)
      echo "    inconclusive (${BYPASS_CODE}) — verify manually with the curl above"
      ;;
  esac
  echo
fi
if [[ -n "$ALLOW_IOS" ]]; then
  echo "The origin check is now OFF (TTYD_CHECK_ORIGIN=0): ttyd accepts WebSocket"
  echo "upgrades regardless of Origin. That is what makes iOS Home Screen mode work."
  echo "Re-run without --allow-ios to restore the check."
  echo
fi
if [[ -n "$GENERATED_PASSWORD" ]]; then
  echo "New login for the web console:"
  echo "    username: admin"
  echo "    password: ${GENERATED_PASSWORD}"
  echo "    (stored in ${ENV_FILE}, mode 600)"
  echo
fi
echo "Rollback:  sudo cp ${UNIT_DST}.bak-${STAMP} ${UNIT_DST} && sudo systemctl daemon-reload && sudo systemctl restart copilot-web"
echo "Logs:      journalctl -u copilot-web -f"
