#!/usr/bin/env bash
# =====================================================================================================
# caddy-smoke.sh — runs the real deploy/caddy/Caddyfile under Caddy 2.8.4 with an echo upstream (task X-022).
#
#   bash deploy/caddy/test/caddy-smoke.sh                 # caddy 2.8.4 on PATH
#   CADDY=/tmp/caddy bash deploy/caddy/test/caddy-smoke.sh
#
# Needs no root and no network beyond loopback: Caddy 2.8.4 (CADDY, else `caddy` on PATH), Node 22 (SMOKE_NODE,
# else `node`), curl, openssl and awk. The app ports 3000, 3001, 3002, 3100 and 4000 (echo upstream), 8080 and 8443
# (Caddy) must be free on 127.0.0.1, and nothing may listen on 2019. CI runs it in the "deploy-files" job of
# .github/workflows/ci.yml. How to read a failure: deploy/caddy/test/README.md.
#
# The test copy of the Caddyfile differs from the production file only in its global options block: the admin
# socket moves to the temporary folder, and `local_certs`, `skip_install_trust`, `default_bind 127.0.0.1`,
# `http_port 8080` and `https_port 8443` are added. The production `ask` URL (127.0.0.1:3100) already reaches
# echo-upstream.mjs, which answers 200 only for acme.ota.localhost. Every snippet and site block is the production
# text byte for byte; the hosts come from the environment of the Caddy process: PLATFORM_BASE_DOMAIN=
# platform.localhost, STOREFRONT_BASE_DOMAIN=ota.localhost, a random VELEXIS_EDGE_SECRET, and VELEXIS_ROOT (the
# prefix of the /srv/velexis folders: a fixture storefront release and the maintenance page of deploy/caddy).
#
# What it proves (docs/mvp/plans/foundation-tasks.md, X-022; each line ends with the acceptance criterion):
#   - the production Caddyfile validates and is `caddy fmt` clean (AC2); with an empty environment its host names
#     are exactly the placeholder hosts of docs/mvp/decisions.md §4 and its admin API is the unix socket
#     /run/caddy/admin.sock (AC3);
#   - on acme.ota.localhost, /api/x reaches the OTA API (4000) as /x with X-Velexis-Edge equal to the secret and
#     X-Velexis-Host equal to the host, even when the client sends forged ones; /api/internal/* and
#     /api/health/* (except live) never reach it, also as path variants (//, upper case, %2F, ../);
#   - the storefront sends its CSP (with `worker-src 'none'`), /assets/* is `immutable` and the rest `no-cache`;
#   - the airline-card page (/checkout/pay-airline.html and /checkout/pay-airline, task OFE-014, OADR-0017 point 3)
#     gets its own CSP without any Stripe host instead of the storefront's, `Cross-Origin-Opener-Policy: same-origin`
#     and `Cache-Control: no-store`, also through path variants that serve it; no other storefront path (pages,
#     assets, the 404 page, the /api proxy, whose upstream sends COOP `same-origin` as the APIs' helmet does) sends
#     COOP `same-origin`;
#   - on api.ota.localhost and api.platform.localhost, /internal/* and /health/ready (and the same variants)
#     answer 404 without reaching the upstream, /health/live reaches it, and client copies of the edge headers are
#     removed;
#   - an unknown host (evil.localhost) and a storefront key the `ask` endpoint refuses get no certificate: the
#     TLS handshake fails after Caddy asked, and nothing is stored;
#   - the portal and both admin hosts reach their app (3000, 3001, 3002) with the security headers;
#   - with the upstream stopped, platform.localhost and both admin hosts serve the maintenance page with 503, and
#     the API hosts (and the storefront /api) the JSON SERVICE_UNAVAILABLE envelope with the request id;
#   - the admin API answers only on the unix socket: `caddy reload --config <test copy>` succeeds through it
#     after a header change and the new header is served, Caddy listens on TCP only on 8080 and 8443, and
#     nothing listens on TCP 2019;
#   - and, for ADR-0027 row 4, TLS 1.2 and 1.3 are accepted, TLS 1.1 is refused, every host sends HSTS (error
#     pages included), and neither the edge secret nor a client's forged copy reaches Caddy's log;
#   - on every host (FIX-W29-SECURITY), a request whose query, `Referer` and redirect `Location` carry the values of
#     the Caddyfile's `(log_query_filter)` (signatures and tokens, Stripe's client secrets of the 3-D Secure return, and
#     the e-mail addresses, names, searches and return paths of the portal and the admin sites) and whose
#     `Next-Router-State-Tree` holds a page's query still succeeds, reaches its app with every value, and leaves none
#     of them in its access log line, which keeps the other values (`payment_intent`, `redirect_status`, ...).
#
# Settings (environment): CADDY, SMOKE_NODE, SMOKE_TMPDIR (parent of the temporary folder; default TMPDIR or
# /tmp; the admin socket path must stay under 100 bytes), SMOKE_KEEP=1 (keep the temporary folder and its logs).
# =====================================================================================================
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/../.." && pwd)"
CADDYFILE="$DEPLOY/caddy/Caddyfile"
MAINTENANCE="$DEPLOY/caddy/maintenance/index.html"

