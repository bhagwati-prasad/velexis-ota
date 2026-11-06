#!/usr/bin/env bash
# =====================================================================================================
# healthcheck.test.sh — tests deploy/scripts/healthcheck.sh (velexis-healthcheck) without root, systemd or a VM
# (task X-030).
#
#   bash deploy/scripts/test/healthcheck.test.sh
#
# Needs bash, curl, jq, openssl, flock, timeout and GNU coreutils (Linux: Ubuntu 24.04 like the VM and the CI
# runner), and Node 18 or newer for the fake endpoints (HEALTHCHECK_TEST_NODE, else node on PATH). No root, no
# systemd, no network beyond loopback; about 50 seconds (10 of them waiting for redis-cli's time limit in case 6).
#
# healthcheck.sh runs exactly as it is, with the test overrides of its header:
#   VELEXIS_ROOT    a temporary folder laid out like the VM: /etc/velexis (caddy.env, backup.env, healthcheck.env and
#                   .provision-secrets with random test values), /var/lib/velexis (the backup marker; the health
#                   check's state folder appears there), /srv/velexis/current -> a release whose storefront/ holds
#                   both payment pages, the home page, their scripts and stylesheets and a payment-page-inventory.json
#                   in the format of ota/frontend/README.md §10 (version 1), and /run (velexis-deploy's lock)
#   SYSTEMCTL       a stand-in that answers only `is-enabled <unit>`, from a file per unit
#   VELEXIS_ALERT   a stand-in for velexis-alert that records every `message <subject> <body>` (and refuses them all
#                   while the flag file alert-fails exists, as an SMTP outage would)
#   HEALTH_HOST     a random 127.x.y.z address, where fake-endpoints.mjs answers /health/ready on the seven unit ports
#                   (3000-3002, 3100, 3101, 4000, 4001) from a file per port (200 by default; the OTA worker's answer
#                   lists its queues), serves the storefront on 8080 with the headers of a JSON file per path, and
#                   speaks TLS on 8443 with a certificate per SNI name (made here with openssl, 90 days each)
#   STOREFRONT_URL  http://<that address>:8080
#   TLS_CONNECT     <that address>:8443
# and stand-ins for df (the use and mount point of each path from a file) and redis-cli (INFO memory from a file, or
# no answer at all while the flag file redis-hang exists; it records its arguments and whether REDISCLI_AUTH carried
# the password) first on PATH.
#
# Cases (docs/mvp/plans/foundation-tasks.md, X-030 step 4; [X-030 AC1]: the run and exactly one alert per transition,
# [X-030 AC2]: a payment-page alert names the page and the script or header):
#    1. a clean pass: every check ok, no alert, both payment pages, their second path and every first-party script and
#       stylesheet fetched without Accept-Encoding; a second run sends nothing and leaves the pages for tomorrow;
#    2. a failing disk check: one alert naming the path and its use; de-duplication: two more failing runs send
#       nothing; the recovery: one recovery alert, then nothing; a second path on the same file system is checked once;
#    3. the payment pages (--payment-pages, or the next UTC day): a script body changed in place under the same file
#       name, an extra script, and a changed Content-Security-Policy on /checkout/pay-airline.html only (not on its
#       second path /checkout/pay-airline, not on the card page) each raise one alert naming the page and the script
#       or header, and one recovery once undone; the extra script's URL is never fetched; a storefront that gives no
#       answer alerts once per page and is asked nothing more in that run;
#    4. the units: a unit that does not answer and one that answers 503 alert once each and recover once; masked and
#       disabled units are not checked; while velexis-deploy holds its lock no unit check runs (state kept) and the
#       payment pages due that day wait for the first run after it;
#    5. the OTA worker's queues: more than 20 failures in the hour and a job waiting more than 10 minutes alert
#       (20 and 600 s do not); an answer without queues keeps the states (no recovery from an unknown);
#    6. Redis memory above 70 % of maxmemory (the password only in redis-cli's environment), a backup marker older than
#       26 hours, and a certificate that expires within 14 days alert once each and recover once; a Redis that never
#       answers alerts once redis-cli's 10 s are up, and the checks after it still run;
#    7. an alert that velexis-alert cannot send keeps the state and fails the run (exit 1); the next run sends it once;
#    8. a missing inventory skips the payment page check with a warning (no alert, states kept); one of an unknown
#       version alerts; with HEALTHCHECK_PAGES=all every page of the inventory is checked (a header changed on / only);
#   and over the whole run: no test secret (Redis password, edge secret) in any output, alert, state file or log, and
#   no systemctl call but is-enabled.
#
# Settings (environment): HEALTHCHECK_TEST_NODE, HEALTHCHECK_TEST_TMPDIR (parent of the temporary folder; default
# TMPDIR or /tmp), HEALTHCHECK_TEST_HOST (a fixed address instead of a random 127.x.y.z one), HEALTHCHECK_TEST_KEEP=1
# (keep the temporary folder: the VM tree, every healthcheck.sh output in out/, the fakes' logs in state/).
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HC="$(cd "$HERE/.." && pwd)/healthcheck.sh"
NODE="${HEALTHCHECK_TEST_NODE:-$(command -v node || true)}"
PORTS=(3000 3001 3002 3100 3101 4000 4001 8080 8443)
UNITS=(velexis-platform-worker velexis-ota-worker velexis-platform-api velexis-ota-api velexis-portal
  velexis-platform-admin velexis-ota-admin)

