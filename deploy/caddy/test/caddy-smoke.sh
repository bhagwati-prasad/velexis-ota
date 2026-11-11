#!/usr/bin/env bash
# =====================================================================================================
# caddy-smoke.sh — runs the real deploy/caddy/Caddyfile under the Velexis Caddy build (Caddy 2.8.4 with the Coraza web
# application firewall) with an echo upstream (task X-022; the firewall: X-039).
#
#   bash deploy/caddy/build/build-caddy.sh /tmp/caddy-build && bash deploy/caddy/test/caddy-smoke.sh
#   CADDY=/path/to/caddy bash deploy/caddy/test/caddy-smoke.sh
#
# Needs no root and no network beyond loopback: the Velexis Caddy build (CADDY, else /tmp/caddy-build/caddy as
# build-caddy.sh writes it in the command above, else `caddy` on PATH; it must be Caddy 2.8.4 with the module
# http.handlers.waf), Node 22 (SMOKE_NODE, else `node`), curl, openssl and awk. The app ports 3000, 3001, 3002, 3100 and
# 4000 (echo upstream), 8080 and 8443 (Caddy) must be free on 127.0.0.1, and nothing may listen on 2019. CI runs it in
# the "deploy-files" job of .github/workflows/ci.yml. How to read a failure: deploy/caddy/test/README.md.
#
# The test copy of the Caddyfile differs from the production file only in its global options block: the admin
# socket moves to the temporary folder, and `local_certs`, `skip_install_trust`, `default_bind 127.0.0.1`,
# `http_port 8080` and `https_port 8443` are added. The production `ask` URL (127.0.0.1:3100) already reaches
# echo-upstream.mjs, which answers 200 only for acme.ota.localhost. Every snippet and site block is the production
# text byte for byte; the hosts come from the environment of the Caddy process: PLATFORM_BASE_DOMAIN=
# platform.localhost, STOREFRONT_BASE_DOMAIN=ota.localhost, a random VELEXIS_EDGE_SECRET, VELEXIS_ROOT (the
# prefix of the /srv/velexis folders: a fixture storefront release and the maintenance page of deploy/caddy) and
# VELEXIS_WAF_DIR (a copy of deploy/caddy/waf, the firewall's rule files, as velexis-deploy installs them).
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
#   - the OTA API's public images through the storefront (/api/v1/assets/<key>/<id>.png, getPublicAsset, OADR-0012
#     point 3; lead decision (2b) of 2026-10-30, FIX-W34-SHARED) carry exactly the API's own CSP `default-src 'none'`,
#     also through path variants, with the other storefront headers (HSTS, nosniff, Referrer-Policy, no COOP, no
#     Server), while every other /api answer (/api/v1/storefront, ...) gets the storefront CSP instead of the CSP the
#     upstream sends, as the OTA API's helmet does;
#   - the content pages (task OFE-020, OADR-0015 point 4): /p/<slug> (also with a trailing slash, in upper case and
#     with a query) is served by p.html with the storefront headers, as are /p/, /p and /p.html, while no other path
#     is rewritten (/px/terms, /pages/terms, /x/p/terms and /p-terms answer the 404 page), and path variants through
#     /p/ never serve the airline-card page without its own headers;
#   - on api.ota.localhost and api.platform.localhost, /internal/* and /health/ready (and the same variants)
#     answer 404 without reaching the upstream, /health/live reaches it, and client copies of the edge headers are
#     removed;
#   - on api.ota.localhost, api.platform.localhost and the storefront's /api (OBE-084, OADR-0009 rule 1.2), every
#     proxied request reaches the upstream with exactly Caddy's X-Forwarded-For (the client's address) and
#     X-Forwarded-Host (the requested host), also when the client sends forged ones, so the OTA admin's service key
#     can never arrive "direct" through Caddy; a client's X-Velexis-Edge never reaches an upstream;
#   - CORS on api.ota.localhost (OBE-097; the OTA API answers it itself, ota/backend/src/common/http/cors.ts): a
#     browser's OPTIONS preflight reaches the OTA API with its Origin and Access-Control-Request-* headers, and the
#     API's Access-Control-* headers and `Vary: Origin` come back unchanged, once each, on the preflight and on an
#     actual answer; without an Origin, Caddy adds no CORS header of its own;
#   - request bodies (lead decision (2c) of 2026-10-30, FIX-W34-SHARED): POST /v1/console/settings/assets on
#     api.ota.localhost passes a body of 1,060,000 bytes whole to the upstream and answers 413 to 1,200,000 (1100KiB);
#     every other route and method of both API hosts passes 990,000 bytes and answers 413 to 1,060,000 (1MB), and the
#     storefront's /api keeps its 256KB;
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
#   - the web application firewall (X-039; each line ends with [X-039 AC2]): the binary is the pinned build of
#     deploy/caddy/build/versions.env; with an empty environment every WAF loads its rule files from /etc/caddy/waf,
#     three block (On) and six only detect; an SQL-injection and an XSS payload to /api/x on a storefront host, in the
#     query and in a JSON body, and to api.ota.localhost get 403 with the API's error envelope (FORBIDDEN, the request
#     id, the host's security headers) and never reach the upstream, an XSS payload to a storefront /checkout/ page gets
#     403 as text; the same requests on the portal, both admin hosts, the platform API and a storefront page reach
#     their app and are logged; normal SDK requests (GET, POST, PUT, PATCH, DELETE and OPTIONS with the SDK's headers,
#     JSON bodies with names, the airline-card details and a multipart upload, and the hosted storefront's cookie mode)
#     reach the OTA API on both blocking hosts with no WAF log line; arguments above 128 KiB are refused with 413 on a
#     blocking host and pass uninspected on a detection host; each WAF reads a body only up to its own limit (on the
#     storefront 256 KiB, in memory, and the WAF itself refuses a longer body with 413); multipart bodies cut before
#     their closing boundary leave no temporary file in Caddy's TMPDIR; Stripe's webhook paths on api.ota.localhost
#     only detect; a matched rule's log line names the rule
#     and the variable but no value of the request (a password in a JSON body, card details); with
#     VELEXIS_WAF_ENGINE=DetectionOnly (the detection week) a reload makes the blocking paths detect only, and
#     without it they block again; path traversals that answered 404 before now meet the WAF first on the blocking
#     hosts (403) and still never reach the upstream;
#   - on every host (FIX-W29-SECURITY), a request whose query, `Referer` and redirect `Location` carry the values of
#     the Caddyfile's `(log_query_filter)` (signatures and tokens, Stripe's client secrets of the 3-D Secure return,
#     the OAuth code and state of Stripe Connect's return to the portal, and the e-mail addresses, names, searches
#     and return paths of the portal and the admin sites) and whose
#     `Next-Router-State-Tree` holds a page's query still succeeds, reaches its app with every value, and leaves none
#     of them in its access log line, which keeps the other values (`payment_intent`, `redirect_status`, ...).
#
# Settings (environment): CADDY, SMOKE_NODE, SMOKE_TMPDIR (parent of the temporary folder; default TMPDIR or
# /tmp; the admin socket path must stay under 100 bytes), SMOKE_KEEP=1 (keep the temporary folder and its logs).
# The request body checks of step 6a send multipart bodies, as the asset upload does: a WAF on a blocking host refuses
# a body type the Core Rule Set does not allow (CRS 920420), which says nothing about Caddy's limits.
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
# X-039: the rule files of every WAF on the VM (velexis-deploy installs deploy/caddy/waf there) and of the build.
PROD_WAF_INCLUDES="/etc/caddy/waf/coraza.conf /etc/caddy/waf/exclusions.conf /etc/caddy/waf/logdata.conf @crs-setup.conf.example @owasp_crs/REQUEST-*.conf @owasp_crs/RESPONSE-980-CORRELATION.conf"
# X-039: the mode and body limit (SecRequestBodyLimit, bytes) of every WAF, sorted as text.
PROD_WAF_LIMITS="DetectionOnly:1048576 DetectionOnly:10485760 DetectionOnly:262144 DetectionOnly:262144 DetectionOnly:5242880 DetectionOnly:5242880 On:1228800 On:262144 On:262144"
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
BUILD_OUT=/tmp/caddy-build # the output folder of the build command in the header (the X-039 Verify command)
if [ -z "${CADDY:-}" ]; then
  if [ -x "$BUILD_OUT/caddy" ]; then CADDY="$BUILD_OUT/caddy"; else CADDY="$(command -v caddy || true)"; fi