CADDY_VERSION=2.8.4
HTTP_PORT=8080
HTTPS_PORT=8443
UPSTREAM_PORTS=(3000 3001 3002 3100 4000) # every app port the Caddyfile proxies to (architecture.md §3)
PLATFORM=platform.localhost
STOREFRONT=ota.localhost
TENANT="acme.$STOREFRONT"         # the only host the echo upstream's ask endpoint allows
REFUSED="other.$STOREFRONT"       # a storefront key the ask endpoint refuses
UNKNOWN=evil.localhost            # any other host name (the custom-domain catch-all)
PROD_ADMIN=unix//run/caddy/admin.sock
# decisions.md §4: the host names of the production file when caddy.env sets nothing.
PLACEHOLDER_HOSTS="*.ota.example.com admin.ota.example.com admin.platform.example.com api.ota.example.com api.platform.example.com platform.example.com"
# deployment-single-vm.md §6: the storefront release and the maintenance page, without any VELEXIS_ROOT prefix.
PROD_ROOTS="/srv/velexis/current/storefront /srv/velexis/maintenance"
CSP_DIRECTIVES=("default-src 'self'" "frame-ancestors 'none'" "object-src 'none'" "base-uri 'self'" "worker-src 'none'")
# The general storefront CSP is the one that allows Stripe.js (the card page's).
STOREFRONT_SCRIPTS="script-src 'self' https://js.stripe.com https://*.js.stripe.com"
# OADR-0017 point 3: the airline-card page's own CSP, without any Stripe host, and `worker-src 'none'` as on every
# storefront page.
PAY_AIRLINE_DIRECTIVES=("default-src 'self'" "script-src 'self'" "connect-src 'self'" "frame-src 'none'"
  "img-src 'self' data:" "style-src 'self'" "font-src 'self'" "form-action 'self'" "frame-ancestors 'none'"
  "base-uri 'self'" "object-src 'none'" "worker-src 'none'")

FAILED=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILED=1; }
die() { printf 'FAIL %s\n' "$*"; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
check() { # description command... -> one PASS or FAIL line
  local what="$1"
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
not() { ! "$@"; }
retry() { # tries command...: run every 0.5 s until it succeeds
  local n="$1"
  shift
  while ! "$@"; do
    n=$((n - 1))
    [ "$n" -gt 0 ] || return 1
    sleep 0.5
  done
}
redact() { # text -> the text with the edge secret masked (failure details never print it)
  local text="$1"
  if [ -n "${EDGE_SECRET:-}" ]; then text="${text//"$EDGE_SECRET"/<edge secret>}"; fi
  printf '%s' "$text"
}
same() { # what actual expected -> PASS, or FAIL with both values
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1"
    printf '     expected: %s\n     got:      %s\n' "$(redact "$3")" "$(redact "$2")"
  fi
}

# ---- 0. tools and ports -----------------------------------------------------------------------------------
CADDY="${CADDY:-$(command -v caddy || true)}"
NODE="${SMOKE_NODE:-$(command -v node || true)}"
if [ -z "$CADDY" ] || [ ! -x "$CADDY" ]; then
  die "caddy not found: put Caddy $CADDY_VERSION on PATH or set CADDY (see deploy/caddy/test/README.md)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then die "node not found: set SMOKE_NODE"; fi
for tool in curl openssl awk; do command -v "$tool" >/dev/null || die "$tool is missing"; done
version="$("$CADDY" version | awk '{ print $1 }')"
[ "$version" = "v$CADDY_VERSION" ] || die "this test pins Caddy $CADDY_VERSION; $CADDY is $version"

tcp_tables() { local f; for f in /proc/net/tcp /proc/net/tcp6; do [ -r "$f" ] && printf '%s\n' "$f"; done; }
listening() { # port -> true if any TCP socket of this network namespace listens on it (IPv4 or IPv6)
  local hex
  hex="$(printf ':%04X' "$1")"
  # shellcheck disable=SC2046 # one argument per table file
  awk -v p="$hex" 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == p { found = 1 } END { exit !found }' \
    $(tcp_tables)
}
for port in "${UPSTREAM_PORTS[@]}" "$HTTP_PORT" "$HTTPS_PORT" 2019; do
  if listening "$port"; then die "TCP port $port is already in use on this machine; stop what listens there first"; fi
done

# ---- 1. the production Caddyfile (AC2, AC3) -----------------------------------------------------------------
step "The production Caddyfile: validate, fmt, placeholder hosts, admin socket"
WORK_PARENT="${SMOKE_TMPDIR:-${TMPDIR:-/tmp}}"
TMP="$(mktemp -d "$WORK_PARENT/caddy-smoke.XXXXXX")"
SOCK="$TMP/admin.sock"
ECHO_PID=""
CADDY_PID=""

stop() { # pid: TERM, then wait up to 5 s, then KILL
  local pid="$1" n=10
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  while kill -0 "$pid" 2>/dev/null && [ "$n" -gt 0 ]; do sleep 0.5; n=$((n - 1)); done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  local rc=$?
  stop "$CADDY_PID"
  stop "$ECHO_PID"
  if [ "$rc" -ne 0 ] || [ "$FAILED" -ne 0 ]; then
    for log in caddy echo; do
      if [ -s "$TMP/$log.log" ]; then
        printf '\n--- last lines of %s.log ---\n' "$log"
        redact "$(tail -n 15 "$TMP/$log.log" | cut -c1-400)"
        printf '\n'
      fi
    done
  fi
  if [ "${SMOKE_KEEP:-0}" = 1 ]; then
    echo "SMOKE_KEEP=1: kept $TMP"
  else
    rm -rf "$TMP"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
[ "${#SOCK}" -lt 100 ] || die "admin socket path too long for a unix socket ($SOCK); set SMOKE_TMPDIR=/tmp"

mkdir -p "$TMP/home" "$TMP/data" "$TMP/config"
# Caddy sees only this environment: no proxy settings, no developer variables, its own data folder.
caddy_env=(env -i "PATH=$PATH" "HOME=$TMP/home" "XDG_DATA_HOME=$TMP/data" "XDG_CONFIG_HOME=$TMP/config")

validates() {
  "${caddy_env[@]}" VELEXIS_EDGE_SECRET=smoke "$CADDY" validate --config "$CADDYFILE" --adapter caddyfile \
    >"$TMP/validate.log" 2>&1 || { cat "$TMP/validate.log"; return 1; }
}
check "caddy validate accepts the production Caddyfile [X-022 AC2]" validates
fmt_clean() { # caddy fmt --diff exits 1 on a file that is not formatted; print only the changed lines then
  "$CADDY" fmt --diff "$CADDYFILE" >"$TMP/fmt.diff" 2>&1 || { grep -E '^[-+] |^Error' "$TMP/fmt.diff"; return 1; }
}
check "caddy fmt --diff is clean for the production Caddyfile [X-022 AC2]" fmt_clean

if "${caddy_env[@]}" "$CADDY" adapt --config "$CADDYFILE" --adapter caddyfile >"$TMP/prod.json" 2>"$TMP/adapt.log"; then
  # shellcheck disable=SC2016 # JavaScript, not shell
  prod_facts="$("$NODE" -e '
    const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const hosts = new Set();
    const roots = new Set();
    const walk = (v) => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "host" && Array.isArray(x)) { x.forEach((h) => hosts.add(h)); }
          else if (k === "root" && typeof x === "string") { roots.add(x); }
          else { walk(x); }
        }
      }
    };
    walk(cfg.apps?.http);
    for (const p of cfg.apps?.tls?.automation?.policies ?? []) { (p.subjects ?? []).forEach((h) => hosts.add(h)); }
    process.stdout.write(`${cfg.admin?.listen ?? ""}\n${[...hosts].sort().join(" ")}\n${[...roots].sort().join(" ")}\n`);
  ' "$TMP/prod.json")"
  same "with an empty environment the host names are the placeholders of decisions.md §4 [X-022 AC3]" \
    "$(sed -n 2p <<<"$prod_facts")" "$PLACEHOLDER_HOSTS"
  same "the production admin API is the unix socket /run/caddy/admin.sock [X-022 AC3]" \
    "$(sed -n 1p <<<"$prod_facts")" "$PROD_ADMIN"
  # VELEXIS_ROOT (test only) must expand to nothing on the VM: no default may move the production folders.
  same "with an empty environment the file roots are the /srv/velexis folders of the VM" \
    "$(sed -n 3p <<<"$prod_facts")" "$PROD_ROOTS"
