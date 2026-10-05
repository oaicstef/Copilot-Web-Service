#!/usr/bin/env bash
#
# Diagnose the copilot-web chain end to end: client -> proxy -> ttyd -> tmux.
#
# Read-only: it changes nothing. Run on the Pi as a normal user (no sudo):
#
#   ./diagnose.sh
#   ./diagnose.sh https://oaiccopilot.duckdns.org     # override the public URL
#
# It answers the three questions that actually matter:
#   1. Is ttyd running, and in which auth mode?
#   2. Does the local ttyd accept a connection?
#   3. Does the PUBLIC endpoint authenticate anyone, or is it open?

set -uo pipefail

PUBLIC_URL="${1:-${PUBLIC_URL:-https://oaiccopilot.duckdns.org}}"
PUBLIC_URL="${PUBLIC_URL%/}"
TIMEOUT=10
WS_ARGS=(
  --http1.1
  -H "Connection: Upgrade" -H "Upgrade: websocket"
  -H "Sec-WebSocket-Version: 13"
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
  -H "Sec-WebSocket-Protocol: tty"
)

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m%s\033[0m\n' "$*"; }
warn()  { printf '  \033[33m%s\033[0m\n' "$*"; }
bad()   { printf '  \033[31m%s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }

# HTTP status, or the curl error, so "no response" is distinguishable from "rejected".
code() { # code <curl args...>
  curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$@" 2>/dev/null || echo "000"
}

echo
bold "copilot-web diagnostics — $(date '+%Y-%m-%d %H:%M:%S')"
echo

# ---------------------------------------------------------------- service ---
bold "[1] Service"
if systemctl is-active --quiet copilot-web; then
  ok "copilot-web.service: active"
else
  bad "copilot-web.service: NOT active — systemctl status copilot-web"
fi

TTYD_ARGS="$(ps -eo args 2>/dev/null | grep '[t]tyd' | head -1)"
if [[ -z "$TTYD_ARGS" ]]; then
  bad "no ttyd process found"
  echo
  exit 1
fi

# ------------------------------------------------------------------ flags ---
LAN_IP="$(sed -n 's/.* -i \([^ ]*\).*/\1/p' <<<"$TTYD_ARGS")"
PORT="$(sed -n 's/.* -p \([^ ]*\).*/\1/p' <<<"$TTYD_ARGS")"
LAN_IP="${LAN_IP:-0.0.0.0}"
PORT="${PORT:-7681}"

AUTH_HEADER=""
CREDENTIAL=""
ORIGIN_CHECK="off"
[[ "$TTYD_ARGS" =~ (^|\ )-H\ ([^ ]+) ]] && AUTH_HEADER="${BASH_REMATCH[2]}"
[[ "$TTYD_ARGS" =~ (^|\ )-c\ ([^ ]+) ]] && CREDENTIAL="${BASH_REMATCH[2]}"
[[ "$TTYD_ARGS" =~ (^|\ )-O(\ |$) ]] && ORIGIN_CHECK="ON"

bold "[2] ttyd configuration"
if [[ -n "$AUTH_HEADER" ]]; then
  ok "auth: header mode (-H $AUTH_HEADER)"
  info "ttyd accepts ANY non-empty value: the proxy must overwrite the client's."
elif [[ -n "$CREDENTIAL" ]]; then
  ok "auth: HTTP basic (-c …)"
  warn "the password is visible in 'ps' to any local user"
else
  bad "no -H or -c: ttyd may be unauthenticated"
fi
info "origin check (-O): $ORIGIN_CHECK"
info "bind: $LAN_IP:$PORT"
if [[ "$ORIGIN_CHECK" == "ON" ]]; then
  warn "-O rejects iOS Home Screen mode (WebKit sends Origin: null)"
fi
echo

# ------------------------------------------------------ local, via ttyd ----
LOCAL="http://${LAN_IP}:${PORT}"
[[ "$LAN_IP" == "0.0.0.0" ]] && LOCAL="http://127.0.0.1:${PORT}"
bold "[3] Local — direct to ttyd ($LOCAL, bypasses the proxy)"

if [[ -n "$AUTH_HEADER" ]]; then
  C_NO="$(code "$LOCAL/")"
  C_YES="$(code -H "$AUTH_HEADER: probe" "$LOCAL/")"
  info "page, no header       -> $C_NO"
  info "page, with header     -> $C_YES"
  if [[ "$C_YES" == "200" ]]; then ok "ttyd is serving"; else bad "ttyd is not accepting the header"; fi
  WS="$(code "${WS_ARGS[@]}" -H "$AUTH_HEADER: probe" "$LOCAL/ws")"
elif [[ -n "$CREDENTIAL" ]]; then
  C_NO="$(code "$LOCAL/")"
  C_YES="$(code -u "$CREDENTIAL" "$LOCAL/")"
  info "page, no credentials  -> $C_NO"
  info "page, with credentials-> $C_YES"
  if [[ "$C_YES" == "200" ]]; then ok "ttyd is serving"; else bad "credentials rejected"; fi
  WS="$(code "${WS_ARGS[@]}" -u "$CREDENTIAL" "$LOCAL/ws")"
else
  WS="$(code "${WS_ARGS[@]}" "$LOCAL/ws")"
fi
info "WebSocket upgrade     -> $WS  (101 expected)"
[[ "$WS" == "101" ]] && ok "local WebSocket works" || bad "local WebSocket failed"
echo

# ------------------------------------------------------------- public ------
bold "[4] Public — $PUBLIC_URL (through the proxy)"

P_ANON="$(code "$PUBLIC_URL/")"
if [[ -n "$AUTH_HEADER" ]]; then
  P_FORGED="$(code -H "$AUTH_HEADER: forged-by-diagnose" "$PUBLIC_URL/")"
  W_FORGED="$(code "${WS_ARGS[@]}" -H "$AUTH_HEADER: forged-by-diagnose" "$PUBLIC_URL/ws")"
fi
info "page, no credentials   -> $P_ANON"
info "page, forged header    -> ${P_FORGED:-n/a}"
info "WebSocket, forged hdr  -> ${W_FORGED:-n/a}"
echo

# ------------------------------------------------------------- verdict -----
bold "[5] Verdict"

OPEN=""
[[ -n "$AUTH_HEADER" ]] && [[ "$P_FORGED" == "200" || "$W_FORGED" == "101" ]] && OPEN=1

if [[ -n "$OPEN" ]]; then
  bad "CRITICAL — the public endpoint is OPEN to anyone."
  info "A forged '$AUTH_HEADER: anything' is accepted (page ${P_FORGED}, ws ${W_FORGED})."
  info "ttyd never validates the value, so the proxy MUST overwrite it."
  echo
  info "Fix now, either:"
  info "  a) put a FIXED value in the proxy host's Advanced config and reload nginx:"
  info "       proxy_set_header $AUTH_HEADER \"<any fixed random string>\";"
  info "     (a pass-through like \$http_x_... does NOT protect it)"
  info "  b) or fail closed on this Pi until then:  sudo ./install.sh"
elif [[ "$P_ANON" == "200" ]]; then
  bad "the public endpoint serves content with NO authentication at all."
  info "Add an nginx-proxy-manager Access List to the proxy host (on the N100)."
elif [[ "$P_ANON" == "407" ]]; then
  warn "the proxy is NOT injecting the auth header (ttyd answered 407)."
  info "Add to the proxy host's Advanced config, then reload nginx:"
  info "  proxy_set_header $AUTH_HEADER \"<any fixed random string>\";"
  info "The browser labels 407 'Proxy Authentication Required'; it is not a proxy issue."
elif [[ "$P_ANON" == "401" || "$P_ANON" == "403" ]]; then
  ok "the proxy is authenticating (HTTP $P_ANON) — this is the correct state."
  info "If iOS still fails, the WebSocket handshake is not getting credentials."
  info "nginx does send a proper 401 challenge, so this should work; if not, use a VPN"
  info "or cookie auth (browsers send cookies on WS handshakes, Basic creds are unreliable)."
else
  warn "unexpected response ${P_ANON} — check DNS, the tunnel, and that nginx is up."
fi
echo