fi
NODE="${SMOKE_NODE:-$(command -v node || true)}"
if [ -z "$CADDY" ] || [ ! -x "$CADDY" ]; then
  die "caddy not found: build it with bash deploy/caddy/build/build-caddy.sh $BUILD_OUT, or set CADDY (see deploy/caddy/test/README.md)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then die "node not found: set SMOKE_NODE"; fi
for tool in curl openssl awk sha256sum; do command -v "$tool" >/dev/null || die "$tool is missing"; done
version="$("$CADDY" version | awk '{ print $1 }')"
[ "$version" = "v$CADDY_VERSION" ] || die "this test pins Caddy $CADDY_VERSION; $CADDY is $version"
grep -qx 'http.handlers.waf' <<<"$("$CADDY" list-modules 2>/dev/null)" \
  || die "$CADDY has no web application firewall (module http.handlers.waf): build the Velexis Caddy with bash deploy/caddy/build/build-caddy.sh $BUILD_OUT"
PINNED_SHA="$(sed -n 's/^CADDY_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$DEPLOY/caddy/build/versions.env")"

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

mkdir -p "$TMP/home" "$TMP/data" "$TMP/config" "$TMP/caddy-tmp"
# Caddy sees only this environment: no proxy settings, no developer variables, its own data folder, and its own
# temporary folder (TMPDIR), where the WAF buffers long bodies and the files of multipart bodies (step 6e).
CADDY_TMP="$TMP/caddy-tmp"
caddy_env=(env -i "PATH=$PATH" "HOME=$TMP/home" "XDG_DATA_HOME=$TMP/data" "XDG_CONFIG_HOME=$TMP/config" "TMPDIR=$CADDY_TMP")

validates() {
  "${caddy_env[@]}" VELEXIS_EDGE_SECRET=smoke VELEXIS_WAF_DIR="$DEPLOY/caddy/waf" "$CADDY" validate --config "$CADDYFILE" \
    --adapter caddyfile \
    >"$TMP/validate.log" 2>&1 || { cat "$TMP/validate.log"; return 1; }
}
check "caddy validate accepts the production Caddyfile [X-022 AC2]" validates
fmt_clean() { # caddy fmt --diff exits 1 on a file that is not formatted; print only the changed lines then
  "$CADDY" fmt --diff "$CADDYFILE" >"$TMP/fmt.diff" 2>&1 || { grep -E '^[-+] |^Error' "$TMP/fmt.diff"; return 1; }
}
check "caddy fmt --diff is clean for the production Caddyfile [X-022 AC2]" fmt_clean
same "$CADDY is the pinned build of deploy/caddy/build/versions.env (CADDY_SHA256) [X-039 AC2]" \
  "$(sha256sum "$CADDY" | cut -d' ' -f1)" "$PINNED_SHA"

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
    // The web application firewalls (X-039): the files they include, how many run in each mode, and how much of a body
    // each reads (SecRequestBodyLimit), as <mode>:<bytes> pairs.
    const includes = new Set();
    const modes = {};
    const limits = [];
    const wafs = (v) => {
      if (Array.isArray(v)) { v.forEach(wafs); return; }
      if (v && typeof v === "object") {
        if (v.handler === "waf") {
          for (const m of String(v.directives ?? "").matchAll(/^\s*Include\s+(\S+)/gm)) { includes.add(m[1]); }
          const mode = /^\s*SecRuleEngine\s+(\S+)/m.exec(String(v.directives ?? ""))?.[1] ?? "none";
          modes[mode] = (modes[mode] ?? 0) + 1;
          limits.push(`${mode}:${/^\s*SecRequestBodyLimit\s+(\S+)/m.exec(String(v.directives ?? ""))?.[1] ?? "none"}`);
        }
        Object.values(v).forEach(wafs);
      }
    };
    wafs(cfg.apps?.http);
    const modeList = Object.keys(modes).sort().map((k) => `${k}=${modes[k]}`).join(" ");
    process.stdout.write(`${cfg.admin?.listen ?? ""}\n${[...hosts].sort().join(" ")}\n${[...roots].sort().join(" ")}\n` +
      `${[...includes].sort().join(" ")}\n${modeList}\n${limits.sort().join(" ")}\n`);
  ' "$TMP/prod.json")"
  same "with an empty environment the host names are the placeholders of decisions.md §4 [X-022 AC3]" \
    "$(sed -n 2p <<<"$prod_facts")" "$PLACEHOLDER_HOSTS"
  same "the production admin API is the unix socket /run/caddy/admin.sock [X-022 AC3]" \
    "$(sed -n 1p <<<"$prod_facts")" "$PROD_ADMIN"
  # VELEXIS_ROOT (test only) must expand to nothing on the VM: no default may move the production folders.
  same "with an empty environment the file roots are the /srv/velexis folders of the VM" \
    "$(sed -n 3p <<<"$prod_facts")" "$PROD_ROOTS"
  same "with an empty environment every WAF loads coraza.conf, exclusions.conf and logdata.conf from /etc/caddy/waf and the Core Rule Set's request rules [X-039 AC2]" \
    "$(sed -n 4p <<<"$prod_facts")" "$PROD_WAF_INCLUDES"
  same "three WAFs block (On: api.ota.example.com and the /api/* and /checkout/* of both storefront blocks), six detect (the portal, both admin hosts, the platform API, the storefront pages) [X-039 AC2]" \
    "$(sed -n 5p <<<"$prod_facts")" "DetectionOnly=6 On=3"
  # The WAF runs before request_body, so its own body limit is what it reads: on the storefront (both WAFs of both
  # storefront site blocks, 262144) no more than coraza.conf's SecRequestBodyInMemoryLimit, so no storefront body is
  # written to a temporary file.
  same "each WAF reads a body up to its own limit: 256 KiB (in memory) on the storefront, just above Caddy's request_body limit elsewhere [X-039 AC2]" \
    "$(sed -n 6p <<<"$prod_facts")" "$PROD_WAF_LIMITS"
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
CONTENT_PAGE="$RELEASE/storefront/p.html" # the content pages' file (OFE-020): every /p/<slug>
printf '<!doctype html>\n<title>Smoke content page</title>\n<p>storefront content page</p>\n' >"$CONTENT_PAGE"