else
  cat "$TMP/adapt.log"
  fail "caddy adapt failed on the production Caddyfile [X-022 AC3]"
fi

# ---- 2. the test copy and the fixture folders ------------------------------------------------------------
step "Test copy: production Caddyfile with a test global options block"
TEST_COPY="$TMP/Caddyfile"
# The first line that is only "{" opens the global options block, the next line that is only "}" closes it.
awk -v sock="unix/$SOCK" -v prod="$PROD_ADMIN" -v http_port="$HTTP_PORT" -v https_port="$HTTPS_PORT" '
  state == 0 && /^\{$/ {
    state = 1
    print
    print "\t# caddy-smoke.sh: local CA, loopback test ports, admin socket in the temporary folder"
    print "\tlocal_certs"
    print "\tskip_install_trust"
    print "\tdefault_bind 127.0.0.1"
    print "\thttp_port " http_port
    print "\thttps_port " https_port
    next
  }
  state == 1 && $1 == "admin" {
    if ($0 != "\tadmin " prod) { print "unexpected admin line: " $0 > "/dev/stderr"; exit 3 }
    print "\tadmin " sock
    admin = 1
    next
  }
  state == 1 && /^\}$/ { state = 2 }
  { print }
  END { if (state != 2 || !admin) { print "no global options block with an admin line" > "/dev/stderr"; exit 3 } }
' "$CADDYFILE" >"$TEST_COPY" || die "cannot build the test copy from $CADDYFILE"
after_global() { awk 'state == 2 { print } state == 0 && /^\{$/ { state = 1 } state == 1 && /^\}$/ { state = 2 }' "$1"; }
same_body() { cmp -s <(after_global "$CADDYFILE") <(after_global "$TEST_COPY"); }
check "the test copy keeps every snippet and site block of the production file byte for byte" same_body

ROOT="$TMP/root"
RELEASE="$ROOT/srv/velexis/releases/smoke"
mkdir -p "$ROOT/srv/velexis/maintenance" "$RELEASE/storefront/assets"
cp "$MAINTENANCE" "$ROOT/srv/velexis/maintenance/index.html"
ln -s releases/smoke "$ROOT/srv/velexis/current" # as on the VM: current -> releases/<sha>
printf '<!doctype html>\n<title>Smoke storefront</title>\n<p>storefront index</p>\n' >"$RELEASE/storefront/index.html"
printf '<!doctype html>\n<title>Not found</title>\n<p>storefront 404</p>\n' >"$RELEASE/storefront/404.html"
printf 'export const smoke = 1;\n' >"$RELEASE/storefront/assets/a.js"
mkdir -p "$RELEASE/storefront/checkout"
for page in pay-airline pay-card complete; do
  printf '<!doctype html>\n<title>Smoke %s</title>\n<p>storefront %s</p>\n' "$page" "$page" \
    >"$RELEASE/storefront/checkout/$page.html"
done
printf '<!doctype html>\n<title>Smoke checkout</title>\n<p>storefront checkout</p>\n' >"$RELEASE/storefront/checkout.html"
CARD_PAGE="$RELEASE/storefront/checkout/pay-airline.html"

EDGE_SECRET="smoke-edge-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
FORGED_EDGE="forged-edge-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
caddy_env+=("PLATFORM_BASE_DOMAIN=$PLATFORM" "STOREFRONT_BASE_DOMAIN=$STOREFRONT" "ACME_EMAIL=ops@example.com"
  "VELEXIS_EDGE_SECRET=$EDGE_SECRET" "VELEXIS_ROOT=$ROOT")

