#!/usr/bin/env bash
#
# Test the copilot-web service end to end with curl.
#
# Read-only: it changes nothing. Safe to run any time, and after any proxy change.
#
#   ./test-service.sh                                    # anonymous checks only
#   ./test-service.sh https://oaiccopilot.duckdns.org    # override the URL
#
# For the authenticated checks, supply the credentials the proxy (or ttyd) asks
# for. They are read from the environment so they never appear in `ps`:
#
#   COPILOT_USER=me COPILOT_PASS=secret ./test-service.sh
#
# Without credentials the script still runs every anonymous check and reports
# which results it could not determine.

set -uo pipefail

URL="${1:-${PUBLIC_URL:-https://oaiccopilot.duckdns.org}}"
URL="${URL%/}"
USER_="${COPILOT_USER:-}"
PASS_="${COPILOT_PASS:-}"
LAN="${COPILOT_LAN:-http://192.168.0.156:7681}"
TIMEOUT=12

WS_HEADERS=(
  --http1.1
  -H "Connection: Upgrade"
  -H "Upgrade: websocket"
  -H "Sec-WebSocket-Version: 13"
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
  -H "Sec-WebSocket-Protocol: tty"
)

PASS_COUNT=0
FAIL_COUNT=0

# Print a result and tally it against what was expected.
report() { # report <label> <actual> <expected...>
  local label="$1" actual="$2"; shift 2
  local expected=" $* " verdict
  if [[ "$expected" == *" $actual "* ]]; then
    verdict="\033[32mok\033[0m"; PASS_COUNT=$((PASS_COUNT + 1))
  else
    verdict="\033[31mFAIL\033[0m"; FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  printf '  %-30s %-6s %b  (expected %s)\n' "$label" "$actual" "$verdict" "$*"
}

status() { curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$@" 2>/dev/null || echo "000"; }

echo
echo "Testing copilot-web — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  public: $URL"
[[ -n "$USER_" ]] && echo "  credentials: supplied" || echo "  credentials: NOT supplied (authenticated checks will be skipped)"
echo

echo "[1] Local — direct to ttyd, bypasses the proxy"
if [[ -n "$USER_" ]]; then
  report "page (basic auth)"  "$(status -u "$USER_:$PASS_" "$LAN/")"        200
else
  report "page (no auth)"     "$(status "$LAN/")"                         407 401 200
fi
echo

echo "[2] Public — must reject anonymous access"
report "page, anonymous"      "$(status "$URL/")"                           401 403
report "page, forged header"  "$(status -H 'X-Copilot-Auth: forged' "$URL/")" 401 403 407
report "ws, no credentials"   "$(status "${WS_HEADERS[@]}" "$URL/ws")"       401 403
echo

echo "[3] Public — the authenticated path (what a browser does)"
if [[ -z "$USER_" ]]; then
  printf '  %-30s %s\n' "skipped" "set COPILOT_USER / COPILOT_PASS to run"
else
  report "page (authenticated)"  "$(status -u "$USER_:$PASS_" "$URL/")"        200
  WS_AUTH="$(status -u "$USER_:$PASS_" "${WS_HEADERS[@]}" "$URL/ws")"
  report "ws (authenticated)"    "$WS_AUTH"                                     101
  if [[ "$WS_AUTH" == "407" ]]; then
    echo
    echo "  -> You authenticated, but the proxy is NOT injecting the auth header"
    echo "     that ttyd requires. Add a FIXED value on the proxy host's Advanced"
    echo "     config and reload nginx:"
    echo "       proxy_set_header X-Copilot-Auth \"<fixed random string>\";"
    echo "     A pass-through such as \$http_x_copilot_auth does not work."
  fi
fi
echo

echo "[4] Verdict"
if (( FAIL_COUNT == 0 && PASS_COUNT > 0 )); then
  printf '  \033[32mall checks passed\033[0m — the service is correctly protected.\n'
  if [[ -n "$USER_" ]]; then
    echo "  Authenticated WebSocket works: the phone should connect."
  fi
else
  printf '  \033[31m%d check(s) failed\033[0m — see above.\n' "$FAIL_COUNT"
fi
echo