EDGE_SECRET="smoke-edge-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
FORGED_EDGE="forged-edge-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
WAF_DIR="$ROOT/etc/caddy/waf"
mkdir -p "$WAF_DIR"
cp "$DEPLOY"/caddy/waf/*.conf "$WAF_DIR/"
caddy_env+=("PLATFORM_BASE_DOMAIN=$PLATFORM" "STOREFRONT_BASE_DOMAIN=$STOREFRONT" "ACME_EMAIL=ops@example.com"
  "VELEXIS_EDGE_SECRET=$EDGE_SECRET" "VELEXIS_ROOT=$ROOT" "VELEXIS_WAF_DIR=$WAF_DIR")

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
uuid_id() { grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' <<<"$(json error.requestId)"; }
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
# X-039: the storefront's /api/* meets a blocking WAF first, which refuses a path with a dot segment as a path traversal
# (CRS 930100, 403) before Caddy's 404; either way the request never reaches the API.
private_status() { case "$1" in *..*) echo 403 ;; *) echo 404 ;; esac; }
for path in "${STOREFRONT_PRIVATE[@]}"; do
  fetch "$TENANT" "$path" --path-as-is -H "X-Velexis-Edge: $FORGED_EDGE"
  same "$path answers $(private_status "$path") [X-022 AC1]" "$STATUS" "$(private_status "$path")"
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
  /checkout/%70ay-airline.html /CHECKOUT/PAY-AIRLINE.HTML /checkout/pay-airline.html/ \
  /p/../checkout/pay-airline.html /p/x/../../checkout/pay-airline.html /p/%2E%2E/checkout/pay-airline.html; do
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
  /checkout/pay-airline-x.html /no/such/page /api/x /p/terms; do
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

# ---- 5c. the OTA API's public images (getPublicAsset, OADR-0012 point 3, lead decision (2b) of 2026-10-30) --------
step "Public images on $TENANT: the OTA API's own CSP default-src 'none'; the storefront CSP on the rest of /api"
ASSET_FILE=acme/ast_01JA2Z7Q4M9R2T6V0X3Z8B1D5F.png
ASSET_PATH="/v1/assets/$ASSET_FILE"
ASSET_CSP="default-src 'none'"                         # PUBLIC_ASSET_CSP of the OTA API's getPublicAsset
HELMET_CSP="default-src 'none'; frame-ancestors 'none'" # the echo's CSP on every other answer, as the OTA API's helmet
# What the storefront has to change: the OTA API's own answers, as api.$STOREFRONT passes them on.
fetch "api.$STOREFRONT" "$ASSET_PATH"
same "the OTA API's image (api.$STOREFRONT$ASSET_PATH) carries its own CSP default-src 'none' [FIX-W34-SHARED 2b]" \
  "$(header_count Content-Security-Policy) $(header Content-Security-Policy)" "1 $ASSET_CSP"
fetch "api.$STOREFRONT" /v1/storefront
same "the OTA API's other answers (api.$STOREFRONT/v1/storefront) carry helmet's CSP [FIX-W34-SHARED 2b]" \
  "$(header Content-Security-Policy)" "$HELMET_CSP"
public_image_headers() { # label: the last response is the OTA API's image with its own CSP and the storefront headers
  same "$1 carries exactly one CSP, the OTA API's own default-src 'none' [FIX-W34-SHARED 2b]" \
    "$(header_count Content-Security-Policy) $(header Content-Security-Policy)" "1 $ASSET_CSP"
  same "$1 keeps the image's Content-Type and Cache-Control [FIX-W34-SHARED 2b]" \
    "$(header Content-Type) | $(header Cache-Control)" "image/png | public, max-age=31536000, immutable"
  same "$1 has HSTS (ADR-0027) [FIX-W34-SHARED 2b]" "$(header Strict-Transport-Security)" "max-age=31536000"
  same "$1 has X-Content-Type-Options nosniff, once [FIX-W34-SHARED 2b]" \
    "$(header_count X-Content-Type-Options) $(header X-Content-Type-Options)" "1 nosniff"
  same "$1 has the storefront's Referrer-Policy and Permissions-Policy [FIX-W34-SHARED 2b]" \
    "$(header Referrer-Policy) | $(header Permissions-Policy)" \
    "strict-origin-when-cross-origin | camera=(), microphone=(), geolocation=()"
  same "$1 has no Cross-Origin-Opener-Policy (the storefront removes the API's) [FIX-W34-SHARED 2b]" \
    "$(header_count Cross-Origin-Opener-Policy)" 0
  same "$1 hides the Server header [FIX-W34-SHARED 2b]" "$(header_count Server)" 0
}
fetch "$TENANT" "/api$ASSET_PATH"
same "/api$ASSET_PATH answers 200 from the OTA API as $ASSET_PATH [FIX-W34-SHARED 2b]" \
  "$STATUS $(json port) $(json url)" "200 4000 $ASSET_PATH"
public_image_headers "/api$ASSET_PATH"
fetch "$TENANT" "/api$ASSET_PATH?v=2"
public_image_headers "/api$ASSET_PATH?v=2"
# Other spellings of the path, sent as they are: wherever the OTA API answers with the image, the image's own CSP;
# elsewhere one CSP all the same.
for path in "/API/V1/ASSETS/$ASSET_FILE" "/api//v1/assets/$ASSET_FILE" "/api/v1/x/../assets/$ASSET_FILE" \
  "/api/v1/assets/acme/./${ASSET_FILE#acme/}"; do
  fetch "$TENANT" "$path" --path-as-is
  if [ "$(header Content-Type)" = image/png ]; then
    public_image_headers "$path (variant, the image)"
  else
    same "$path (variant, $STATUS, not the image) carries exactly one CSP [FIX-W34-SHARED 2b]" \
      "$(header_count Content-Security-Policy)" 1
  fi
done
# Every other answer of the OTA API through the storefront: the storefront CSP, never the API's own.
for path in /api/v1/storefront /api/v1/storefront/pages/terms /api/v1/assets /api/v1/assetsx/acme/x.png; do
  fetch "$TENANT" "$path"
  same "$path reaches the OTA API ($STATUS) [FIX-W34-SHARED 2b]" "$(json port)" 4000
  check "$path: the storefront CSP with worker-src 'none', not the API's own [FIX-W34-SHARED 2b]" \
    csp_has "${CSP_DIRECTIVES[@]}" "$STOREFRONT_SCRIPTS"
done

# ---- 5d. content pages (OFE-020, OADR-0015 point 4) -------------------------------------------------------------
step "Content pages on $TENANT: /p/<slug> is served by p.html with the storefront headers; nothing else is rewritten"
content_page_headers() { # label: the last response is p.html with the storefront's headers
  same "$1 answers 200 [OFE-020 AC2]" "$STATUS" 200
  check "$1 serves p.html [OFE-020 AC2]" cmp -s "$BODY" "$CONTENT_PAGE"
  check "$1 has the storefront CSP with worker-src 'none', and no other CSP [OFE-020 AC2]" \
    csp_has "${CSP_DIRECTIVES[@]}" "$STOREFRONT_SCRIPTS"
  same "$1 is Cache-Control no-cache, once (HTML is revalidated) [OFE-020 AC2]" \
    "$(header_count Cache-Control) $(header Cache-Control)" "1 no-cache"
  check "$1: no Cross-Origin-Opener-Policy same-origin [OFE-020 AC2]" no_coop_same_origin
  same "$1 has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
  same "$1 has X-Content-Type-Options nosniff" "$(header X-Content-Type-Options)" nosniff
  same "$1 hides the Server header" "$(header_count Server)" 0
}
# The page's own spellings: a trailing slash and upper case (Caddy's path matcher ignores case), a query, the slug-less
# /p/ (p.html shows the not-found content), and the file itself under both of try_files' names.
for path in /p/terms /p/about-us /p/terms/ /P/Terms "/p/terms?utm_source=smoke&ref=footer" /p/ /p.html /p; do
  fetch "$TENANT" "$path"
  content_page_headers "$path"
done
# Only /p/* is rewritten: a path that merely looks like it gets the storefront's 404 page.
for path in /px/terms /pages/terms /x/p/terms /p-terms /p.htm; do
  fetch "$TENANT" "$path"
  same "$path answers 404, not p.html (only /p/* is rewritten) [OFE-020 AC2]" "$STATUS" 404
  check "$path serves the storefront's 404.html" cmp -s "$BODY" "$RELEASE/storefront/404.html"
done
# /api/p/* stays the OTA API's (handle /api/* comes first), not the content page.
fetch "$TENANT" /api/p/terms
same "/api/p/terms reaches the OTA API as /p/terms, not p.html [OFE-020 AC2]" "$(json port) $(json url)" "4000 /p/terms"

# ---- 6. the API hosts -------------------------------------------------------------------------------------------
for api in "api.$STOREFRONT 4000" "api.$PLATFORM 3100"; do
  read -r host port <<<"$api"
  step "API host $host (upstream $port)"
  for path in /internal/x "/internal/tls/ask?domain=$TENANT" /health/ready //internal/x /Internal/x \
    /internal%2Fx /health/live/../ready; do
    fetch "$host" "$path" --path-as-is
    want=404 # X-039: api.$STOREFRONT blocks, so its WAF refuses the dot segment (403) first; api.$PLATFORM only detects
    if [ "$host" = "api.$STOREFRONT" ]; then want="$(private_status "$path")"; fi
    same "$path answers $want [X-022 AC1]" "$STATUS" "$want"
    same "$path never reaches the upstream [X-022 AC1]" "$(json port)" ""
  done
  fetch "$host" /health/live -H "X-Velexis-Edge: $FORGED_EDGE" -H "X-Velexis-Host: $TENANT"
  same "/health/live reaches the upstream on $port [X-022 AC1]" "$(json port) $(json url)" "$port /health/live"
  same "a client's X-Velexis-Edge is removed [X-022 AC1]" "$(json headers.x-velexis-edge)" ""
  same "a client's X-Velexis-Host is removed [X-022 AC1]" "$(json headers.x-velexis-host)" ""
  same "$host has HSTS (ADR-0027)" "$(header Strict-Transport-Security)" "max-age=31536000"
done

# ---- 6a. request body limits of the API hosts (lead decision (2c) of 2026-10-30) ---------------------------------
UPLOAD=/v1/console/settings/assets # consoleUploadStorefrontAsset (OADR-0012 point 2)
step "Request bodies: up to 1100KiB for POST $UPLOAD on api.$STOREFRONT, 1MB on every other route of both API hosts"
# 1MB is 1,000,000 bytes and 1100KiB 1,126,400; the OTA API itself refuses an upload above 1 MiB + 16 KiB (1,064,960).
UPLOAD_OK=1060000  # passes the upload route, which the API accepts; too large for every other route
UPLOAD_BIG=1200000 # too large for the upload route as well
UNDER_1MB=990000   # passes every route
BOUNDARY="smokeboundary$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
body_file() { # bytes -> a multipart/form-data body of exactly that many bytes, one file part (written once)
  # Multipart, as the asset upload sends it: the blocking WAF of api.$STOREFRONT and the storefront's /api refuses a
  # body type the Core Rule Set does not allow (CRS 920420, X-039), and a file part is not an argument of the WAF's
  # 128 KiB limit. Caddy's request_body limits count the bytes whatever their type.
  local file="$TMP/body-$1.bin" lead tail
  lead="--$BOUNDARY"$'\r\n''Content-Disposition: form-data; name="file"; filename="smoke.png"'$'\r\n''Content-Type: image/png'$'\r\n\r\n'
  tail=$'\r\n'"--$BOUNDARY--"$'\r\n'
  if [ ! -s "$file" ]; then
    { printf '%s' "$lead"; head -c "$(($1 - ${#lead} - ${#tail}))" /dev/zero; printf '%s' "$tail"; } >"$file"
  fi
  printf '%s' "$file"
}
send_body() { # host path bytes [method] -> fetch with a request body of that many bytes (POST unless given)
  # `Expect:` (empty) keeps curl from sending `Expect: 100-continue` with a body above 1 MB when it falls back to
  # HTTP/1.1: Caddy then answers `100 Continue` and closes the connection at the limit, and curl can see an empty
  # reply (exit 52) instead of the 413 about one time in twenty-five. Over HTTP/2, which curl negotiates here, curl
  # sends no Expect header anyway.
  fetch "$1" "$2" -X "${4:-POST}" -H "Content-Type: multipart/form-data; boundary=$BOUNDARY" -H "Expect:" \
    --data-binary "@$(body_file "$3")"
}
send_body "api.$STOREFRONT" "$UPLOAD" "$UPLOAD_OK"
same "POST $UPLOAD with $UPLOAD_OK bytes reaches the OTA API with every byte [FIX-W34-SHARED 2c]" \
  "$STATUS $(json port) $(json method) $(json url) $(json bytes)" "200 4000 POST $UPLOAD $UPLOAD_OK"
send_body "api.$STOREFRONT" "$UPLOAD" "$UPLOAD_BIG"
same "POST $UPLOAD with $UPLOAD_BIG bytes answers 413 from Caddy [FIX-W34-SHARED 2c]" "$STATUS $(json port)" "413 "
send_body "api.$STOREFRONT" /v1/console/settings/pages "$UPLOAD_OK"
same "POST /v1/console/settings/pages (another route) with $UPLOAD_OK bytes answers 413 [FIX-W34-SHARED 2c]" \
  "$STATUS $(json port)" "413 "
send_body "api.$STOREFRONT" "$UPLOAD" "$UPLOAD_OK" PUT
same "PUT $UPLOAD (another method) with $UPLOAD_OK bytes answers 413 [FIX-W34-SHARED 2c]" "$STATUS $(json port)" "413 "
for host in "api.$STOREFRONT" "api.$PLATFORM"; do
  send_body "$host" /v1/console/settings/pages "$UNDER_1MB"
  same "$host: POST /v1/console/settings/pages with $UNDER_1MB bytes reaches the upstream [FIX-W34-SHARED 2c]" \
    "$STATUS $(json bytes)" "200 $UNDER_1MB"
done
send_body "api.$PLATFORM" "$UPLOAD" "$UPLOAD_OK"
same "api.$PLATFORM: POST $UPLOAD with $UPLOAD_OK bytes answers 413 (1MB on every route) [FIX-W34-SHARED 2c]" \
  "$STATUS $(json port)" "413 "
send_body "$TENANT" "/api$UPLOAD" 300000
same "$TENANT: POST /api$UPLOAD with 300000 bytes answers 413 (the storefront's 256KB) [FIX-W34-SHARED 2c]" \
  "$STATUS $(json port)" "413 "

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
LOG_PARAMS=(sig token client_secret payment_intent_client_secret setup_intent_client_secret code state q email
  customerEmail travelerLastName targetId next)
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

# ---- 6c. what Caddy forwards to the APIs (OBE-084, OADR-0009 rule 1.2) -------------------------------------------
step "Forwarding headers: X-Forwarded-For and X-Forwarded-Host on every proxied API request; no client edge credential"
# The OTA API takes the OTA admin's service key only from a direct loopback connection: a request without
# X-Forwarded-For and X-Forwarded-Host (common/auth/caller.guard.ts), as the platform's InternalOnlyGuard does. That
# holds only if Caddy sets both on every request it proxies, whatever the client sent, on api.ota.example.com and the
# storefronts' /api/*: Caddy trusts no proxy (no trusted_proxies), so it replaces a client's X-Forwarded-For and
# X-Forwarded-Host with its own values instead of appending to them. FORGED_XFF is an address no request of this run
# comes from.
FORGED_XFF=192.0.2.77
forwarded_checks() { # label host -> the last response reached the upstream with Caddy's own forwarding headers
  same "$1 reaches the upstream with exactly Caddy's X-Forwarded-For (the client's loopback address) [OBE-084 AC1]" \
    "$(json headers.x-forwarded-for)" '["127.0.0.1"]'
  same "$1 reaches the upstream with exactly Caddy's X-Forwarded-Host (the requested host) [OBE-084 AC1]" \
    "$(json headers.x-forwarded-host)" "[\"$2:$HTTPS_PORT\"]"
}
# The API hosts: without any client header, with forged ones, and with a client copy of the edge credential.
for api in "api.$STOREFRONT 4000" "api.$PLATFORM 3100"; do
  read -r host port <<<"$api"
  fetch "$host" /v1/forwarded
  same "$host: /v1/forwarded reaches the upstream on $port [OBE-084 AC1]" "$(json port)" "$port"
  forwarded_checks "$host (no client forwarding headers)" "$host"
  fetch "$host" /v1/forwarded -H "X-Forwarded-For: $FORGED_XFF" -H "X-Forwarded-Host: $UNKNOWN" \
    -H "X-Velexis-Edge: $FORGED_EDGE" -H "X-Velexis-Host: $TENANT"
  forwarded_checks "$host (a client's forged X-Forwarded-For and X-Forwarded-Host)" "$host"
  same "$host drops a client-supplied X-Velexis-Edge [OBE-084 AC1]" "$(json headers.x-velexis-edge)" ""
  same "$host drops a client-supplied X-Velexis-Host [OBE-084 AC1]" "$(json headers.x-velexis-host)" ""
done
# The storefront's /api/*: the same forwarding headers, and the edge credential is Caddy's, never the client's.
fetch "$TENANT" /api/v1/forwarded
forwarded_checks "$TENANT/api (no client forwarding headers)" "$TENANT"
fetch "$TENANT" /api/v1/forwarded -H "X-Forwarded-For: $FORGED_XFF" -H "X-Forwarded-Host: $UNKNOWN" \
  -H "X-Velexis-Edge: $FORGED_EDGE" -H "X-Velexis-Host: $UNKNOWN"
same "$TENANT/api/v1/forwarded reaches the OTA API as /v1/forwarded [OBE-084 AC1]" \
  "$(json port) $(json url)" "4000 /v1/forwarded"
forwarded_checks "$TENANT/api (a client's forged X-Forwarded-For and X-Forwarded-Host)" "$TENANT"
same "$TENANT/api drops a client-supplied X-Velexis-Edge: the upstream gets the edge secret only [OBE-084 AC1]" \
  "$(json headers.x-velexis-edge)" "[\"$EDGE_SECRET\"]"
same "$TENANT/api: X-Velexis-Host is the storefront host, not the client's [OBE-084 AC1]" \
  "$(json headers.x-velexis-host)" "[\"$TENANT\"]"

# ---- 6d. CORS on the OTA API host (OBE-097) ----------------------------------------------------------------------
step "CORS: a browser's OPTIONS preflight on api.$STOREFRONT reaches the OTA API, and the API's CORS headers come back"
# The OTA API answers CORS itself (ota/backend/src/common/http/cors.ts): Caddy must pass the preflight through like any
# other request and pass the API's Access-Control-* headers back unchanged, adding none of its own. The echo upstream
# answers with the API's headers for a request with an Origin (echo-upstream.mjs), and 200 with its echo instead of the
# API's 204, so the request that reached it can be read.
CORS_ORIGIN=https://shop.example.net
CORS_ASKED="content-type,idempotency-key,x-api-key"
vary_origin() { grep -i '^vary:' "$HEADERS" | grep -qi 'origin'; }
allows_api_key() { grep -i '^access-control-allow-headers:' "$HEADERS" | grep -q 'X-Api-Key'; }
fetch "api.$STOREFRONT" /v1/flight-searches -X OPTIONS -H "Origin: $CORS_ORIGIN" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: $CORS_ASKED"
same "OPTIONS /v1/flight-searches on api.$STOREFRONT reaches the OTA API as it was sent [OBE-097 AC1]" \
  "$STATUS $(json port) $(json method) $(json url)" "200 4000 OPTIONS /v1/flight-searches"
same "the preflight reaches the OTA API with its Origin and its Access-Control-Request-* headers [OBE-097 AC1]" \
  "$(json headers.origin) $(json headers.access-control-request-method) $(json headers.access-control-request-headers)" \
  "[\"$CORS_ORIGIN\"] [\"POST\"] [\"$CORS_ASKED\"]"
same "the preflight's answer carries the API's Access-Control-Allow-Origin once [OBE-097 AC1]" \
  "$(header_count Access-Control-Allow-Origin) $(header Access-Control-Allow-Origin)" "1 $CORS_ORIGIN"
same "the preflight's answer carries the API's methods and max age unchanged [OBE-097 AC1]" \
  "$(header Access-Control-Allow-Methods) | $(header Access-Control-Max-Age)" "GET, POST, PUT, PATCH, DELETE | 7200"
check "the preflight's answer carries the API's allowed headers, X-Api-Key among them [OBE-097 AC1]" allows_api_key
check "the preflight's answer keeps the API's Vary: Origin [OBE-097 AC1]" vary_origin
same "the preflight's answer has no Access-Control-Allow-Credentials [OBE-097 AC1]" \
  "$(header_count Access-Control-Allow-Credentials)" 0
fetch "api.$STOREFRONT" /v1/storefront -H "Origin: $CORS_ORIGIN" -H "X-Api-Key: pk_test_smoke"
same "a GET with an Origin on api.$STOREFRONT gets the API's Allow-Origin and Expose-Headers back once [OBE-097 AC1]" \
  "$STATUS $(header_count Access-Control-Allow-Origin) $(header Access-Control-Allow-Origin) | $(header Access-Control-Expose-Headers)" \
  "200 1 $CORS_ORIGIN | X-Request-Id, Retry-After, ETag, Location"
check "the actual answer keeps the API's Vary: Origin [OBE-097 AC1]" vary_origin
fetch "api.$STOREFRONT" /v1/storefront -H "X-Api-Key: pk_test_smoke"
same "without an Origin, Caddy adds no CORS header of its own on api.$STOREFRONT [OBE-097 AC1]" \
  "$STATUS $(header_count Access-Control-Allow-Origin) $(header_count Access-Control-Allow-Methods)" "200 0 0"

# ---- 6e. the web application firewall (X-039) -------------------------------------------------------------------
step "Web application firewall: blocking on the storefront's /api/* and /checkout/* and on api.$STOREFRONT, detection elsewhere"
# Every request of this step carries a marker of its own in its query (waf=<marker>), so the WAF's log lines of a
# request are found by its [uri]; values that must never reach a log carry markers of their own.
WAF_MARK="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SQLI="id=1%27%20OR%20%271%27%3D%271"         # 1' OR '1'='1: CRS 942100 (SQL injection, libinjection)
XSS="q=%3Cscript%3Ealert(1)%3C%2Fscript%3E" # <script>alert(1)</script>: CRS 941100 (XSS, libinjection)
waf_lines() { grep -F '"logger":"http.handlers.waf"' "$TMP/caddy.log" || true; }
waf_logged() { # marker [rule id] -> a WAF log line holds the marker and, when given, names the rule
  local lines
  lines="$(waf_lines | grep -F -- "$1" || true)"
  [ -n "$lines" ] || return 1
  [ -z "${2:-}" ] || grep -qF "[id \\\"$2\\\"]" <<<"$lines"
}
no_waf_line() { ! waf_lines | grep -qF -- "$1"; }
refused_json() { # label: the last response is the WAF's 403 in the API's error envelope, answered by Caddy
  same "$1 answers 403 [X-039 AC2]" "$STATUS" 403
  same "$1 is the API's error envelope, FORBIDDEN [X-039 AC2]" \
    "$(header Content-Type) $(json error.code) $(json error.status)" "application/json FORBIDDEN 403"
  same "$1 never reaches the upstream [X-039 AC2]" "$(json port)" ""
  same "$1 is Cache-Control no-store [X-039 AC2]" "$(header Cache-Control)" no-store
  same "$1 has HSTS (ADR-0027) [X-039 AC2]" "$(header Strict-Transport-Security)" "max-age=31536000"
  same "$1 hides the Server header [X-039 AC2]" "$(header_count Server)" 0
}
passed_to() { # label port: the last response is the upstream's answer on that port
  same "$1 passes the WAF and reaches its app on $2 [X-039 AC2]" "$STATUS $(json port)" "200 $2"
}

# Blocking: the storefront's /api/*, in the query and in a JSON body, and the OTA API host.
n=0
for payload in "$SQLI 942100" "$XSS 941100"; do
  read -r query rule <<<"$payload"
  n=$((n + 1))
  mark="smkwaf$WAF_MARK-s$n"
  fetch "$TENANT" "/api/x?$query&waf=$mark"
  refused_json "$TENANT/api/x with CRS $rule's payload in the query"
  check "$TENANT/api/x: the storefront CSP on the refusal [X-039 AC2]" csp_ok
  check "$TENANT/api/x: the refusal is in the WAF log with rule $rule [X-039 AC2]" retry 20 waf_logged "$mark" "$rule"
  fetch "api.$STOREFRONT" "/x?$query&waf=$mark-api"
  refused_json "api.$STOREFRONT/x with CRS $rule's payload in the query"
  same "api.$STOREFRONT/x: X-Frame-Options DENY on the refusal [X-039 AC2]" "$(header X-Frame-Options)" DENY
  check "api.$STOREFRONT/x: the refusal is in the WAF log with rule $rule [X-039 AC2]" retry 20 waf_logged "$mark-api" "$rule"
done
printf '{"name":"x%s OR 1=1--"}' "'" >"$TMP/sqli.json"
for target in "$TENANT /api/v1/checkouts" "api.$STOREFRONT /v1/checkouts"; do
  read -r host path <<<"$target"
  fetch "$host" "$path?waf=smkwaf$WAF_MARK-body" -X POST -H "Content-Type: application/json" --data-binary "@$TMP/sqli.json"
  refused_json "$host$path with an SQL injection in a JSON field"
done
fetch "$TENANT" /api/x -H "X-Request-Id: smoke-waf-$WAF_MARK" --data-urlencode "x=1' OR '1'='1" -G
same "the refusal's error.requestId is the client's X-Request-Id [X-039 AC2]" "$(json error.requestId)" "smoke-waf-$WAF_MARK"
fetch "$TENANT" "/api/x?$SQLI"
check "without a client X-Request-Id, the refusal's error.requestId is a fresh UUID [X-039 AC2]" uuid_id
fetch "$TENANT" "/checkout/complete.html?$XSS&waf=smkwaf$WAF_MARK-page"
same "$TENANT/checkout/complete.html with an XSS payload answers 403 as text [X-039 AC2]" \
  "$STATUS $(header Content-Type) $(cat "$BODY")" \
  "403 text/plain; charset=utf-8 The request was refused by the web application firewall."
check "$TENANT/checkout/complete.html's refusal has the storefront CSP [X-039 AC2]" csp_ok
same "$TENANT/checkout/complete.html's refusal is Cache-Control no-store, with HSTS and no Server header [X-039 AC2]" \
  "$(header Cache-Control) | $(header Strict-Transport-Security) | $(header_count Server)" "no-store | max-age=31536000 | 0"

# Detection: the same requests pass, and the WAF logs them.
DETECTING=("$PLATFORM /hello 3000" "admin.$PLATFORM /hello 3001" "admin.$STOREFRONT /hello 3002"
  "api.$PLATFORM /hello 3100")
for app in "${DETECTING[@]}"; do
  read -r host path port <<<"$app"
  for payload in "$SQLI 942100" "$XSS 941100"; do
    read -r query rule <<<"$payload"
    mark="smkwaf$WAF_MARK-$host-$rule"
    fetch "$host" "$path?$query&waf=$mark"
    passed_to "$host$path with CRS $rule's payload" "$port"
    check "$host$path: the WAF logged CRS $rule for it (detection) [X-039 AC2]" retry 20 waf_logged "$mark" "$rule"
  done
done
fetch "$TENANT" "/?$SQLI&waf=smkwaf$WAF_MARK-page-detect"
same "$TENANT/ (a storefront page) with an SQL injection serves the page (detection) [X-039 AC2]" "$STATUS" 200
check "$TENANT/: the WAF logged CRS 942100 for it [X-039 AC2]" retry 20 waf_logged "smkwaf$WAF_MARK-page-detect" 942100

# Normal SDK and storefront requests pass both blocking WAFs, and leave no WAF log line.
BROWSER_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
cat >"$TMP/travelers.json" <<'JSON'
{"travelers":[{"firstName":"Seán","lastName":"O'Brien-Núñez","dateOfBirth":"1984-02-29","email":"sean.obrien@example.com","phone":"+353 1 234 5678"},{"firstName":"Maria","lastName":"D'Angelo","dateOfBirth":"2017-07-01"}],"contact":{"email":"ana+test@example.com","address":{"line1":"Rua do Carmo, 12 - 3º Esq.","city":"Lisboa","postalCode":"1200-093","countryCode":"PT"}},"remarks":"Window seat, please; vegetarian meal (no nuts) & extra legroom!"}
JSON
cat >"$TMP/card.json" <<'JSON'
{"card":{"number":"4111111111111111","holderName":"Ana O'Neil","expiryMonth":12,"expiryYear":2030,"cvc":"737"}}
JSON
{ printf -- '--%s\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n' "$BOUNDARY"
  head -c 2048 /dev/urandom
  printf '\r\n--%s--\r\n' "$BOUNDARY"; } >"$TMP/upload.bin"
SDK_HEADERS=(-H "Accept: application/json" -H "Accept-Language: pt-PT,pt;q=0.9,en;q=0.8" -H "X-Currency: EUR"
  -H "X-Api-Key: pk_test_smoke$WAF_MARK" -H "X-Velexis-End-User-Agent: $BROWSER_UA" -H "X-Velexis-End-User-IP: 203.0.113.7")
JWT="eyJhbGciOiJFZERTQSIsImtpZCI6InYxIn0.eyJzdWIiOiJ1c3JfMDEiLCJleHAiOjE3OTQzNzAwMDB9.c2lnbmF0dXJlLXZhbHVl"
# The hosted storefront's cookie mode (ota/sdk/src/internal/session.js): the session in the __Host-vx_ cookies, the
# CSRF cookie copied into X-CSRF-Token on writes, and what a browser adds to a same-origin fetch.
CSRF="Q3NyZi1zbW9rZS10b2tlbi1mb3ItdGhlLXdhZi0wMTIz"
COOKIE_HEADERS=(-H "Cookie: __Host-vx_at=$JWT; __Host-vx_rt=rt_UmVmcmVzaC1zbW9rZS10b2tlbi1mb3ItdGhlLXdhZg; __Host-vx_csrf=$CSRF"
  -H "X-CSRF-Token: $CSRF" -H "User-Agent: $BROWSER_UA" -H "Sec-Fetch-Site: same-origin" -H "Sec-Fetch-Mode: same-origin"
  -H "Sec-Fetch-Dest: empty" -H "Referer: https://$TENANT:$HTTPS_PORT/checkout/travellers?offer=off_01JA2Z7Q4M9R2T6V0X3Z8B1D5F&adults=2")
for prefix in "$TENANT /api" "api.$STOREFRONT "; do
  read -r host base <<<"$prefix"
  n=0
  for request in \
    "GET /v1/flight-offers?origin=LIS&destination=LHR&departureDate=2027-05-10&adults=2&children=1&page%5Bsize%5D=20&" \
    "POST /v1/flight-searches? $TMP/travelers.json" \
    "PUT /v1/checkouts/chk_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/travelers? $TMP/travelers.json" \
    "POST /v1/checkouts/chk_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/airline-card? $TMP/card.json" \
    "PATCH /v1/bookings/bkg_01JA2Z7Q4M9R2T6V0X3Z8B1D5F?" \
    "DELETE /v1/customers/me/saved-travelers/stv_01JA2Z7Q4M9R2T6V0X3Z8B1D5F?" \
    "OPTIONS /v1/flight-searches?" \
    "UPLOAD /v1/console/settings/assets?" \
    "COOKIE /v1/checkouts/chk_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/travelers? $TMP/travelers.json"; do
    read -r method path file <<<"$request"
    n=$((n + 1))
    mark="smkwaf$WAF_MARK-sdk$n"
    url="$base${path}waf=$mark"
    case "$method" in
      GET | DELETE) fetch "$host" "$url" -X "$method" "${SDK_HEADERS[@]}" -H "Authorization: Bearer $JWT" ;;
      POST | PUT)
        fetch "$host" "$url" -X "$method" "${SDK_HEADERS[@]}" -H "Content-Type: application/json" \
          -H "Idempotency-Key: 6f1c2a9e-3b7d-4c8e-9f01-$WAF_MARK" -H "X-Booking-Token: bt_smoke.$WAF_MARK" \
          --data-binary "@$file" ;;
      PATCH)
        fetch "$host" "$url" -X PATCH "${SDK_HEADERS[@]}" -H 'If-Match: "3"' -H "Authorization: Bearer $JWT" \
          -H "Content-Type: application/json" --data '{"contact":{"phone":"+44 20 7946 0958"}}' ;;
      OPTIONS)
        # A browser's CORS preflight (OBE-097) for a call with every header the SDK's transport can send.
        fetch "$host" "$url" -X OPTIONS -H "Origin: https://www.example.net" -H "Access-Control-Request-Method: POST" \
          -H "Access-Control-Request-Headers: accept-language,authorization,content-type,idempotency-key,if-match,x-api-key,x-booking-token,x-currency,x-request-id" ;;
      UPLOAD)
        method=POST
        fetch "$host" "$url" -X POST "${SDK_HEADERS[@]}" -H "Authorization: Bearer $JWT" \
          -H "Content-Type: multipart/form-data; boundary=$BOUNDARY" --data-binary "@$TMP/upload.bin" ;;
      COOKIE)
        method=PUT
        fetch "$host" "$url" -X PUT -H "Accept: application/json" -H "Accept-Language: pt-PT,pt;q=0.9,en;q=0.8" \
          "${COOKIE_HEADERS[@]}" -H "Content-Type: application/json" --data-binary "@$file" ;;
    esac
    same "$host: a normal $method $base${path%%\?*} reaches the OTA API [X-039 AC2]" \
      "$STATUS $(json port) $(json method)" "200 4000 $method"
    check "$host: the normal $method $base${path%%\?*} left no WAF log line [X-039 AC2]" no_waf_line "$mark"
  done
done

# What a matched rule writes to the log: the rule and the variable, never a value of the request (logdata.conf).
SECRET_MARK="smksecret$WAF_MARK"
CARD_NUMBER="4000002760003184" # a card number that no other request of this run sends
printf '{"email":"ana@example.com","password":"%s%s OR %s1%s=%s1"}' "$SECRET_MARK" "'" "'" "'" "'" >"$TMP/password.json"
printf '{"card":{"number":"%s","holderName":"%s%s OR %s1%s=%s1","cvc":"737"}}' "$CARD_NUMBER" "$SECRET_MARK" "'" "'" "'" "'" \
  >"$TMP/card-attack.json"
fetch "$PLATFORM" "/sign-in?waf=smkwaf$WAF_MARK-pw" -X POST -H "Content-Type: application/json" --data-binary "@$TMP/password.json"
passed_to "$PLATFORM/sign-in with an SQL injection in a JSON password (detection)" 3000
check "the WAF logged CRS 942100 on ARGS:json.password [X-039 AC2]" retry 20 waf_logged "ARGS:json.password" 942100
fetch "api.$PLATFORM" "/v1/x?waf=smkwaf$WAF_MARK-card" -X POST -H "Content-Type: application/json" \
  --data-binary "@$TMP/card-attack.json"
passed_to "api.$PLATFORM with card details and an SQL injection in the holder's name (detection)" 3100
check "the WAF logged CRS 942100 on ARGS:json.card.holderName [X-039 AC2]" retry 20 waf_logged "ARGS:json.card.holderName" 942100
check "no WAF log line holds the password's or the holder's value [X-039 AC2]" not grep -qF -- "$SECRET_MARK" "$TMP/caddy.log"
check "no log line holds the card number [X-039 AC2]" not grep -qF -- "$CARD_NUMBER" "$TMP/caddy.log"

# What one request may cost (coraza.conf rules 200007 and 200008): arguments above 128 KiB.
"$NODE" -e 'process.stdout.write(JSON.stringify({ bodyHtml: "<p>" + "x".repeat(140000) + "</p>" }))' >"$TMP/big.json"
fetch "api.$STOREFRONT" "/v1/console/email-templates/x?waf=smkwaf$WAF_MARK-big" -X PUT -H "Content-Type: application/json" \
  --data-binary "@$TMP/big.json"
same "api.$STOREFRONT: arguments above 128 KiB are refused with 413 before the Core Rule Set runs [X-039 AC2]" \
  "$STATUS $(json port)" "413 "
fetch "api.$PLATFORM" "/v1/x?waf=smkwaf$WAF_MARK-big-detect" -X PUT -H "Content-Type: application/json" \
  --data-binary "@$TMP/big.json"
same "api.$PLATFORM: the same arguments pass uninspected on a detection host, with every byte [X-039 AC2]" \
  "$STATUS $(json port) $(json bytes)" "200 3100 $(wc -c <"$TMP/big.json" | tr -d ' ')"
check "api.$PLATFORM: the WAF logged rule 200008 (not inspected) for it [X-039 AC2]" \
  retry 20 waf_logged "smkwaf$WAF_MARK-big-detect" 200008

# How much of a body the WAF reads (its body limit, rule 200006): it runs before request_body, so on the storefront it
# stops at 256 KiB, in memory, and refuses the rest itself; on a detection host it logs and Caddy's own limit refuses.
send_body "$TENANT" "/api$UPLOAD?waf=smkwaf$WAF_MARK-limit" 300000
same "$TENANT/api: a body above the storefront WAF's 256 KiB is refused with 413 and never reaches the API [X-039 AC2]" \
  "$STATUS $(json port)" "413 "
check "$TENANT/api: the WAF itself stopped reading it (rule 200006) [X-039 AC2]" retry 20 waf_logged "smkwaf$WAF_MARK-limit" 200006
send_body "api.$PLATFORM" "$UPLOAD?waf=smkwaf$WAF_MARK-limit-detect" "$UPLOAD_OK"
same "api.$PLATFORM: a body above the WAF's 1 MiB passes it in detection mode and meets Caddy's 1MB (413) [X-039 AC2]" \
  "$STATUS $(json port)" "413 "
check "api.$PLATFORM: the WAF logged rule 200006 for it (detection) [X-039 AC2]" \
  retry 20 waf_logged "smkwaf$WAF_MARK-limit-detect" 200006
# Nothing stays in Caddy's temporary folder (TMPDIR): the WAF buffers a body above 256 KiB and every file part of a
# multipart body there, and must remove them when the request ends, also when the file part has no closing boundary
# or is cut at the body limit (Coraza up to 3.8.0 kept such a part's file for good, so anyone could fill the disk).
{
  printf -- '--%s\r\nContent-Disposition: form-data; name="file"; filename="cut.png"\r\nContent-Type: image/png\r\n\r\n' \
    "$BOUNDARY"
  head -c 400000 /dev/zero
} >"$TMP/cut.bin"
for target in "$TENANT /api$UPLOAD" "api.$STOREFRONT $UPLOAD" "api.$PLATFORM /v1/x" "$PLATFORM /upload"; do
  read -r host path <<<"$target"
  fetch "$host" "$path?waf=smkwaf$WAF_MARK-cut" -X POST -H "Content-Type: multipart/form-data; boundary=$BOUNDARY" \
    --data-binary "@$TMP/cut.bin"
  same "$host$path with a multipart body without its closing boundary gets an answer [X-039 AC2]" "$CURL_RC" 0
done
caddy_tmp_empty() { [ -z "$(ls -A "$CADDY_TMP")" ] || { ls -l "$CADDY_TMP"; return 1; }; }
check "no temporary file of the WAF stays in Caddy's TMPDIR after the requests [X-039 AC2]" retry 20 caddy_tmp_empty

# Stripe's webhook paths on the OTA API host only detect (exclusions.conf, rule 10001).
fetch "api.$STOREFRONT" "/webhooks/stripe/velexis/test?waf=smkwaf$WAF_MARK-hook" -X POST \
  -H "Content-Type: application/json" --data-binary "@$TMP/sqli.json"
passed_to "api.$STOREFRONT/webhooks/stripe/velexis/test with an SQL injection in the event (detection only)" 4000
check "api.$STOREFRONT/webhooks/stripe/...: the WAF logged CRS 942100 for it [X-039 AC2]" \
  retry 20 waf_logged "smkwaf$WAF_MARK-hook" 942100

# The detection week (deployment-single-vm.md §6): VELEXIS_WAF_ENGINE=DetectionOnly in caddy.env, then a reload.
waf_reload() { # [VAR=value...] -> caddy reload of the test copy with the test environment and these variables
  "${caddy_env[@]}" "$@" "$CADDY" reload --config "$TEST_COPY" --adapter caddyfile >"$TMP/reload.log" 2>&1 \
    || { redact "$(cat "$TMP/reload.log")"; echo; return 1; }
}
check "caddy reload with VELEXIS_WAF_ENGINE=DetectionOnly succeeds [X-039 AC2]" waf_reload VELEXIS_WAF_ENGINE=DetectionOnly
for target in "$TENANT /api/x" "api.$STOREFRONT /x"; do
  read -r host path <<<"$target"
  fetch "$host" "$path?$SQLI&waf=smkwaf$WAF_MARK-week-$host"
  passed_to "$host$path with an SQL injection, VELEXIS_WAF_ENGINE=DetectionOnly" 4000
  check "$host$path: logged during the detection week [X-039 AC2]" retry 20 waf_logged "smkwaf$WAF_MARK-week-$host" 942100
done
check "caddy reload without VELEXIS_WAF_ENGINE succeeds [X-039 AC2]" waf_reload
fetch "$TENANT" "/api/x?$SQLI"
refused_json "$TENANT/api/x with an SQL injection after the switch back to blocking"

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