# ---- 3. start the echo upstream and Caddy ------------------------------------------------------------------
step "Start echo-upstream.mjs (${UPSTREAM_PORTS[*]}) and Caddy ($HTTP_PORT, $HTTPS_PORT)"
ECHO_PORTS="$(IFS=,; printf '%s' "${UPSTREAM_PORTS[*]}")" ECHO_ASK_ALLOW="$TENANT" \
  "$NODE" "$HERE/echo-upstream.mjs" >"$TMP/echo.log" 2>&1 &
ECHO_PID=$!
echo_ready() {
  kill -0 "$ECHO_PID" 2>/dev/null || die "echo-upstream.mjs exited: $(cat "$TMP/echo.log")"
  grep -q '^ready ' "$TMP/echo.log"
}
retry 40 echo_ready || die "echo-upstream.mjs did not start"
pass "echo upstream listens on ${UPSTREAM_PORTS[*]}"

"${caddy_env[@]}" "$CADDY" run --config "$TEST_COPY" --adapter caddyfile >"$TMP/caddy.log" 2>&1 &
CADDY_PID=$!
CA="$TMP/data/caddy/pki/authorities/local/root.crt"
caddy_up() { kill -0 "$CADDY_PID" 2>/dev/null || die "caddy exited during start-up"; [ -S "$SOCK" ] && [ -s "$CA" ]; }
retry 60 caddy_up || die "caddy did not open its admin socket and local CA"

HEADERS="$TMP/response.headers"
BODY="$TMP/response.body"
STATUS=""
CURL_RC=0
fetch() { # host path [curl options...] -> STATUS, CURL_RC, $HEADERS, $BODY
  local host="$1" path="$2"
  shift 2
  : >"$HEADERS"
  : >"$BODY"
  if STATUS="$(curl -sS --noproxy '*' --max-time 10 --cacert "$CA" --resolve "$host:$HTTPS_PORT:127.0.0.1" \
    -D "$HEADERS" -o "$BODY" -w '%{http_code}' "$@" "https://$host:$HTTPS_PORT$path" 2>"$TMP/curl.err")"; then
    CURL_RC=0
  else
    CURL_RC=$?
  fi
}
header() { # name -> the value of that response header ('' if absent)
  awk -v n="$1" 'BEGIN { n = tolower(n) } { sub(/\r$/, "") }
    index($0, ":") && tolower(substr($0, 1, index($0, ":") - 1)) == n { v = substr($0, index($0, ":") + 1); sub(/^ +/, "", v) }
    END { printf "%s", v }' "$HEADERS"
}
header_count() { # name -> how many times the response carries that header
  awk -v n="$1" 'BEGIN { n = tolower(n) } index($0, ":") && tolower(substr($0, 1, index($0, ":") - 1)) == n { c++ }
    END { printf "%d", c }' "$HEADERS"
}
json() { # dotted path -> the JSON text of that value in the response body ('' if absent or not JSON)
  "$NODE" -e '
    let v;
    try { v = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(0); }
    for (const k of process.argv[1].split(".")) { v = v === null || v === undefined ? undefined : v[k]; }
    if (v !== undefined) { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); }
  ' "$1" <"$BODY"
}
handshake_ok() { fetch "$1" / && [ "$CURL_RC" -eq 0 ]; }
for host in "$PLATFORM" "admin.$PLATFORM" "api.$PLATFORM" "admin.$STOREFRONT" "api.$STOREFRONT"; do
  retry 60 handshake_ok "$host" || die "no TLS for $host after 30 s (curl: $(cat "$TMP/curl.err"))"
done
pass "Caddy serves the five named hosts with certificates of its local CA"