FAILED=0
LOG_SHOWN=""
pass() { printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*"
  FAILED=1
  if [ -n "${LAST_OUT:-}" ] && [ "$LOG_SHOWN" != "$LAST_OUT" ]; then
    LOG_SHOWN="$LAST_OUT"
    echo "     output of the last healthcheck.sh run ($(basename "$LAST_OUT"), exit $RC):"
    sed -e "s#$PREFIX#<tmp>#g" -e 's/^/       /' "$LAST_OUT"
    echo "     alerts of that run:"
    printf '%s\n' "${NEW_ALERTS:-(none)}" | sed 's/^/       /'
  fi
}
die() { printf 'FAIL %s\n' "$*"; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
check() { # description command... -> one PASS or FAIL line
  local what="$1"
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
not() { ! "$@"; }
all_of() { # predicate... -> 0 when every one holds
  local p
  for p in "$@"; do "$p" || return 1; done
}

for tool in curl jq openssl flock timeout sha256sum awk sed stat setsid; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done
if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  die "Node.js 18 or newer is required (set HEALTHCHECK_TEST_NODE)"
fi
[ -f "$HC" ] || die "run it from a checkout of the repository"

PREFIX="$(mktemp -d "${HEALTHCHECK_TEST_TMPDIR:-${TMPDIR:-/tmp}}/velexis-healthcheck-test.XXXXXX")"
PREFIX="$(cd "$PREFIX" && pwd -P)"
ROOT="$PREFIX/root"   # the VM
STATE="$PREFIX/state" # FAKE_STATE of the stand-ins and the fake endpoints
FAKEBIN="$PREFIX/bin" # df, redis-cli, systemctl, velexis-alert
OUT="$PREFIX/out"     # every output of healthcheck.sh
mkdir -p "$ROOT" "$STATE" "$FAKEBIN" "$OUT"
SERVER_PID=""
LOCK_PID=""

cleanup() {
  local rc=$?
  [ -z "$LOCK_PID" ] || kill "$LOCK_PID" 2>/dev/null || true
  [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true
  if [ "${HEALTHCHECK_TEST_KEEP:-0}" = 1 ]; then
    echo "HEALTHCHECK_TEST_KEEP=1: kept $PREFIX"
  else
    rm -rf --one-file-system "$PREFIX"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- the VM as provision-vm.sh and the first deploys leave it ---------------------------------------------------
ETC="$ROOT/etc/velexis"
LIB="$ROOT/var/lib/velexis"
HCSTATE="$LIB/healthcheck"
REL="$ROOT/srv/velexis/releases/r1"
SF="$REL/storefront"
MARKER="$LIB/backup-last-success"
mkdir -p "$ETC" "$LIB" "$SF/checkout" "$SF/assets" "$ROOT/run"
ln -s "$REL" "$ROOT/srv/velexis/current"
# Test values that must never leave the files that hold them: one random token in each, so any leak is found by grep.
TOKEN="x030$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
REDIS_PASSWORD="redis-$TOKEN"
printf 'PLATFORM_BASE_DOMAIN=platform.example.com\nSTOREFRONT_BASE_DOMAIN=ota.example.com\nACME_EMAIL=ops@example.com\nVELEXIS_EDGE_SECRET=edge-%s\n' \
  "$TOKEN" >"$ETC/caddy.env"
printf 'MIGRATOR_DB_PASSWORD=m-%s\nREDIS_PASSWORD=%s\nEDGE_SECRET=edge-%s\n' "$TOKEN" "$REDIS_PASSWORD" "$TOKEN" \
  >"$ETC/.provision-secrets"
printf 'BACKUP_DIR=/var/backups/velexis\nREDIS_PASSWORD=%s\nBACKUP_MARKER_FILE=/var/lib/velexis/backup-last-success\n' \
  "$REDIS_PASSWORD" >"$ETC/backup.env"
printf '# test settings\nHEALTHCHECK_STOREFRONT_HOST=demo.ota.example.com\n' >"$ETC/healthcheck.env"
chmod 0600 "$ETC"/*.env "$ETC/.provision-secrets"
printf '%s\n' "$REDIS_PASSWORD" >"$STATE/redis-password"
set_marker_age() { echo "$(($(date -u +%s) - $1))" >"$MARKER"; } # seconds
set_marker_age 3600

# ---- the storefront release: pages, scripts, stylesheets and the inventory (format version 1) --------------------
CARD_JS=/assets/checkout-pay-card-T3stA1b2.js
AIRLINE_JS=/assets/checkout-pay-airline-T3stC3d4.js
BOOT_JS=/assets/boot-T3stE5f6.js
INDEX_JS=/assets/index-T3stG7h8.js
CARD_CSS=/assets/boot-T3stI9j0.css
AIRLINE_CSS=/assets/checkout-pay-airline-T3stK1l2.css
STRIPE_JS=https://js.stripe.com/v3/
EXTRA_JS=https://cdn.example.net/skim.js
printf 'import "./boot-T3stE5f6.js";\nexport const page = "pay-card";\n' >"$SF$CARD_JS"
printf 'export const page = "pay-airline";\n' >"$SF$AIRLINE_JS"
printf 'export const boot = () => document.documentElement.dataset.ready = "1";\n' >"$SF$BOOT_JS"
printf 'import "./boot-T3stE5f6.js";\nexport const page = "home";\n' >"$SF$INDEX_JS"
printf 'body { margin: 0; }\n' >"$SF$CARD_CSS"
printf 'body { margin: 0; color: #111; }\n' >"$SF$AIRLINE_CSS"
page_html() { # title scripts-and-links
  printf '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    <title>%s</title>\n%s\n  </head>\n  <body><main id="main"></main></body>\n</html>\n' "$1" "$2"
}
page_html "Pay by card" "    <script src=\"$STRIPE_JS\" defer></script>
    <script type=\"module\" crossorigin src=\"$CARD_JS\"></script>
    <link rel=\"modulepreload\" crossorigin href=\"$BOOT_JS\">
    <link rel=\"stylesheet\" crossorigin href=\"$CARD_CSS\">" >"$SF/checkout/pay-card.html"
page_html "Pay with your card at the airline" "    <script type=\"module\" crossorigin src=\"$AIRLINE_JS\"></script>
    <link rel=\"stylesheet\" crossorigin href=\"$AIRLINE_CSS\">" >"$SF/checkout/pay-airline.html"
page_html "Search flights" "    <script type=\"module\" crossorigin src=\"$INDEX_JS\"></script>
    <link rel=\"modulepreload\" crossorigin href=\"$BOOT_JS\">
    <link rel=\"stylesheet\" crossorigin href=\"$CARD_CSS\">" >"$SF/index.html"
PRISTINE="$PREFIX/pristine"
cp -a "$SF" "$PRISTINE"
restore_storefront() { rm -rf "$SF" && cp -a "$PRISTINE" "$SF"; }

# The Caddyfile's values (deploy/caddy/Caddyfile): the storefront CSP and the airline-card page's own.
CSP_STOREFRONT="default-src 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'none'"
CSP_AIRLINE="default-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'none'; img-src 'self' data:; style-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; worker-src 'none'"
sha_of() { sha256sum "$SF$1" | cut -c1-64; }
write_inventory() { # writes $SF/payment-page-inventory.json from the files as they are now
  jq -n --arg sf "$CSP_STOREFRONT" --arg air "$CSP_AIRLINE" \
    --arg cardHtml "$(sha_of /checkout/pay-card.html)" --arg airHtml "$(sha_of /checkout/pay-airline.html)" \
    --arg indexHtml "$(sha_of /index.html)" \
    --arg cardJs "$CARD_JS" --arg cardJsSha "$(sha_of "$CARD_JS")" --arg airJs "$AIRLINE_JS" \
    --arg airJsSha "$(sha_of "$AIRLINE_JS")" --arg bootJs "$BOOT_JS" --arg bootJsSha "$(sha_of "$BOOT_JS")" \
    --arg indexJs "$INDEX_JS" --arg indexJsSha "$(sha_of "$INDEX_JS")" --arg cardCss "$CARD_CSS" \
    --arg cardCssSha "$(sha_of "$CARD_CSS")" --arg airCss "$AIRLINE_CSS" --arg airCssSha "$(sha_of "$AIRLINE_CSS")" \
    --arg stripe "$STRIPE_JS" '
    def headers($csp): {"Strict-Transport-Security": "max-age=31536000", "Content-Security-Policy": $csp,
      "Referrer-Policy": "strict-origin-when-cross-origin", "X-Content-Type-Options": "nosniff",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Cross-Origin-Opener-Policy": null,
      "Server": null, "Cache-Control": "no-cache"};
    {format: "velexis-storefront-payment-page-inventory", version: 1,
     description: "healthcheck.test.sh fixture in the format of ota/frontend/README.md §10",
     pages: [
      {file: "checkout/pay-airline.html", path: "/checkout/pay-airline.html",
       paths: ["/checkout/pay-airline.html", "/checkout/pay-airline"], payment: true, purpose: "Airline-card payment",
       sha256: $airHtml,
       scripts: [{src: $airJs, firstParty: true, sha256: $airJsSha, purpose: "entry bundle"}],
       modulePreloads: [], firstPartyScripts: [{src: $airJs, sha256: $airJsSha}],
       stylesheets: [{href: $airCss, sha256: $airCssSha}],
       headers: (headers($air) + {"Cross-Origin-Opener-Policy": "same-origin", "Cache-Control": "no-store"})},
      {file: "checkout/pay-card.html", path: "/checkout/pay-card.html", paths: ["/checkout/pay-card.html"],
       payment: true, purpose: "Card payment", sha256: $cardHtml,
       scripts: [{src: $stripe, firstParty: false, sha256: null, purpose: "Stripe.js", justification: "Stripe"},
                 {src: $cardJs, firstParty: true, sha256: $cardJsSha, purpose: "entry bundle"}],
       modulePreloads: [{href: $bootJs, sha256: $bootJsSha}],
       firstPartyScripts: [{src: $bootJs, sha256: $bootJsSha}, {src: $cardJs, sha256: $cardJsSha}],
       stylesheets: [{href: $cardCss, sha256: $cardCssSha}], headers: headers($sf)},
      {file: "index.html", path: "/", paths: ["/"], payment: false, purpose: "Home", sha256: $indexHtml,
       scripts: [{src: $indexJs, firstParty: true, sha256: $indexJsSha, purpose: "entry bundle"}],
       modulePreloads: [{href: $bootJs, sha256: $bootJsSha}],
       firstPartyScripts: [{src: $bootJs, sha256: $bootJsSha}, {src: $indexJs, sha256: $indexJsSha}],
       stylesheets: [{href: $cardCss, sha256: $cardCssSha}], headers: headers($sf)}
     ]}' >"$SF/payment-page-inventory.json"
}
write_inventory
cp "$SF/payment-page-inventory.json" "$PRISTINE/"

# What the fake storefront sends (Caddy's headers): every path, then the airline-card page's two paths.
HEADERS_FILE="$STATE/storefront-headers.json"
write_headers() { # [jq options and a filter applied to the Caddy-like headers]
  [ $# -gt 0 ] || set -- .
  jq -n --arg sf "$CSP_STOREFRONT" --arg air "$CSP_AIRLINE" '
    {default: {"Strict-Transport-Security": "max-age=31536000", "Content-Security-Policy": $sf,
       "Referrer-Policy": "strict-origin-when-cross-origin", "X-Content-Type-Options": "nosniff",
       "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Cache-Control": "no-cache"},
     paths: {"/checkout/pay-airline.html": {"Content-Security-Policy": $air, "Cross-Origin-Opener-Policy": "same-origin",
               "Cache-Control": "no-store"},
             "/checkout/pay-airline": {"Content-Security-Policy": $air, "Cross-Origin-Opener-Policy": "same-origin",
               "Cache-Control": "no-store"}}}' | jq "$@" >"$HEADERS_FILE.tmp"
  mv "$HEADERS_FILE.tmp" "$HEADERS_FILE"
}
write_headers

# ---- certificates: one per named host (90 days), replaced per case ---------------------------------------------------
mkdir -p "$STATE/tls" "$STATE/health" "$STATE/units" "$STATE/df" "$STATE/alerts"
: >"$STATE/alerts.log"
: >"$STATE/requests.log"
make_cert() { # name days
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$STATE/tls/$1.key.tmp" \
    -out "$STATE/tls/$1.crt.tmp" -days "$2" -subj "/CN=$1" >/dev/null 2>&1 || die "openssl could not make a certificate"
  mv "$STATE/tls/$1.key.tmp" "$STATE/tls/$1.key"
  mv "$STATE/tls/$1.crt.tmp" "$STATE/tls/$1.crt"
}
TLS_HOSTS=(platform.example.com admin.platform.example.com api.platform.example.com admin.ota.example.com api.ota.example.com)
for h in default "${TLS_HOSTS[@]}"; do make_cert "$h" 90; done

# ---- the fakes on PATH -------------------------------------------------------------------------------------------
cat >"$FAKEBIN/df" <<'SH'
#!/usr/bin/env bash
# healthcheck.test.sh's df: `df -P <path>` prints the use and the mount point of <path> from $FAKE_STATE/df/<path with
# / as _> ("<percent> <mount point>"); by default 42 % and its own file system.
set -euo pipefail
path="${*: -1}"
printf '%s\n' "$*" >>"$FAKE_STATE/df.log"
spec="42 $path"
key="$(printf '%s' "$path" | tr '/' '_')"
[ ! -f "$FAKE_STATE/df/$key" ] || spec="$(cat "$FAKE_STATE/df/$key")"
pct="${spec%% *}"
echo "Filesystem     1024-blocks      Used Available Capacity Mounted on"
printf '/dev/fake        104857600 %9d %9d %7s %s\n' "$((pct * 1048576))" "$(((100 - pct) * 1048576))" "$pct%" "${spec#* }"
SH
cat >"$FAKEBIN/redis-cli" <<'SH'
#!/usr/bin/env bash
# healthcheck.test.sh's redis-cli: records its arguments and whether REDISCLI_AUTH carried the test's password (never
# the value), then answers INFO memory with redis-cli's CRLF line ends from $FAKE_STATE/redis-memory ("<used> <max>").
set -euo pipefail
expected="$(cat "$FAKE_STATE/redis-password")"
auth=none
if [ -n "${REDISCLI_AUTH:-}" ]; then
  if [ "$REDISCLI_AUTH" = "$expected" ]; then auth=ok; else auth=wrong; fi
fi
printf 'argv=%s auth=%s\n' "$*" "$auth" >>"$FAKE_STATE/redis-cli.log"
if [ "$auth" != ok ]; then echo "AUTH failed: WRONGPASS invalid username-password pair or user is disabled."; exit 0; fi
# A Redis that accepts the connection and never answers: waits 60 s, and records being stopped by the caller's timeout.
if [ -e "$FAKE_STATE/redis-hang" ]; then
  trap 'echo "stopped by SIGTERM" >>"$FAKE_STATE/redis-cli.log"; kill "$sleeper" 2>/dev/null; exit 143' TERM
  sleep 60 &
  sleeper=$!
  wait "$sleeper"
  exit 0
fi
read -r used max <"$FAKE_STATE/redis-memory"
printf '# Memory\r\nused_memory:%s\r\nused_memory_human:%sB\r\nmaxmemory:%s\r\nmaxmemory_policy:noeviction\r\n' \
  "$used" "$used" "$max"
SH
cat >"$FAKEBIN/systemctl" <<'SH'
#!/usr/bin/env bash
# healthcheck.test.sh's SYSTEMCTL: only `is-enabled <unit>`, answered from $FAKE_STATE/units/<unit> (enabled, disabled
# or masked; exit 0 for enabled only, as systemctl does); a missing file is a unit that is not installed.
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_STATE/systemctl.log"
if [ "${1:-}" != is-enabled ] || [ $# -ne 2 ]; then
  printf 'unexpected %s\n' "$*" >>"$FAKE_STATE/unexpected.log"
  echo "fake systemctl: unexpected command: $*" >&2
  exit 1
fi
f="$FAKE_STATE/units/$2"
if [ ! -f "$f" ]; then echo "Failed to get unit file state for $2.service: No such file or directory" >&2; exit 1; fi
state="$(cat "$f")"
echo "$state"
[ "$state" = enabled ]
SH
cat >"$FAKEBIN/velexis-alert" <<'SH'
#!/usr/bin/env bash
# healthcheck.test.sh's VELEXIS_ALERT: `message <subject> <body-file>` only. Records the subject in alerts.log and the
# body in alerts/<n>.txt, or refuses (exit 1, nothing recorded) while $FAKE_STATE/alert-fails exists.
set -euo pipefail
if [ "${1:-}" != message ] || [ $# -ne 3 ]; then
  printf 'unexpected velexis-alert %s\n' "$*" >>"$FAKE_STATE/unexpected.log"
  exit 2
fi
if [ -e "$FAKE_STATE/alert-fails" ]; then
  printf '%s\n' "$2" >>"$FAKE_STATE/alerts-refused.log"
  echo "velexis-alert: curl: (7) Failed to connect to the SMTP server" >&2
  exit 1
fi
n=$(($(wc -l <"$FAKE_STATE/alerts.log") + 1))
cp "$3" "$FAKE_STATE/alerts/$n.txt"
printf '%s\n' "$2" >>"$FAKE_STATE/alerts.log"
echo "velexis-alert: sent \"$2\""
SH
chmod 0755 "$FAKEBIN"/*

# ---- the fake endpoints: unit health ports, the storefront and the TLS server -----------------------------------------
cat >"$PREFIX/fake-endpoints.mjs" <<'JS'
// healthcheck.test.sh's endpoints. node fake-endpoints.mjs <host> <state> <storefront root> <http port> <tls port>
// <health port>...
//   health ports: GET /health/ready answers from <state>/health/<port> (first line: the status, or "close" to drop the
//                 connection; the rest: the body), else 200 with a readiness body (the OTA worker's, 4001, lists queues)
//   http port:    the storefront: files of <storefront root> (resolved per request, as Caddy follows `current`) with
//                 try_files {path} {path}.html {path}/index.html, and the headers of <state>/storefront-headers.json
//                 (`default`, then `paths[<path>]`; a null value removes a header); while <state>/storefront-silent
//                 exists it drops every connection without an answer
//   tls port:     a certificate per SNI name from <state>/tls/<name>.{key,crt} (default.* otherwise), read per handshake
// Every request is one line of <state>/requests.log; <state>/server.ready appears once everything listens.
import { appendFileSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createSecureContext, createServer as createTlsServer } from "node:tls";

const [host, state, storefront, httpPort, tlsPort, ...healthPorts] = process.argv.slice(2);
const log = (line) => appendFileSync(join(state, "requests.log"), `${line}\n`);
const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const queue = (failedLastHour, oldestWaitingSeconds) => ({ waiting: oldestWaitingSeconds === null ? 0 : 1, oldestWaitingSeconds, failedLastHour });
const readiness = (port) => ({
  status: "ok",
  checks: { postgres: "ok", redis: "ok" },
  ...(port === "4001" ? { queues: { "ota-payments": queue(0, null), "ota-stripe-events": queue(0, null) } } : {}),
});

let listening = 0;
const total = healthPorts.length + 2;
const listened = () => {
  listening += 1;
  if (listening === total) writeFileSync(join(state, "server.ready"), `${process.pid}\n`);
};
const listen = (server, port) => {
  server.on("error", (error) => {
    writeFileSync(join(state, "server.error"), `${port} ${error.code ?? error.message}\n`);
    process.exit(1);
  });
  server.listen(Number(port), host, listened);
};

for (const port of healthPorts) {
  listen(
    createServer((req, res) => {
      log(`health ${port} ${req.method} ${req.url}`);
      if (req.url !== "/health/ready") {
        res.writeHead(404).end();
        return;
      }
      const spec = read(join(state, "health", port));
      if (spec === null) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(readiness(port)));
        return;
      }
      const [first, ...rest] = spec.split("\n");
      if (first.trim() === "close") {
        req.socket.destroy();
        return;
      }
      res.writeHead(Number(first), { "content-type": "application/json" }).end(rest.join("\n"));
    }),
    port,
  );
}

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
listen(
  createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://storefront").pathname);
    log(`storefront ${req.method} ${path} accept-encoding=${req.headers["accept-encoding"] ?? "none"}`);
    if (read(join(state, "storefront-silent")) !== null) {
      req.socket.destroy();
      return;
    }
    const root = realpathSync(storefront);
    const file = path.includes("..")
      ? null
      : [path, `${path}.html`, join(path, "index.html")].map((p) => join(root, p)).find((f) => {
          try {
            return statSync(f).isFile();
          } catch {
            return false;
          }
        });
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    const config = JSON.parse(read(join(state, "storefront-headers.json")));
    const headers = { ...config.default, ...(config.paths[path] ?? {}) };
    for (const name of Object.keys(headers)) if (headers[name] === null) delete headers[name];
    const body = readFileSync(file);
    const type = types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
    res.writeHead(200, { ...headers, "content-type": type, "content-length": body.length }).end(body);
  }),
  httpPort,
);

const context = (name) => {
  const base = read(join(state, "tls", `${name}.crt`)) === null ? "default" : name;
  return createSecureContext({
    key: readFileSync(join(state, "tls", `${base}.key`)),
    cert: readFileSync(join(state, "tls", `${base}.crt`)),
  });
};
listen(
  createTlsServer(
    {
      key: readFileSync(join(state, "tls", "default.key")),
      cert: readFileSync(join(state, "tls", "default.crt")),
      SNICallback: (name, done) => {
        log(`tls ${name}`);
        try {
          done(null, context(name));
        } catch (error) {
          done(error);
        }
      },
    },
    (socket) => socket.end(),
  ),
  tlsPort,
);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
JS

ports_free() { # host -> 0 when every port can be bound there
  "$NODE" -e '
    const net = require("net");
    const [host, ...ports] = process.argv.slice(1);
    const servers = [];
    (async () => {
      for (const port of ports) {
        await new Promise((resolve, reject) => {
          const s = net.createServer();
          s.once("error", reject);
          s.listen(Number(port), host, () => { servers.push(s); resolve(); });
        });
      }
    })().then(() => servers.forEach((s) => s.close()),
      () => { servers.forEach((s) => s.close()); process.exitCode = 1; });
  ' "$1" "${PORTS[@]}" 2>/dev/null
}
HOST=""
if [ -n "${HEALTHCHECK_TEST_HOST:-}" ]; then
  HOST="$HEALTHCHECK_TEST_HOST"
  ports_free "$HOST" || die "the test ports are not free on HEALTHCHECK_TEST_HOST $HOST"
else
  for _ in $(seq 1 20); do
    candidate="127.$((RANDOM % 254 + 1)).$((RANDOM % 254 + 1)).$((RANDOM % 253 + 2))"
    if ports_free "$candidate"; then HOST="$candidate"; break; fi
  done
  [ -n "$HOST" ] || die "found no 127.x.y.z address with free test ports (set HEALTHCHECK_TEST_HOST)"
fi
echo "VM root: $ROOT"
echo "endpoint host: $HOST"
setsid "$NODE" "$PREFIX/fake-endpoints.mjs" "$HOST" "$STATE" "$ROOT/srv/velexis/current/storefront" 8080 8443 \
  3000 3001 3002 3100 3101 4000 4001 >"$STATE/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 200); do
  [ ! -f "$STATE/server.ready" ] || break
  [ ! -f "$STATE/server.error" ] || die "the fake endpoints could not listen: $(cat "$STATE/server.error")"
  kill -0 "$SERVER_PID" 2>/dev/null || die "the fake endpoints stopped: $(cat "$STATE/server.log")"
  sleep 0.05
done
[ -f "$STATE/server.ready" ] || die "the fake endpoints did not start"

# ---- running healthcheck.sh -------------------------------------------------------------------------------------------
for unit in "${UNITS[@]}"; do echo enabled >"$STATE/units/$unit"; done
echo "100000000 536870912" >"$STATE/redis-memory" # 19 % of 512 MiB

RUN=0
RC=0
LAST_OUT=""
NEW_ALERTS=""
NEW_BODIES=""
run_hc() { # [arguments] -> RC, LAST_OUT and the subjects (NEW_ALERTS) and bodies (NEW_BODIES) of this run's alerts
  local before after i
  RUN=$((RUN + 1))
  LAST_OUT="$OUT/run-$(printf '%02d' "$RUN").txt"
  before="$(wc -l <"$STATE/alerts.log")"
  : >"$STATE/requests.run.log"
  local requests_before
  requests_before="$(wc -l <"$STATE/requests.log")"
  RC=0
  env -i PATH="$FAKEBIN:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 FAKE_STATE="$STATE" VELEXIS_ROOT="$ROOT" \
    SYSTEMCTL="$FAKEBIN/systemctl" VELEXIS_ALERT="$FAKEBIN/velexis-alert" HEALTH_HOST="$HOST" \
    STOREFRONT_URL="http://$HOST:8080" TLS_CONNECT="$HOST:8443" \
    bash "$HC" "$@" >"$LAST_OUT" 2>&1 || RC=$?
  after="$(wc -l <"$STATE/alerts.log")"
  NEW_ALERTS="$(tail -n +"$((before + 1))" "$STATE/alerts.log")"
  NEW_BODIES=""
  for ((i = before + 1; i <= after; i++)); do NEW_BODIES="$NEW_BODIES$(cat "$STATE/alerts/$i.txt")"$'\n'; done
  tail -n +"$((requests_before + 1))" "$STATE/requests.log" >"$STATE/requests.run.log"
}
alerts_are() { # n -> this run sent exactly n alerts
  local n=0
  [ -z "$NEW_ALERTS" ] || n="$(printf '%s\n' "$NEW_ALERTS" | wc -l)"
  [ "$n" -eq "$1" ]
}
alert_has() { printf '%s\n' "$NEW_ALERTS" | grep -qF -- "$1"; }
alerts_match() { # n text -> exactly n of this run's alert subjects contain text
  [ "$(printf '%s\n' "$NEW_ALERTS" | grep -cF -- "$2" || true)" -eq "$1" ]
}
body_has() { printf '%s\n' "$NEW_BODIES" | grep -qF -- "$1"; }
out_has() { grep -qF -- "$1" "$LAST_OUT"; }
rc_is() { [ "$RC" -eq "$1" ]; }
state_is() { [ "$(head -n 1 "$HCSTATE/$1.state" 2>/dev/null || true)" = "$2" ]; }
fetched() { grep -qxF "storefront GET $1 accept-encoding=none" "$STATE/requests.run.log"; }
no_storefront_request() { not grep -q '^storefront ' "$STATE/requests.run.log"; }
quiet_run() { rc_is 0 && alerts_are 0; } # exit 0 and no alert
recovered() { rc_is 0 && alerts_are 1 && alert_has "health check recovered: $1"; } # label: exactly its recovery
failed_once() { rc_is 0 && alerts_are 1 && alert_has "health check failed: $1"; } # text: exactly one failure alert
home_not_fetched() { not grep -q '^storefront GET / ' "$STATE/requests.run.log"; }
recoveries() { # n -> exit 0 and exactly n alerts, every one a recovery
  rc_is 0 && alerts_are "$1" && [ "$(printf '%s\n' "$NEW_ALERTS" | grep -c '^health check recovered: ' || true)" -eq "$1" ]
}
ok_ids() { # id... -> the run printed "ok" for each
  local id
  for id in "$@"; do grep -qxF "ok   $id" "$LAST_OUT" || { echo "     not ok: $id"; return 1; }; done
}
set_health() { # port status [body] | port close | port default
  case "$2" in
    default) rm -f "$STATE/health/$1" ;;
    close) echo close >"$STATE/health/$1" ;;
    *) printf '%s\n%s\n' "$2" "${3:-}" >"$STATE/health/$1" ;;
  esac
}
set_df() { echo "$2" >"$STATE/df/$(printf '%s' "$1" | tr '/' '_')"; } # path "<percent> <mount point>"
queues_body() { # payments-failed payments-oldest stripe-failed stripe-oldest -> the OTA worker's readiness body
  jq -cn --argjson a "$1" --argjson b "$2" --argjson c "$3" --argjson d "$4" \
    '{status: "ok", checks: {postgres: "ok", redis: "ok"}, queues: {
       "ota-payments": {waiting: 3, oldestWaitingSeconds: $b, failedLastHour: $a},
       "ota-stripe-events": {waiting: 1, oldestWaitingSeconds: $d, failedLastHour: $c}}}'
}

ALL_IDS=(ready-velexis-platform-worker ready-velexis-ota-worker ready-velexis-platform-api ready-velexis-ota-api
  ready-velexis-portal ready-velexis-platform-admin ready-velexis-ota-admin failed-jobs-velexis-ota-worker
  queue-age-velexis-ota-worker disk-root disk-var-lib-postgresql redis-memory backup-age tls-platform.example.com
  tls-admin.platform.example.com tls-api.platform.example.com tls-admin.ota.example.com tls-api.ota.example.com
  payment-inventory payment-page-checkout-pay-card payment-page-checkout-pay-airline)

# ---- 1. a clean pass ----------------------------------------------------------------------------------------------------
step "1. a clean pass"
run_hc
check "a clean first run exits 0 and sends no alert [X-030 AC1]" quiet_run
check "every check passes: the seven units, the OTA worker's queues, both disks, Redis, the backup, the five certificates and both payment pages [X-030 AC1]" \
  ok_ids "${ALL_IDS[@]}"
check "the platform worker's readiness lists no queues, so its job checks are skipped, not passed [X-030 AC1]" \
  out_has "skip failed-jobs-velexis-platform-worker, queue-age-velexis-platform-worker: its readiness lists no queues"
fetched_all() {
  fetched /checkout/pay-card.html && fetched /checkout/pay-airline.html && fetched /checkout/pay-airline &&
    fetched "$CARD_JS" && fetched "$BOOT_JS" && fetched "$CARD_CSS" && fetched "$AIRLINE_JS" && fetched "$AIRLINE_CSS"
}
check "both payment pages, the second path of the airline-card page and every first-party script and stylesheet are fetched without Accept-Encoding [X-030 AC2]" \
  fetched_all
check "the payment page check fetches nothing but the inventory's own paths (Stripe.js is compared by URL only) [X-030 AC2]" \
  not grep -Eq 'js\.stripe|^storefront GET /(index\.html)? ' "$STATE/requests.run.log"
every_state_ok() { local id; for id in "${ALL_IDS[@]}"; do state_is "$id" ok || return 1; done; }
check "a state file per check, each ok [X-030 AC1]" every_state_ok
check "the state folder is 0700 [X-030]" test "$(stat -c %a "$HCSTATE")" = 700
run_hc
check "a second run sends nothing [X-030 AC1]" quiet_run
pages_left_for_tomorrow() { no_storefront_request && out_has "skip payment pages: checked today already"; }
check "and leaves the payment pages for the next UTC day: no storefront request [X-030 AC1]" pages_left_for_tomorrow

# ---- 2. disk: a failing check, de-duplication and the recovery --------------------------------------------------------
step "2. disk: one alert per transition"
set_df / "91 /"
run_hc
disk_alerted() {
  rc_is 0 && alerts_are 1 && alert_has "health check failed: disk /: / is 91 % full (more than 80 %" &&
    body_has "/ is 91 % full" && body_has "Check: disk-root" && state_is disk-root fail
}
check "a disk above 80 % sends exactly one alert, naming the path and its use [X-030 AC1]" disk_alerted
run_hc
check "the next run, still at 91 %, sends nothing (de-duplication) [X-030 AC1]" quiet_run
set_df / "97 /"
run_hc
check "a third failing run (97 %) sends nothing either: one alert per transition, not per value [X-030 AC1]" quiet_run
set_df / "40 /"
run_hc
disk_recovered() {
  rc_is 0 && alerts_are 1 && alert_has "health check recovered: disk /" && body_has "disk / is ok again" &&
    state_is disk-root ok
}
check "back under 80 %: exactly one recovery alert [X-030 AC1]" disk_recovered
run_hc
check "and then nothing [X-030 AC1]" quiet_run
set_df /var/lib/postgresql "95 /"
run_hc
same_fs_once() {
  quiet_run && out_has "skip disk-var-lib-postgresql: /var/lib/postgresql is on the file system /, checked above"
}
check "/var/lib/postgresql on the file system of / is checked once, as / (so 95 % there is not a second alert) [X-030 AC1]" \
  same_fs_once
rm -f "$STATE/df/_var_lib_postgresql"
set_df /var/lib/postgresql "88 /var/lib/postgresql"
run_hc
pg_alerted() { alerts_are 1 && alert_has "health check failed: disk /var/lib/postgresql: /var/lib/postgresql is 88 % full"; }
check "/var/lib/postgresql on its own file system above 80 %: one alert naming it [X-030 AC1]" pg_alerted
rm -f "$STATE/df/_var_lib_postgresql"
run_hc
check "and one recovery [X-030 AC1]" recovered "disk /var/lib/postgresql"

# ---- 3. the payment pages -------------------------------------------------------------------------------------------
step "3. payment pages against the inventory"
printf '/* changed in place */\n' >>"$SF$CARD_JS"
run_hc --payment-pages
script_changed() {
  rc_is 0 && alerts_are 1 && alert_has "health check failed: payment page /checkout/pay-card.html: script $CARD_JS" &&
    body_has "script $CARD_JS: its SHA-256 differs from the inventory (its content changed under the same name)" &&
    body_has "inventory: $(sha256sum <"$PRISTINE$CARD_JS" | cut -c1-64)" && body_has "served:    $(sha_of "$CARD_JS")" &&
    not body_has "the HTML differs" && state_is payment-page-checkout-pay-airline ok
}
check "a script body changed in place under the same file name: one alert naming the page and the script [X-030 AC2]" \
  script_changed
run_hc --payment-pages
check "the next check, still changed, sends nothing [X-030 AC1]" quiet_run
restore_storefront
run_hc --payment-pages
check "the script restored: one recovery of the card page [X-030 AC1]" recovered "payment page /checkout/pay-card.html"

sed -i "s#^    <script src=\"$STRIPE_JS\" defer></script>#&\n    <script src=\"$EXTRA_JS\"></script>#" "$SF/checkout/pay-card.html"
grep -qF "$EXTRA_JS" "$SF/checkout/pay-card.html" || die "the extra script was not added to the fixture"
run_hc --payment-pages
extra_script() {
  rc_is 0 && alerts_are 1 &&
    alert_has "health check failed: payment page /checkout/pay-card.html: /checkout/pay-card.html: extra script $EXTRA_JS" &&
    body_has "/checkout/pay-card.html: extra script $EXTRA_JS (not in the inventory)" &&
    body_has "inventory: $STRIPE_JS $CARD_JS" && body_has "page:      $STRIPE_JS $EXTRA_JS $CARD_JS" &&
    body_has "/checkout/pay-card.html: the HTML differs from the inventory" && state_is payment-page-checkout-pay-airline ok
}
check "an extra script on the card page: one alert naming the page and the extra script (and the changed HTML) [X-030 AC2]" \
  extra_script
check "the extra script's URL is never fetched [X-030 AC2]" not grep -qF skim "$STATE/requests.run.log"
restore_storefront
run_hc --payment-pages
check "the page restored: one recovery [X-030 AC1]" recovered "payment page /checkout/pay-card.html"

CSP_CHANGED="$(printf '%s' "$CSP_AIRLINE" | sed "s#script-src 'self';#script-src 'self' https://cdn.example.net;#")"
[ "$CSP_CHANGED" != "$CSP_AIRLINE" ] || die "the changed CSP of the fixture equals the original"
# shellcheck disable=SC2016 # $csp is jq's variable
write_headers --arg csp "$CSP_CHANGED" '.paths["/checkout/pay-airline.html"]["Content-Security-Policy"] = $csp'
run_hc --payment-pages
csp_changed() {
  rc_is 0 && alerts_are 1 &&
    alert_has "health check failed: payment page /checkout/pay-airline.html: /checkout/pay-airline.html: header Content-Security-Policy differs" &&
    body_has "inventory: $CSP_AIRLINE" && body_has "page:      $CSP_CHANGED" &&
    not body_has "/checkout/pay-airline: header" && not body_has "the HTML differs" &&
    state_is payment-page-checkout-pay-card ok
}
check "a CSP changed on /checkout/pay-airline.html only: one alert naming the page, the path and the header, nothing for its second path or the card page [X-030 AC2]" \
  csp_changed
write_headers
run_hc --payment-pages
check "the CSP restored: one recovery of the airline-card page [X-030 AC1]" recovered "payment page /checkout/pay-airline.html"

# shellcheck disable=SC2016 # jq's variable
write_headers '.paths["/checkout/pay-airline"]["Cross-Origin-Opener-Policy"] = null | .default.Server = "Caddy"'
run_hc --payment-pages
headers_per_path() {
  rc_is 0 && alerts_are 2 &&
    body_has "/checkout/pay-airline: header Cross-Origin-Opener-Policy is missing" &&
    not body_has "/checkout/pay-airline.html: header Cross-Origin-Opener-Policy" &&
    body_has "/checkout/pay-card.html: header Server must not be sent, found: Caddy"
}
check "headers are compared per path: COOP missing on /checkout/pay-airline only, and a Server header the inventory forbids [X-030 AC2]" \
  headers_per_path
write_headers
run_hc --payment-pages
check "both restored: two recoveries [X-030 AC1]" recoveries 2

: >"$STATE/storefront-silent"
run_hc --payment-pages
storefront_silent() {
  rc_is 0 && alerts_are 2 &&
    alerts_match 1 "health check failed: payment page /checkout/pay-airline.html: page /checkout/pay-airline.html cannot be fetched" &&
    alerts_match 1 "health check failed: payment page /checkout/pay-card.html: page /checkout/pay-card.html cannot be fetched" &&
    body_has "not fetched: an earlier request of this run got no HTTP answer from http://$HOST:8080" &&
    [ "$(grep -c '^storefront ' "$STATE/requests.run.log" || true)" -eq 1 ]
}
check "a storefront that gives no answer: one alert per payment page, and after the first request it is asked nothing more in that run (so a hung Caddy cannot hold the run past its time limit) [X-030 AC1]" \
  storefront_silent
rm -f "$STATE/storefront-silent"
run_hc --payment-pages
check "the storefront answering again: two recoveries [X-030 AC1]" recoveries 2

date -u -d yesterday +%F >"$HCSTATE/payment-pages.day"
run_hc
next_day() { quiet_run && fetched /checkout/pay-card.html && fetched /checkout/pay-airline.html; }
check "without --payment-pages the pages are checked again on the next UTC day [X-030 AC1]" next_day

# ---- 4. the units: readiness, masked and disabled units, a running deploy ------------------------------------------
step "4. unit readiness"
set_health 3101 close
set_health 4000 503 '{"status":"unavailable","checks":{"postgres":"down","redis":"ok"}}'
run_hc
units_alerted() {
  rc_is 0 && alerts_are 2 &&
    alerts_match 1 "health check failed: velexis-platform-worker readiness: velexis-platform-worker does not answer on $HOST:3101/health/ready" &&
    alerts_match 1 "health check failed: velexis-ota-api readiness: velexis-ota-api is not ready: /health/ready on $HOST:4000 answered 503" &&
    body_has '{"status":"unavailable","checks":{"postgres":"down","redis":"ok"}}'
}
check "a stopped unit (velexis-platform-worker, as in the VM check) and one that answers 503: one alert each, naming the unit [X-030 AC1]" \
  units_alerted
run_hc
check "still down on the next run: nothing [X-030 AC1]" quiet_run
set_health 3101 default
set_health 4000 default
run_hc
check "both back: one recovery each [X-030 AC1]" recoveries 2

echo masked >"$STATE/units/velexis-ota-admin"
echo disabled >"$STATE/units/velexis-portal"
rm -f "$STATE/units/velexis-platform-admin"
set_health 3002 close
set_health 3000 close
set_health 3001 close
run_hc
units_skipped() {
  quiet_run && out_has "skip ready-velexis-ota-admin: velexis-ota-admin is masked" &&
    out_has "skip ready-velexis-portal: velexis-portal is disabled" &&
    out_has "skip ready-velexis-platform-admin: velexis-platform-admin is not installed" &&
    not grep -qE '^health (3000|3001|3002) ' "$STATE/requests.run.log"
}
check "masked, disabled and missing units are not checked (no request, no alert, state kept) [X-030 AC1]" units_skipped
for unit in velexis-ota-admin velexis-portal velexis-platform-admin; do echo enabled >"$STATE/units/$unit"; done
set_health 3000 default
set_health 3001 default
set_health 3002 default

hold_deploy_lock() { # holds velexis-deploy's lock as deploy.sh does (flock on fd 9), until $STATE/unlock exists
  rm -f "$STATE/unlock" "$STATE/locked"
  (
    exec 9>"$ROOT/run/velexis-deploy.lock"
    flock 9
    : >"$STATE/locked"
    while [ ! -e "$STATE/unlock" ]; do sleep 0.05; done
  ) &
  LOCK_PID=$!
  for _ in $(seq 1 100); do [ ! -e "$STATE/locked" ] || return 0; sleep 0.05; done
  die "could not take the test's deploy lock"
}
release_deploy_lock() { : >"$STATE/unlock"; wait "$LOCK_PID" || true; LOCK_PID=""; }
hold_deploy_lock
set_health 4000 503 '{"status":"unavailable","checks":{"postgres":"ok","redis":"down"}}'
YESTERDAY="$(date -u -d yesterday +%F)"
echo "$YESTERDAY" >"$HCSTATE/payment-pages.day"
run_hc
during_deploy() {
  quiet_run && out_has "skip ready-velexis-ota-api: velexis-deploy is running" && state_is ready-velexis-ota-api ok &&
    not grep -q '^health ' "$STATE/requests.run.log"
}
check "while velexis-deploy holds its lock no unit is checked, so its restarts raise no alert (states kept) [X-030 AC1]" \
  during_deploy
pages_wait_for_deploy() {
  out_has "skip payment pages: velexis-deploy is running" && no_storefront_request &&
    [ "$(cat "$HCSTATE/payment-pages.day")" = "$YESTERDAY" ]
}
check "nor are the payment pages due today (the deploy switches the release they are compared with): no storefront request, the day stays open [X-030 AC1]" \
  pages_wait_for_deploy
release_deploy_lock
run_hc
after_deploy() {
  rc_is 0 && alerts_are 1 && alert_has "health check failed: velexis-ota-api readiness" &&
    fetched /checkout/pay-card.html && fetched /checkout/pay-airline.html &&
    [ "$(cat "$HCSTATE/payment-pages.day")" = "$(date -u +%F)" ]
}
check "the lock released (deploy.sh never waits for the health check: it only reads /proc/locks), the unit that stayed down alerts once and the payment pages are checked for the day [X-030 AC1]" \
  after_deploy
set_health 4000 default
run_hc
check "and recovers once [X-030 AC1]" recovered "velexis-ota-api readiness"

# ---- 5. the OTA worker's queues ---------------------------------------------------------------------------------------
step "5. failed and waiting jobs of the OTA worker"
set_health 4001 200 "$(queues_body 15 null 6 601)"
run_hc
jobs_alerted() {
  rc_is 0 && alerts_are 2 &&
    alerts_match 1 "health check failed: failed jobs of velexis-ota-worker: 21 jobs of velexis-ota-worker failed in the last hour (more than 20)" &&
    body_has "  ota-payments: 15 failed" && body_has "  ota-stripe-events: 6 failed" &&
    alerts_match 1 "health check failed: waiting jobs of velexis-ota-worker: a job of velexis-ota-worker has waited more than 10 minutes" &&
    body_has "  ota-stripe-events: the oldest of 1 waiting jobs has waited 601 s" && not body_has "ota-payments: the oldest"
}
check "21 failures in the hour over the queues and a job waiting 601 s: one alert each, naming the queues [X-030 AC1]" \
  jobs_alerted
set_health 4001 200 '{"status":"ok","checks":{"postgres":"ok","redis":"ok"}}'
run_hc
unknown_queues() {
  quiet_run && state_is failed-jobs-velexis-ota-worker fail && state_is queue-age-velexis-ota-worker fail &&
    out_has "skip failed-jobs-velexis-ota-worker, queue-age-velexis-ota-worker: its readiness lists no queues"
}
check "a readiness without queues is unknown: no recovery, both states stay fail [X-030 AC1]" unknown_queues
set_health 4001 200 "$(queues_body 14 600 6 null)"
run_hc
check "20 failures and 600 s are within the limits: one recovery each [X-030 AC1]" recoveries 2
set_health 4001 default

# ---- 6. Redis memory, backup age, TLS expiry -----------------------------------------------------------------------
step "6. Redis memory, backup age and TLS expiry"
echo "429496730 536870912" >"$STATE/redis-memory" # 80 %
set_marker_age $((27 * 3600))
make_cert api.ota.example.com 5
run_hc
three_alerts() {
  rc_is 0 && alerts_are 3 &&
    alerts_match 1 "health check failed: Redis memory: Redis uses 80 % of maxmemory (429496730 of 536870912 bytes; more than 70 %)" &&
    alerts_match 1 "health check failed: backup age: the last successful backup is 27 hours old (more than 26;" &&
    alerts_match 1 "health check failed: TLS certificate of api.ota.example.com: the certificate of api.ota.example.com expires within 14 days" &&
    state_is tls-admin.ota.example.com ok
}
check "Redis at 80 % of maxmemory, a backup 27 hours old and a certificate valid for 5 more days: one alert each [X-030 AC1]" \
  three_alerts
password_hidden() {
  grep -q 'auth=ok' "$STATE/redis-cli.log" && not grep -qF "$REDIS_PASSWORD" "$STATE/redis-cli.log" &&
    grep -qx 'argv=-h 127.0.0.1 -p 6379 --no-auth-warning INFO memory auth=ok' "$STATE/redis-cli.log"
}
check "redis-cli gets the password in REDISCLI_AUTH only, never on its command line [X-030]" password_hidden
run_hc
check "the next run sends nothing [X-030 AC1]" quiet_run
echo "100000000 536870912" >"$STATE/redis-memory"
set_marker_age 60
make_cert api.ota.example.com 90
run_hc
check "all three fixed: three recoveries [X-030 AC1]" recoveries 3
mv "$MARKER" "$MARKER.away"
run_hc
no_marker() { rc_is 0 && alerts_are 1 && alert_has "health check failed: backup age: no successful backup is recorded"; }
check "no backup marker at all: one alert [X-030 AC1]" no_marker
mv "$MARKER.away" "$MARKER"
run_hc
check "and one recovery [X-030 AC1]" recovered "backup age"
: >"$STATE/redis-hang"
run_hc # waits for redis-cli's time limit (10 s)
redis_silent() {
  rc_is 0 && alerts_are 1 &&
    alert_has "health check failed: Redis memory: Redis does not answer INFO memory on 127.0.0.1:6379 (within 10 s)" &&
    grep -qx 'stopped by SIGTERM' "$STATE/redis-cli.log" &&
    ok_ids backup-age tls-platform.example.com tls-api.ota.example.com
}
check "a Redis that never answers: redis-cli is stopped at its time limit, one alert, and the checks after it still run [X-030 AC1]" \
  redis_silent
rm -f "$STATE/redis-hang"
run_hc
check "Redis answering again: one recovery [X-030 AC1]" recovered "Redis memory"

# ---- 7. an alert that cannot be sent ------------------------------------------------------------------------------------
step "7. velexis-alert fails"
: >"$STATE/alert-fails"
set_df / "95 /"
run_hc
undelivered() {
  rc_is 1 && alerts_are 0 && state_is disk-root ok && grep -qF "health check failed: disk /" "$STATE/alerts-refused.log" &&
    out_has "the alert for disk-root (ok -> fail) could not be sent; the next run sends it again"
}
check "an alert velexis-alert cannot send: the run exits 1 and the state stays ok [X-030 AC1]" undelivered
rm -f "$STATE/alert-fails"
run_hc
check "the next run sends that alert once [X-030 AC1]" failed_once "disk /: / is 95 % full"
set_df / "40 /"
run_hc
check "and the recovery once [X-030 AC1]" recovered "disk /"

# ---- 8. the inventory: missing, unknown version, every page ---------------------------------------------------------------
step "8. the inventory"
mv "$SF/payment-page-inventory.json" "$PREFIX/inventory.away"
run_hc --payment-pages
no_inventory() {
  quiet_run && out_has "WARNING: payment pages: /srv/velexis/current/storefront/payment-page-inventory.json does not exist" &&
    no_storefront_request && state_is payment-page-checkout-pay-card ok && state_is payment-inventory ok
}
check "no inventory in the release: the payment page check is skipped with a warning, no alert, states kept [X-030 AC1]" \
  no_inventory
jq '.version = 2' "$PREFIX/inventory.away" >"$SF/payment-page-inventory.json"
run_hc --payment-pages
unknown_version() {
  rc_is 0 && alerts_are 1 &&
    alert_has "health check failed: payment page inventory: /srv/velexis/current/storefront/payment-page-inventory.json is not an inventory of format velexis-storefront-payment-page-inventory, version 1" &&
    no_storefront_request
}
check "an inventory of an unknown version: one alert, and no page is compared with it [X-030 AC1]" unknown_version
mv "$PREFIX/inventory.away" "$SF/payment-page-inventory.json"
run_hc --payment-pages
check "the inventory back: one recovery [X-030 AC1]" recovered "payment page inventory"
printf 'HEALTHCHECK_STOREFRONT_HOST=demo.ota.example.com\nHEALTHCHECK_PAGES=all\n' >"$ETC/healthcheck.env"
# shellcheck disable=SC2016 # jq's path
write_headers '.paths["/"] = {"Referrer-Policy": "unsafe-url"}'
run_hc --payment-pages
every_page() {
  rc_is 0 && alerts_are 1 &&
    alert_has "health check failed: storefront page /: /: header Referrer-Policy differs from the inventory" &&
    body_has "  page:      unsafe-url" && fetched / && fetched "$INDEX_JS" && ok_ids payment-page-checkout-pay-card
}
check "HEALTHCHECK_PAGES=all compares every page of the inventory: a header changed on / only alerts for /, naming it [X-030 AC2]" \
  every_page
write_headers
printf 'HEALTHCHECK_STOREFRONT_HOST=demo.ota.example.com\n' >"$ETC/healthcheck.env"
run_hc --payment-pages
check "back to the payment pages: the home page is no longer fetched, no alert [X-030 AC1]" all_of quiet_run home_not_fetched

# ---- over the whole run ---------------------------------------------------------------------------------------------
step "over the whole run"
run_hc --status
status_lists() { rc_is 0 && out_has "disk-root" && out_has "payment pages last checked on: $(date -u +%F)"; }
check "--status lists the checks and the day of the last payment page check [X-030]" status_lists
no_secret() {
  ! grep -rqF "$TOKEN" "$OUT" "$STATE/alerts" "$STATE/alerts.log" "$STATE/redis-cli.log" "$STATE/systemctl.log" \
    "$STATE/df.log" "$STATE/requests.log" "$HCSTATE" 2>/dev/null
}
check "no test secret (Redis password, edge secret) in any output, alert, log or state file [X-030]" no_secret
check "no systemctl or velexis-alert call but is-enabled and message [X-030]" test ! -s "$STATE/unexpected.log"

# ---- CASES-END ----------------------------------------------------------------------------------------------------
echo
if [ "$FAILED" -ne 0 ]; then
  echo "healthcheck.test.sh: FAILED"
  exit 1
fi
echo "healthcheck.test.sh: all checks passed"