# ---- 4. the admin API: unix socket only ---------------------------------------------------------------------
step "Admin API only on the unix socket"
# On a unix socket Caddy accepts only the Host values "", 127.0.0.1 and ::1 (anything else: 403 host not allowed).
admin_config() { # GET /config/ succeeds and returns the running configuration, whose admin address is this socket
  curl -fsS --noproxy '*' --max-time 5 --unix-socket "$SOCK" -o "$TMP/admin.json" http://127.0.0.1/config/ || return 1
  # shellcheck disable=SC2016 # JavaScript, not shell
  "$NODE" -e '
    const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(cfg.admin?.listen === process.argv[2] ? 0 : 1);
  ' "$TMP/admin.json" "unix/$SOCK"
}
check "the admin API answers GET /config/ on the unix socket $SOCK with the running config [X-022 AC1]" admin_config
check "nothing listens on TCP 2019 [X-022 AC1]" not listening 2019
admin_tcp() { curl -sS --noproxy '*' --max-time 3 -o /dev/null http://127.0.0.1:2019/config/ 2>/dev/null; }
check "http://127.0.0.1:2019/config/ cannot be reached [X-022 AC1]" not admin_tcp
caddy_tcp_ports() { # the TCP ports Caddy's own sockets listen on, sorted
  local inodes
  inodes="$(find "/proc/$CADDY_PID/fd" -type l -printf '%l\n' 2>/dev/null | sed -n 's/^socket:\[\([0-9]*\)\]$/\1/p' | sort -u | tr '\n' ' ')"
  # shellcheck disable=SC2046 # one argument per table file
  awk -v inodes=" $inodes" 'FNR > 1 && $4 == "0A" && index(inodes, " " $10 " ") { split($2, a, ":"); print a[2] }' \
    $(tcp_tables) | while read -r hex; do printf '%d\n' "0x$hex"; done | sort -n -u | tr '\n' ' ' | sed 's/ $//'
}
same "Caddy listens on TCP only on $HTTP_PORT and $HTTPS_PORT (no admin port) [X-022 AC1]" \
  "$(caddy_tcp_ports)" "$HTTP_PORT $HTTPS_PORT"

# ---- 5. the hosted storefront ---------------------------------------------------------------------------------
step "Storefront on $TENANT: edge headers, internal paths, CSP, caching"
fetch "$TENANT" /api/x -H "X-Velexis-Edge: $FORGED_EDGE" -H "X-Velexis-Host: $UNKNOWN"
same "/api/x answers 200 from the upstream [X-022 AC1]" "$STATUS" 200
same "/api/x reaches the OTA API on 4000 [X-022 AC1]" "$(json port)" 4000
same "/api/x arrives as /x (prefix stripped) [X-022 AC1]" "$(json url)" /x
same "X-Velexis-Edge is the edge secret, not the client's forged value [X-022 AC1]" \
  "$(json headers.x-velexis-edge)" "[\"$EDGE_SECRET\"]"
same "X-Velexis-Host is $TENANT, not the client's forged value [X-022 AC1]" \
  "$(json headers.x-velexis-host)" "[\"$TENANT\"]"
fetch "$TENANT" /api/y
same "without client edge headers, X-Velexis-Edge is still the edge secret [X-022 AC1]" \
  "$(json headers.x-velexis-edge)" "[\"$EDGE_SECRET\"]"

# The variants (double slash, upper case, encoded slash, dot segment; sent as they are with --path-as-is) must not
# slip past the matcher either.
STOREFRONT_PRIVATE=(/api/internal/x /api/health/ready /api/health/ready/ /api/health/details
  /api//internal/x /API/Internal/x /api/internal%2Fx /api/health/live/../ready)
for path in "${STOREFRONT_PRIVATE[@]}"; do
  fetch "$TENANT" "$path" --path-as-is -H "X-Velexis-Edge: $FORGED_EDGE"
  same "$path answers 404 [X-022 AC1]" "$STATUS" 404
  same "$path never reaches the OTA API [X-022 AC1]" "$(json port)" ""
done
fetch "$TENANT" /api/health/live
same "/api/health/live reaches the OTA API as /health/live [X-022 AC1]" "$(json port) $(json url)" "4000 /health/live"

csp_ok() { # the CSP of the last response holds the storefront's key directives
  local csp d
  csp="$(header Content-Security-Policy)"
  [ -n "$csp" ] || return 1
  for d in "${CSP_DIRECTIVES[@]}"; do case "; $csp;" in *"; $d;"*) ;; *) return 1 ;; esac; done
}
fetch "$TENANT" /
same "/ answers 200 [X-022 AC1]" "$STATUS" 200
check "/ serves the storefront's index.html [X-022 AC1]" cmp -s "$BODY" "$RELEASE/storefront/index.html"
check "/ has the storefront CSP [X-022 AC1]" csp_ok
same "/ is Cache-Control no-cache [X-022 AC1]" "$(header Cache-Control)" "no-cache"
same "/ has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
same "/ has X-Content-Type-Options nosniff" "$(header X-Content-Type-Options)" nosniff
same "/ hides the Server header" "$(header_count Server)" 0

fetch "$TENANT" /assets/a.js
same "/assets/a.js answers 200 [X-022 AC1]" "$STATUS" 200
same "/assets/a.js is immutable [X-022 AC1]" "$(header Cache-Control)" "public, max-age=31536000, immutable"
check "/assets/a.js has the storefront CSP [X-022 AC1]" csp_ok

fetch "$TENANT" /no/such/page
same "an unknown storefront path answers 404" "$STATUS" 404
check "an unknown storefront path serves the storefront's 404.html" cmp -s "$BODY" "$RELEASE/storefront/404.html"
check "the storefront 404 page has the storefront CSP" csp_ok
same "the storefront 404 page has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
same "the storefront 404 page hides the Server header" "$(header_count Server)" 0

# ---- 5b. the airline-card page (OFE-014, OADR-0017 point 3) ----------------------------------------------------
step "Airline-card page on $TENANT: its own CSP, COOP same-origin and no-store; COOP same-origin nowhere else"
csp_has() { # directive... -> the last response has exactly one CSP, and it holds each directive as written
  local csp d
  [ "$(header_count Content-Security-Policy)" -eq 1 ] || return 1
  csp="$(header Content-Security-Policy)"
  for d in "$@"; do case "; $csp;" in *"; $d;"*) ;; *) return 1 ;; esac; done
}
no_stripe_in_csp() { ! grep -qi stripe <<<"$(header Content-Security-Policy)"; }
coop_values() { # every Cross-Origin-Opener-Policy value of the last response, one per line
  awk '{ sub(/\r$/, "") }
    index($0, ":") && tolower(substr($0, 1, index($0, ":") - 1)) == "cross-origin-opener-policy" {
      v = substr($0, index($0, ":") + 1); sub(/^ +/, "", v); sub(/ +$/, "", v); print v
    }' "$HEADERS"
}
no_coop_same_origin() { ! coop_values | grep -qix 'same-origin'; }
card_page_headers() { # label: the last response is the airline-card page with its own headers
  check "$1 serves the airline-card page" cmp -s "$BODY" "$CARD_PAGE"
  check "$1 has the airline-card CSP, and no other CSP [OFE-014 AC3]" csp_has "${PAY_AIRLINE_DIRECTIVES[@]}"
  check "$1: its CSP names no Stripe host [OFE-014 AC3]" no_stripe_in_csp
  same "$1 sends Cross-Origin-Opener-Policy same-origin, once [OFE-014 AC3]" "$(coop_values)" same-origin
  same "$1 is Cache-Control no-store, once [OFE-014 AC3]" \
    "$(header_count Cache-Control) $(header Cache-Control)" "1 no-store"
  same "$1 has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
  same "$1 has X-Content-Type-Options nosniff" "$(header X-Content-Type-Options)" nosniff
  same "$1 hides the Server header" "$(header_count Server)" 0
}
for path in /checkout/pay-airline.html /checkout/pay-airline "/checkout/pay-airline.html?id=chk_smoke&payment=pay_smoke"; do
  fetch "$TENANT" "$path"
  same "$path answers 200 [OFE-014 AC3]" "$STATUS" 200
  card_page_headers "$path"
done
# Other spellings of the path (sent as they are): wherever Caddy serves the card page, it sends the page's headers.
for path in /checkout//pay-airline.html /checkout/./pay-airline.html /checkout/x/../pay-airline.html \
  /checkout/%70ay-airline.html /CHECKOUT/PAY-AIRLINE.HTML /checkout/pay-airline.html/; do
  fetch "$TENANT" "$path" --path-as-is
  if [ "$STATUS" = 200 ] && cmp -s "$BODY" "$CARD_PAGE"; then
    card_page_headers "$path (variant)"
  else
    # Not the page (a 404, or the file server's redirect to the canonical path): the storefront's headers.
    pass "$path (variant) answers $STATUS, not the airline-card page"
    check "$path (variant): no Cross-Origin-Opener-Policy same-origin" no_coop_same_origin
  fi
done

# Every other kind of storefront response keeps the storefront CSP and never sends COOP same-origin, so a window that
# one of these pages opens on the card page lands in another browsing context group.
for path in / /assets/a.js /checkout/pay-card.html /checkout/pay-card /checkout/complete.html /checkout.html \
  /checkout/pay-airline-x.html /no/such/page /api/x; do
  fetch "$TENANT" "$path"
  check "$path ($STATUS): no Cross-Origin-Opener-Policy same-origin [OFE-014 AC3]" no_coop_same_origin
  check "$path ($STATUS): the storefront CSP with worker-src 'none' [OFE-014 AC3]" \
    csp_has "${CSP_DIRECTIVES[@]}" "$STOREFRONT_SCRIPTS"
done
# The upstream sends COOP same-origin on every answer, as the APIs' helmet does: the API host passes it on, so the
# /api/x check above proves that the storefront removes it rather than that nothing sent it.
fetch "api.$STOREFRONT" /x
same "the OTA API's own answer (api.$STOREFRONT) carries the upstream's COOP same-origin [OFE-014 AC3]" \
  "$(coop_values)" same-origin

# ---- 6. the API hosts -------------------------------------------------------------------------------------------
for api in "api.$STOREFRONT 4000" "api.$PLATFORM 3100"; do
  read -r host port <<<"$api"
  step "API host $host (upstream $port)"
  for path in /internal/x "/internal/tls/ask?domain=$TENANT" /health/ready //internal/x /Internal/x \
    /internal%2Fx /health/live/../ready; do
    fetch "$host" "$path" --path-as-is
    same "$path answers 404 [X-022 AC1]" "$STATUS" 404
    same "$path never reaches the upstream [X-022 AC1]" "$(json port)" ""
  done
  fetch "$host" /health/live -H "X-Velexis-Edge: $FORGED_EDGE" -H "X-Velexis-Host: $TENANT"
  same "/health/live reaches the upstream on $port [X-022 AC1]" "$(json port) $(json url)" "$port /health/live"
  same "a client's X-Velexis-Edge is removed [X-022 AC1]" "$(json headers.x-velexis-edge)" ""
  same "a client's X-Velexis-Host is removed [X-022 AC1]" "$(json headers.x-velexis-host)" ""
  same "$host has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
done

# The Next.js hosts: portal, platform admin, OTA admin.
NEXT_HOSTS=("$PLATFORM 3000" "admin.$PLATFORM 3001" "admin.$STOREFRONT 3002")
for app in "${NEXT_HOSTS[@]}"; do
  read -r host port <<<"$app"
  step "Next.js host $host (upstream $port)"
  fetch "$host" /hello
  same "/hello reaches the app on $port" "$(json port) $(json url)" "$port /hello"
  same "$host has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
  same "$host sends X-Frame-Options DENY" "$(header X-Frame-Options)" DENY
  same "$host hides the Server header" "$(header_count Server)" 0
done

# ---- 6b. what the access log keeps of a URL (FIX-W29-SECURITY) ------------------------------------------------
step "Access log: no secret and no personal value of a URL (query, Referer, Location, Next.js router state)"
# Every value is a marker of letters and digits that no other request of this run sends, so a grep that finds it in a
# log line found this step's value, however the filter re-encoded the query around it. The request ids find each
# request's own log line.
MARK="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
# The parameters of the Caddyfile's (log_query_filter), in its order.
LOG_PARAMS=(sig token client_secret payment_intent_client_secret setup_intent_client_secret q email customerEmail
  travelerLastName targetId next)
value_of() { printf 'smk%s%s' "${1//_/}" "$MARK"; } # parameter -> its marker value
KEEP="smkkeep$MARK"                                # a value every log line keeps: the filter deletes only its list
ROUTER="smkrouter$MARK"                            # the page query inside Next.js's router state header
# Stripe's 3-D Secure return (OFE-013) adds payment_intent, payment_intent_client_secret and redirect_status; `next`
# carries another page's path and query, as the sign-in links of the portal and the admin sites do.
LOG_QUERY="keep=$KEEP&payment_intent=pi_$KEEP&redirect_status=succeeded"
for name in "${LOG_PARAMS[@]}"; do
  if [ "$name" = next ]; then
    LOG_QUERY+="&next=%2Fbookings%3FcustomerEmail%3D$(value_of next)"
  else
    LOG_QUERY+="&$name=$(value_of "$name")"
  fi
done
ROUTER_TREE="%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%3F%7B%5C%22q%5C%22%3A%5C%22$ROUTER%5C%22%7D%22%2C%7B%7D%5D%7D%5D"
contains() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
has_every_value() { # text -> true when it holds the marker of every parameter
  local name
  for name in "${LOG_PARAMS[@]}"; do contains "$1" "$(value_of "$name")" || return 1; done
}
LOG_HOSTS=("$TENANT" "$PLATFORM" "admin.$PLATFORM" "admin.$STOREFRONT" "api.$PLATFORM" "api.$STOREFRONT")
LOG_REQUESTS=() # "<request id> <host> <path>" of each request of this step
n=0
for host in "${LOG_HOSTS[@]}"; do
  # The storefront's page is the static page Stripe returns to; its /api goes to the OTA API like the other hosts.
  if [ "$host" = "$TENANT" ]; then pages=(/checkout/complete.html /api/redirect); else pages=(/hello /redirect); fi
  for page in "${pages[@]}"; do
    n=$((n + 1))
    id="smoke-log-$n-$MARK"
    LOG_REQUESTS+=("$id $host $page")
    fetch "$host" "$page?$LOG_QUERY" -H "X-Request-Id: $id" -H "Next-Router-State-Tree: $ROUTER_TREE" \
      -H "Referer: https://$host:$HTTPS_PORT/page?$LOG_QUERY&ref=$KEEP"
    case "$page" in
      */redirect)
        same "$host$page answers the app's redirect (302) [FIX-W29-SECURITY AC1]" "$STATUS" 302
        check "$host$page: the client gets the app's Location with every value [FIX-W29-SECURITY AC1]" \
          has_every_value "$(header Location)"
        ;;
      /checkout/complete.html)
        same "$host$page (Stripe's return) answers 200 [FIX-W29-SECURITY AC1]" "$STATUS" 200
        check "$host$page serves the storefront's page" cmp -s "$BODY" "$RELEASE/storefront/checkout/complete.html"
        ;;
      *) same "$host$page answers 200 [FIX-W29-SECURITY AC1]" "$STATUS" 200 ;;
    esac
    if [ "$page" != /checkout/complete.html ]; then
      check "$host$page reaches the app with every value of its query [FIX-W29-SECURITY AC1]" has_every_value "$(json url)"
    fi
  done
done

log_line() { grep -F "\"$1\"" "$TMP/caddy.log" | grep -F '"logger":"http.log.access' | head -n 1; }
logged_all() { local entry; for entry in "${LOG_REQUESTS[@]}"; do [ -n "$(log_line "${entry%% *}")" ] || return 1; done; }
check "Caddy wrote the access log line of each request of this step" retry 20 logged_all
LOG_LINES="$(for entry in "${LOG_REQUESTS[@]}"; do log_line "${entry%% *}"; done)"
for name in "${LOG_PARAMS[@]}"; do
  check "no access log line keeps the $name value (URI, Referer or Location; six hosts) [FIX-W29-SECURITY AC1]" \
    not grep -qF -- "$(value_of "$name")" <<<"$LOG_LINES"
done
check "no access log line keeps Next.js's router state (Next-Router-State-Tree) [FIX-W29-SECURITY AC1]" \
  not grep -qF -- "$ROUTER" <<<"$LOG_LINES"
logged() { # request id, field (uri, referer or location) -> what its access log line holds there
  # shellcheck disable=SC2016 # JavaScript, not shell
  log_line "$1" | "$NODE" -e '
    const line = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const field = process.argv[1];
    const value = field === "uri" ? line.request?.uri
      : field === "referer" ? line.request?.headers?.Referer?.[0] : line.resp_headers?.Location?.[0];
    process.stdout.write(value ?? "");
  ' "$2"
}
for entry in "${LOG_REQUESTS[@]}"; do
  read -r id host page <<<"$entry"
  uri="$(logged "$id" uri)"
  check "$host$page: the logged URI keeps the other values [FIX-W29-SECURITY AC1]" contains "$uri" "keep=$KEEP"
  check "$host$page: the logged Referer keeps the other values [FIX-W29-SECURITY AC1]" \
    contains "$(logged "$id" referer)" "ref=$KEEP"
  if [ "$page" = /checkout/complete.html ]; then
    check "$host$page: the logged URI keeps Stripe's payment_intent [FIX-W29-SECURITY AC1]" \
      contains "$uri" "payment_intent=pi_$KEEP"
    check "$host$page: the logged URI keeps Stripe's redirect_status [FIX-W29-SECURITY AC1]" \
      contains "$uri" "redirect_status=succeeded"
  fi
  if contains "$page" /redirect; then
    check "$host$page: the logged Location keeps the other values [FIX-W29-SECURITY AC1]" \
      contains "$(logged "$id" location)" "keep=$KEEP"
  fi
done

# ---- 7. hosts without a certificate ---------------------------------------------------------------------------
step "On-demand TLS: only hosts the ask endpoint allows get a certificate"
stored() { find "$TMP/data/caddy/certificates" -name "$1.crt" | grep -q .; }
for host in "$UNKNOWN" "$REFUSED"; do
  fetch "$host" /
  same "$host: the TLS handshake fails (curl exit 35) [X-022 AC1]" "$CURL_RC" 35
  check "$host: Caddy asked the ask endpoint, which answered 404 [X-022 AC1]" grep -qx "ask $host 404" "$TMP/echo.log"
  check "$host: no certificate was stored [X-022 AC1]" not stored "$host"
done
check "$TENANT got its certificate after the ask endpoint answered 200" grep -qx "ask $TENANT 200" "$TMP/echo.log"

step "TLS versions (ADR-0027 row 4)"
tls_with() { # openssl protocol option [more options] -> output of a handshake with platform.localhost
  openssl s_client -connect "127.0.0.1:$HTTPS_PORT" -servername "$PLATFORM" -CAfile "$CA" "$@" </dev/null 2>&1 || true
}
for v in 1.2 1.3; do
  out="$(tls_with "-tls${v/./_}")"
  check "TLS $v is accepted" grep -Eq "^ *Protocol *: TLSv$v$|New, TLSv$v," <<<"$out"
done
out="$(tls_with -tls1_1 -cipher 'DEFAULT:@SECLEVEL=0')"
check "TLS 1.1 is refused by the server (protocol version alert)" grep -q 'alert protocol version' <<<"$out"

step "Plain HTTP"
redirect="$(curl -sS --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' \
  --resolve "$UNKNOWN:$HTTP_PORT:127.0.0.1" "http://$UNKNOWN:$HTTP_PORT/x?y=1")"
same "http:// on an unknown host redirects to https:// with 308" "$redirect" "308 https://$UNKNOWN/x?y=1"

# ---- 8. reload through the admin socket -------------------------------------------------------------------------
step "caddy reload --config <test copy> through the unix socket"
fetch "$PLATFORM" /hello
same "before the reload, $PLATFORM sends X-Frame-Options DENY" "$(header X-Frame-Options)" DENY
cp "$TEST_COPY" "$TMP/Caddyfile.before"
sed -i 's/^\t\tX-Frame-Options "DENY"$/\t\tX-Frame-Options "SAMEORIGIN"/' "$TEST_COPY"
check "the header change is in the test copy" not cmp -s "$TMP/Caddyfile.before" "$TEST_COPY"
reloads() {
  "${caddy_env[@]}" "$CADDY" reload --config "$TEST_COPY" --adapter caddyfile >"$TMP/reload.log" 2>&1 \
    || { redact "$(cat "$TMP/reload.log")"; echo; return 1; }
}
check "caddy reload succeeds through the admin socket [X-022 AC1]" reloads
fetch "$PLATFORM" /hello
same "after the reload, $PLATFORM serves the changed header [X-022 AC1]" "$(header X-Frame-Options)" SAMEORIGIN
check "after the reload, still nothing listens on TCP 2019 [X-022 AC1]" not listening 2019

# ---- 9. upstream stopped ----------------------------------------------------------------------------------------
step "Upstream stopped: maintenance page and JSON envelope"
stop "$ECHO_PID"
ECHO_PID=""
upstream_down() { local p; for p in "${UPSTREAM_PORTS[@]}"; do listening "$p" && return 1; done; return 0; }
retry 20 upstream_down || die "the echo upstream did not stop"

for app in "${NEXT_HOSTS[@]}"; do
  read -r host _ <<<"$app"
  fetch "$host" /any/page
  same "$host answers 503 [X-022 AC1]" "$STATUS" 503
  check "$host serves the maintenance page (deploy/caddy/maintenance/index.html) [X-022 AC1]" \
    cmp -s "$BODY" "$MAINTENANCE"
  same "$host: the maintenance page is text/html" "$(header Content-Type)" "text/html; charset=utf-8"
  same "$host: the maintenance page is Cache-Control no-store" "$(header Cache-Control)" no-store
  same "$host: the maintenance page sends Retry-After 30" "$(header Retry-After)" 30
  same "$host: the maintenance page has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
  same "$host: the maintenance page hides the Server header" "$(header_count Server)" 0
done

REQUEST_ID="smoke-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
envelope_checks() { # label: the last response is the SERVICE_UNAVAILABLE envelope
  same "$1 answers 503 [X-022 AC1]" "$STATUS" 503
  same "$1 is application/json [X-022 AC1]" "$(header Content-Type)" application/json
  same "$1 has error.code SERVICE_UNAVAILABLE [X-022 AC1]" "$(json error.code)" SERVICE_UNAVAILABLE
  same "$1 has error.status 503" "$(json error.status)" 503
  same "$1 is Cache-Control no-store" "$(header Cache-Control)" no-store
  same "$1 has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
  same "$1 hides the Server header" "$(header_count Server)" 0
}
fetch "api.$PLATFORM" /v1/anything -H "X-Request-Id: $REQUEST_ID"
envelope_checks "api.$PLATFORM"
same "api.$PLATFORM echoes the client's X-Request-Id as error.requestId" "$(json error.requestId)" "$REQUEST_ID"
fetch "api.$PLATFORM" /v1/anything
uuid_id() { grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' <<<"$(json error.requestId)"; }
check "without a client X-Request-Id, error.requestId is a fresh UUID" uuid_id
fetch "api.$STOREFRONT" /v1/anything
envelope_checks "api.$STOREFRONT"
fetch "$TENANT" /api/x
envelope_checks "the storefront /api on $TENANT"
fetch "$TENANT" /
same "the storefront's static files are still served (200)" "$STATUS" 200

# ---- 10. logs -----------------------------------------------------------------------------------------------------
step "Caddy's log"
check "the edge secret is not in Caddy's log" not grep -qF -- "$EDGE_SECRET" "$TMP/caddy.log"
check "a client's forged X-Velexis-Edge is not in Caddy's log (access-log filter)" \
  not grep -qF -- "$FORGED_EDGE" "$TMP/caddy.log"
access_logged() { grep -q '"logger":"http.log.access' "$TMP/caddy.log"; }
check "Caddy wrote access log lines (so the two checks above looked at them)" access_logged

if [ "$FAILED" -ne 0 ]; then
  printf '\ncaddy-smoke: FAILED\n'
  exit 1
fi
printf '\ncaddy-smoke: all checks passed\n'
