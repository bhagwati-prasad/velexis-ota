#!/usr/bin/env bash
# =====================================================================================================
# deploy.test.sh — tests deploy/scripts/deploy.sh (velexis-deploy) without root, systemd or a VM (task X-023).
#
#   bash deploy/scripts/test/deploy.test.sh
#
# Needs bash, Node 18 or newer (DEPLOY_TEST_NODE, else node on PATH; CI uses Node 22), curl, flock, setsid and GNU
# coreutils and findutils (Linux: Ubuntu 24.04 like the VM and the CI runner). No root, no systemd, no network
# beyond loopback. CI runs it in the "deploy-files" job of .github/workflows/ci.yml.
#
# deploy.sh runs exactly as it is, with the test overrides of its header:
#   VELEXIS_ROOT   a temporary folder laid out like a provisioned VM: /etc/velexis/*.env made from the deploy/env
#                  templates (a template with only comments gets no file, as on the VM), the provisioned Caddyfile
#                  and maintenance page, /srv/velexis/{incoming,releases}, /var/lib/velexis, /usr/local/sbin, ...
#   SYSTEMCTL      fake-systemctl.sh: starts and stops fake-app.mjs processes that answer /health/ready on each
#                  unit's port, healthy or not depending on the flag file FAKE_UNHEALTHY in their release
#   RUN_TRANSIENT  a stand-in for the transient systemd-run unit (bin/run-transient): runs the command in its folder
#                  with a clean environment made of the env file, as systemd's EnvironmentFile= does
#   HEALTH_HOST    a random 127.x.y.z address, so the app ports (3000-3002, 3100, 3101, 4000, 4001) never collide
#                  with anything listening on 127.0.0.1
# with a fake `caddy` (validate only) and `journalctl` first on PATH. Fake releases are folders like the ones
# pack-release.sh builds: RELEASE.json, SHA256SUMS of every file, a copy of this repository's deploy/ folder,
# migrations, reference data, the five app folders and a storefront, with a fake migration CLI
# (db/dist/cli/migrate.js) and a fake reference loader (reference-data/dist/cli/load.js) that record their
# arguments, folder and which DSN variables they got (never a value). A release can carry a marker line in
# velexis-ota-api.service and in the Caddyfile, so the test sees whose unit file is installed, whose was loaded by
# the last daemon-reload, which one each restart used, and whose Caddyfile is live.
#
# Cases (docs/mvp/plans/foundation-tasks.md, X-023 step 2); every check ends with [X-023 AC1]:
#    1. happy path: verified upload, root scripts, units and Caddyfile installed (daemon-reload, validate, reload
#       after the restarts), read-only release, migrations through the fake migrate.js (platform, reference, tenant
#       fan-out with the flags of migrator.env, each through RUN_TRANSIENT with migrator.env), the reference loader
#       with reference-loader.env only, restarts in order with health checks, history, --status;
#    2. a second deploy of the same sha changes nothing (no unit, Caddyfile, release or snapshot change);
#    3. a tampered file -> SHA256SUMS refusal, current unchanged, nothing changed; a file that SHA256SUMS does not
#       list is refused the same way;
#    4. a Node major mismatch -> refusal;
#    5. an env file without a variable that the release's template names -> refusal before anything changes, the
#       variable named in the message; a template with only comments (optional file) is ignored; with the
#       variable added (empty) the same upload deploys;
#    6. an unhealthy app -> automatic rollback to the previous release (its units and Caddyfile re-installed from
#       /var/lib/velexis/system/<sha>/ before the restart), exit 1, and the staged new Caddyfile never activated;
#    7. --rollback: the target's units and Caddyfile re-installed from its snapshot (not from the release folder,
#       whose copies the test changes first) before the restart, Caddy reloaded afterwards;
#    8. re-deploying a release already on the VM re-installs its snapshot (again not the release folder's copies);
#    9. a failing migration -> no switch, and the running release's units are re-installed from its snapshot;
#   10. a masked unit is skipped;
#   11. a Caddyfile that does not validate changes nothing (no unit, Caddyfile, root script, release or `current`),
#       and caddy's message reaches the log redacted;
#   12. pruning keeps 5 releases and their snapshots (and drops a snapshot without a release), never the active
#       one, even when the active release is the oldest, and never the release --rollback would switch to; these
#       deploys reach the VM root through a symbolic link (like /srv -> /data/srv), so the active release is found
#       by its sha, not by its path;
#   and over the whole run: no DSN or secret of the env files in any output, command line or log, no unit used
#   without a daemon-reload after its file changed, and no call that fake-systemctl.sh does not know.
#
# Settings (environment): DEPLOY_TEST_NODE, DEPLOY_TEST_TMPDIR (parent of the temporary folder; default TMPDIR or
# /tmp), DEPLOY_TEST_HOST (a fixed health host instead of a random 127.x.y.z one), DEPLOY_TEST_KEEP=1 (keep the
# temporary folder: the VM tree, every deploy.sh output in out/, the fake apps' logs in state/logs/).
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/../.." && pwd)" # the deploy/ folder of this checkout
DEPLOY_SH="$DEPLOY/scripts/deploy.sh"
FAKE_SYSTEMCTL="$HERE/fake-systemctl.sh"
NODE="${DEPLOY_TEST_NODE:-$(command -v node || true)}"
APP_PORTS=(3000 3001 3002 3100 3101 4000 4001)
APP_DIRS=(platform-backend ota-backend platform-frontend platform-admin ota-admin)
# deploy.sh's restart order (deployment-single-vm.md §4): workers, APIs, front ends.
UNIT_ORDER=(velexis-platform-worker velexis-ota-worker velexis-platform-api velexis-ota-api velexis-portal
  velexis-platform-admin velexis-ota-admin)
MARKED_UNIT=velexis-ota-api # the unit whose file carries a release's marker

FAILED=0
LOG_SHOWN=""
pass() { printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*"
  FAILED=1
  if [ -n "${DEPLOY_LOG:-}" ] && [ "$LOG_SHOWN" != "$DEPLOY_LOG" ]; then
    LOG_SHOWN="$DEPLOY_LOG"
    echo "     output of the last deploy.sh run ($(basename "$DEPLOY_LOG")):"
    sed -e "s#$PREFIX#<tmp>#g" -e 's/^/       /' "$DEPLOY_LOG"
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

for tool in curl flock setsid sha256sum cmp find stat readlink od awk; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done
if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  die "Node.js 18 or newer is required (set DEPLOY_TEST_NODE)"
fi
if [ ! -f "$DEPLOY_SH" ] || [ ! -x "$FAKE_SYSTEMCTL" ] || [ ! -f "$HERE/fake-app.mjs" ]; then
  die "run it from a checkout of the repository"
fi

PREFIX="$(mktemp -d "${DEPLOY_TEST_TMPDIR:-${TMPDIR:-/tmp}}/velexis-deploy-test.XXXXXX")"
PREFIX="$(cd "$PREFIX" && pwd -P)"
ROOT="$PREFIX/root"   # the VM
VM_ROOT="$ROOT"       # VELEXIS_ROOT of deploy.sh: the VM, from case 12 on through a symbolic link
STATE="$PREFIX/state" # FAKE_STATE of fake-systemctl.sh, the fake apps and the fake CLIs
FAKEBIN="$PREFIX/bin" # caddy, journalctl, run-transient and node, first on deploy.sh's PATH
BUILD="$PREFIX/build" # fake releases as the build job leaves them
OUT="$PREFIX/out"     # every output of deploy.sh
mkdir -p "$ROOT" "$STATE" "$FAKEBIN" "$BUILD" "$OUT"

cleanup() {
  local rc=$? unit
  for unit in "${UNIT_ORDER[@]}"; do
    env VELEXIS_ROOT="$ROOT" FAKE_STATE="$STATE" HEALTH_HOST="${HOST:-127.0.0.1}" "$FAKE_SYSTEMCTL" stop "$unit" \
      >/dev/null 2>&1 || true
  done
  if [ "${DEPLOY_TEST_KEEP:-0}" = 1 ]; then
    echo "DEPLOY_TEST_KEEP=1: kept $PREFIX"
  else
    chmod -R u+w "$PREFIX" 2>/dev/null || true
    rm -rf --one-file-system "$PREFIX"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- the VM as provision-vm.sh leaves it ----------------------------------------------------------------------
ETC="$ROOT/etc/velexis"
SRV="$ROOT/srv/velexis"
LIB="$ROOT/var/lib/velexis"
LOGS="$ROOT/var/log/velexis"
SBIN="$ROOT/usr/local/sbin"
UNITS="$ROOT/etc/systemd/system"
CADDYFILE="$ROOT/etc/caddy/Caddyfile"
mkdir -p "$ETC" "$ROOT/etc/caddy" "$UNITS" "$SRV/incoming" "$SRV/releases" "$SRV/maintenance" "$LIB" \
  "$ROOT/var/lib/velexis-migrate" "$LOGS" "$SBIN" "$ROOT/run"
cp "$DEPLOY/caddy/Caddyfile" "$CADDYFILE"
cp "$DEPLOY/caddy/maintenance/index.html" "$SRV/maintenance/index.html"
for tpl in "$DEPLOY"/env/*.env.example; do
  grep -qE '^[A-Z][A-Z0-9_]*=' "$tpl" || continue # only comments: an optional file that the VM does not have
  install -m 0600 "$tpl" "$ETC/$(basename "$tpl" .example)"
done
[ ! -e "$ETC/platform-worker.env" ] || die "deploy/env/platform-worker.env.example is expected to hold only comments"

set_env() { # file key value: replace or add one line (test values only)
  local f="$ETC/$1" tmp
  tmp="$(mktemp "$PREFIX/env.XXXXXX")"
  awk -v k="$2" -v v="$3" 'index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$f" >"$tmp"
  mv "$tmp" "$f"
  chmod 0600 "$f"
}
# Test values that must never leave the env files: a random token in each, so any leak is found by grep.
TOKEN="x023$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
set_env migrator.env DATABASE_MIGRATOR_URL "postgres://velexis_migrator:m-$TOKEN@127.0.0.1:9/velexis"
set_env migrator.env MIGRATE_TENANT_CONCURRENCY 2
set_env migrator.env MIGRATE_TENANT_MAX_FAILURE_RATIO 0.25
set_env reference-loader.env DATABASE_URL "postgres://velexis_platform_app:r-$TOKEN@127.0.0.1:9/velexis"
set_env caddy.env VELEXIS_EDGE_SECRET "edge-$TOKEN"

# ---- fakes ----------------------------------------------------------------------------------------------------
ln -s "$NODE" "$FAKEBIN/node"
cat >"$FAKEBIN/caddy" <<'SH'
#!/usr/bin/env bash
# deploy.test.sh's caddy: only `caddy validate --config <file> --adapter caddyfile`. A Caddyfile with the line
# "# deploy.test.sh marker: FAKE_INVALID" fails, with a message that quotes the edge secret, as a real parse error of
# a line with {$VELEXIS_EDGE_SECRET} can.
set -euo pipefail
[ "${1:-}" = validate ] || { echo "fake caddy: only validate" >&2; exit 2; }
shift
cfg=""
while [ $# -gt 0 ]; do case "$1" in --config) cfg="$2"; shift 2 ;; *) shift ;; esac; done
printf 'validate %s edge-secret=%s\n' "$cfg" "${VELEXIS_EDGE_SECRET:+set}" >>"$FAKE_STATE/caddy.log"
if grep -q '^# deploy.test.sh marker: FAKE_INVALID' "$cfg"; then
  echo "Error: adapting config using caddyfile: wrong argument count or unexpected line ending after '${VELEXIS_EDGE_SECRET:-}', at $cfg:1" >&2
  exit 1
fi
echo '{"level":"info","msg":"using config from file"}' >&2
echo 'Valid configuration'
SH
cat >"$FAKEBIN/journalctl" <<'SH'
#!/usr/bin/env bash
# deploy.test.sh's journalctl: `journalctl -u <unit> -n <lines> --no-pager` prints the fake app's log.
unit=""
lines=30
while [ $# -gt 0 ]; do case "$1" in -u) unit="$2"; shift 2 ;; -n) lines="$2"; shift 2 ;; *) shift ;; esac; done
tail -n "$lines" "$FAKE_STATE/logs/${unit%.service}.log" 2>/dev/null || true
SH
cat >"$FAKEBIN/run-transient" <<'SH'
#!/usr/bin/env bash
# deploy.test.sh's RUN_TRANSIENT: the transient unit of deploy.sh's run_transient (systemd-run -p DynamicUser=yes
# -p EnvironmentFile=<file> -p Environment=NODE_ENV=production -p WorkingDirectory=<dir> -- <command>). It runs the
# command in <dir> with a clean environment made of the env file and NODE_ENV, and returns its exit code. It logs its
# arguments to run-transient.log: the env file is named there, its values are never on any command line.
set -euo pipefail
if [ "${RUN_TRANSIENT_CLEAN:-}" != 1 ]; then
  exec env -i RUN_TRANSIENT_CLEAN=1 PATH="$PATH" FAKE_STATE="$FAKE_STATE" bash "$0" "$@"
fi
env_file="$1"
dir="$2"
shift 2
printf 'env=%s dir=%s argv=%s\n' "$env_file" "$dir" "$*" >>"$FAKE_STATE/run-transient.log"
[ -f "$env_file" ] || { echo "run-transient: $env_file does not exist" >&2; exit 1; }
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in [A-Za-z_]*=*) export "${line?}" ;; esac
done <"$env_file"
export NODE_ENV=production
unset RUN_TRANSIENT_CLEAN
cd "$dir"
exec "$@"
SH
chmod 0755 "$FAKEBIN/caddy" "$FAKEBIN/journalctl" "$FAKEBIN/run-transient"

# ---- the health host --------------------------------------------------------------------------------------------
ports_free() { # host -> 0 when every app port can be bound there
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
  ' "$1" "${APP_PORTS[@]}" 2>/dev/null
}
HOST=""
if [ -n "${DEPLOY_TEST_HOST:-}" ]; then
  HOST="$DEPLOY_TEST_HOST"
  ports_free "$HOST" || die "the app ports are not free on DEPLOY_TEST_HOST $HOST"
else
  for _ in $(seq 1 20); do
    candidate="127.$((RANDOM % 254 + 1)).$((RANDOM % 254 + 1)).$((RANDOM % 253 + 2))"
    if ports_free "$candidate"; then HOST="$candidate"; break; fi
  done
  [ -n "$HOST" ] || die "found no 127.x.y.z address with free app ports (set DEPLOY_TEST_HOST)"
fi
echo "VM root: $ROOT"
echo "health host: $HOST"

# ---- fake releases --------------------------------------------------------------------------------------------
sha_of() { printf 'x023-release-%s' "$1" | sha256sum | cut -c1-40; }
NOW="$(date +%s)"
SEQ=0
make_release() { # label [option ...] -> $BUILD/<sha>, built like pack-release.sh; sets BUILT to the sha
  local label="$1" sha dir opt node apps v mtime
  shift
  sha="$(sha_of "$label")"
  dir="$BUILD/$sha"
  SEQ=$((SEQ + 1))
  mtime=$((NOW - 3600 + SEQ * 10)) # build order; rsync -a keeps the build job's times
  node="$("$NODE" -p process.version)"
  rm -rf "$dir"
  mkdir -p "$dir/deploy"
  cp -a "$DEPLOY/." "$dir/deploy/"
  find "$dir/deploy" -name '*.env' -type f -delete
  mkdir -p "$dir/db/dist/cli" "$dir/reference-data/dist/cli" "$dir/reference-data/data" "$dir/storefront"
  printf '{ "name": "@velexis/db", "private": true }\n' >"$dir/db/package.json"
  printf '{ "name": "@velexis/reference-data", "private": true }\n' >"$dir/reference-data/package.json"
  cat >"$dir/db/dist/cli/migrate.js" <<'JS'
"use strict";
// Fake migration CLI of deploy/scripts/test/deploy.test.sh: records its arguments, folder and which DSN variables
// it got (never a value); fails for the set named in the release's FAKE_MIGRATE_FAIL; writes the fan-out report.
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const has = (name) => ((process.env[name] ?? "") !== "" ? "yes" : "no");
fs.appendFileSync(
  path.join(process.env.FAKE_STATE, "oneoff.log"),
  `migrate argv=${args.join(" ")} cwd=${process.cwd()} migrator-dsn=${has("DATABASE_MIGRATOR_URL")} ` +
    `platform-dsn=${has("DATABASE_URL")} node-env=${process.env.NODE_ENV ?? ""}\n`,
);
let fail = "";
try {
  fail = fs.readFileSync(path.join(process.cwd(), "..", "FAKE_MIGRATE_FAIL"), "utf8").trim();
} catch {
  fail = "";
}
if (args[0] === fail) {
  process.stderr.write(`migrate: fake failure of the ${fail} set\n`);
  process.exit(1);
}
const report = args.indexOf("--report");
if (args[0] === "tenants" && report >= 0) {
  fs.writeFileSync(args[report + 1], `${JSON.stringify({ target: "fake", total: 0, applied: [], failed: [] })}\n`);
}
process.stdout.write(`${JSON.stringify({ set: args[0], fake: true })}\n`);
JS
  cat >"$dir/reference-data/dist/cli/load.js" <<'JS'
"use strict";
// Fake reference data loader of deploy/scripts/test/deploy.test.sh: records its arguments, folder and DSN variables.
const fs = require("fs");
const path = require("path");
const has = (name) => ((process.env[name] ?? "") !== "" ? "yes" : "no");
fs.appendFileSync(
  path.join(process.env.FAKE_STATE, "oneoff.log"),
  `load argv=${process.argv.slice(2).join(" ")} cwd=${process.cwd()} migrator-dsn=${has("DATABASE_MIGRATOR_URL")} ` +
    `platform-dsn=${has("DATABASE_URL")} node-env=${process.env.NODE_ENV ?? ""}\n`,
);
JS
  for v in platform reference tenant; do
    mkdir -p "$dir/migrations/$v"
    printf -- '-- fake %s baseline of release %s\n' "$v" "$label" >"$dir/migrations/$v/0001_baseline.sql"
  done
  printf 'iata_code,name\nAAA,Fake airport\n' >"$dir/reference-data/data/airports.csv"
  for v in "${APP_DIRS[@]}"; do
    mkdir -p "$dir/$v/dist"
    printf '// %s of fake release %s (fake-systemctl.sh runs fake-app.mjs instead)\n' "$v" "$label" >"$dir/$v/dist/main.js"
  done
  printf '<!doctype html><title>%s</title>\n' "$label" >"$dir/storefront/index.html"
  for opt in "$@"; do
    case "$opt" in
      unit=*) printf '# deploy.test.sh marker: %s\n' "${opt#unit=}" >>"$dir/deploy/systemd/$MARKED_UNIT.service" ;;
      caddy=*) printf '# deploy.test.sh marker: %s\n' "${opt#caddy=}" >>"$dir/deploy/caddy/Caddyfile" ;;
      script=*) printf '# deploy.test.sh marker: %s\n' "${opt#script=}" >>"$dir/deploy/scripts/deploy.sh" ;;
      unhealthy) : >"$dir/FAKE_UNHEALTHY" ;;
      migrate-fail=*) printf '%s\n' "${opt#migrate-fail=}" >"$dir/FAKE_MIGRATE_FAIL" ;;
      node=*) node="${opt#node=}" ;;
      env-var=*) v="${opt#env-var=}"; printf '%s=\n' "${v#*:}" >>"$dir/deploy/env/${v%%:*}.env.example" ;;
      optional-template=*)
        printf '# Optional overrides; nothing is required.\n# X023_OPTIONAL=1\n' \
          >"$dir/deploy/env/${opt#optional-template=}.env.example" ;;
      oldest) mtime=$((NOW - 7200)) ;;
      *) die "make_release: unknown option $opt" ;;
    esac
  done
  apps="${APP_DIRS[*]} storefront"
  "$NODE" -e '
    const [sha, node, apps, out] = process.argv.slice(1);
    const manifest = { sha, ref: "deploy.test.sh", builtAt: new Date().toISOString(), node, apps: apps.split(" ") };
    require("fs").writeFileSync(out + "/RELEASE.json", JSON.stringify(manifest, null, 2) + "\n");
  ' "$sha" "$node" "$apps" "$dir"
  (cd "$dir" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$PREFIX/SHA256SUMS.tmp"
  mv "$PREFIX/SHA256SUMS.tmp" "$dir/SHA256SUMS"
  touch -d "@$mtime" "$dir"
  BUILT="$sha"
}
upload() { # sha: what the deploy job's rsync does
  rm -rf "${SRV:?}/incoming/$1"
  cp -a "$BUILD/$1" "$SRV/incoming/$1"
}

# ---- running deploy.sh ------------------------------------------------------------------------------------------
RUNS=0
lines_of() { if [ -f "$1" ]; then wc -l <"$1"; else echo 0; fi; }
since() { tail -n "+$(($2 + 1))" "$1" 2>/dev/null || true; } # file count -> lines appended after the first count
deploy() { # args -> DEPLOY_RC, DEPLOY_LOG; CALLS, ONEOFFS, TRANSIENTS, VALIDATES: what this run did
  local c0 o0 t0 v0
  RUNS=$((RUNS + 1))
  DEPLOY_LOG="$OUT/deploy-$RUNS.log"
  c0="$(lines_of "$STATE/systemctl.log")"
  o0="$(lines_of "$STATE/oneoff.log")"
  t0="$(lines_of "$STATE/run-transient.log")"
  v0="$(lines_of "$STATE/caddy.log")"
  DEPLOY_RC=0
  env VELEXIS_ROOT="$VM_ROOT" SYSTEMCTL="$FAKE_SYSTEMCTL" RUN_TRANSIENT="$FAKEBIN/run-transient" HEALTH_HOST="$HOST" \
    HEALTH_TIMEOUT=2 FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" bash "$DEPLOY_SH" "$@" \
    </dev/null >"$DEPLOY_LOG" 2>&1 || DEPLOY_RC=$?
  CALLS="$(since "$STATE/systemctl.log" "$c0")"
  ONEOFFS="$(since "$STATE/oneoff.log" "$o0")"
  TRANSIENTS="$(since "$STATE/run-transient.log" "$t0")"
  VALIDATES="$(since "$STATE/caddy.log" "$v0")"
  printf -- '--- velexis-deploy %s: exit %s (%s)\n' "$*" "$DEPLOY_RC" \
    "$(tail -n 1 "$DEPLOY_LOG" | sed -e 's/^\[[^]]*\] //' -e "s#$PREFIX#<tmp>#g" | cut -c1-150)"
}
systemctl_fake() { # what an operator would do with systemctl on the VM (mask, stop, ...)
  env VELEXIS_ROOT="$ROOT" FAKE_STATE="$STATE" HEALTH_HOST="$HOST" "$FAKE_SYSTEMCTL" "$@"
}

# ---- what the checks read -----------------------------------------------------------------------------------------
rc_is() { [ "$DEPLOY_RC" = "$1" ]; }
output_has() { grep -qF -- "$1" "$DEPLOY_LOG"; }
current_is() { [ "$(basename "$(readlink -e "$SRV/current" 2>/dev/null || echo none)")" = "$1" ]; }
marker_of() { sed -n 's/^# deploy.test.sh marker: //p' "$1" 2>/dev/null | tail -n 1; }
unit_marker_is() { [ "$(marker_of "$UNITS/$MARKED_UNIT.service")" = "$1" ]; }
loaded_marker_is() { [ "$(marker_of "$STATE/loaded/$MARKED_UNIT.service")" = "$1" ]; }
caddy_marker_is() { [ "$(marker_of "$CADDYFILE")" = "$1" ]; }
no_staged_caddyfile() { [ ! -e "$ROOT/etc/caddy/Caddyfile.next" ]; }
calls_matching() { printf '%s\n' "$CALLS" | grep -cE "$1" || true; }
no_call() { [ "$(calls_matching "$1")" = 0 ]; }
restart_order() { printf '%s\n' "$CALLS" | awk '$1 == "restart" { print $2 }' | paste -sd' ' -; }
restarted_all_in_order() { [ "$(restart_order)" = "${UNIT_ORDER[*]}" ]; }
restart_field() { # unit field -> the field (release, marker, pid) of the unit's last restart in this run
  printf '%s\n' "$CALLS" | awk -v u="$1" -v f="$2=" '$1 == "restart" && $2 == u {
    for (i = 3; i <= NF; i++) if (index($i, f) == 1) v = substr($i, length(f) + 1) } END { print v }'
}
every_restart_of() { # release -> every restart of this run started the unit in that release
  [ -n "$CALLS" ] && ! printf '%s\n' "$CALLS" | awk -v r="$1" '$1 == "restart" && $5 != "release=" r' | grep -q .
}
first_line_of() { printf '%s\n' "$CALLS" | grep -nE "$1" | head -n 1 | cut -d: -f1; }
last_line_of() { printf '%s\n' "$CALLS" | grep -nE "$1" | tail -n 1 | cut -d: -f1; }
reload_before_first_restart() { # daemon-reload comes before the first restart of this run
  local r s
  r="$(first_line_of '^daemon-reload')"
  s="$(first_line_of '^restart ')"
  [ -n "$r" ] && [ -n "$s" ] && [ "$r" -lt "$s" ]
}
caddy_reload_after_restarts() { # exactly one reload of Caddy, after the last restart, with the live Caddyfile
  local r s
  [ "$(calls_matching '^reload caddy')" = 1 ] || return 1
  r="$(last_line_of '^reload caddy')"
  s="$(last_line_of '^restart ')"
  [ -n "$s" ] && [ "$r" -gt "$s" ] &&
    printf '%s\n' "$CALLS" | grep -q "^reload caddy caddyfile=$(sha256sum "$CADDYFILE" | cut -c1-64)$"
}
serving() { # release -> every app port answers /health/ready 200 for that release
  local port body
  for port in "${APP_PORTS[@]}"; do
    body="$(curl -fsS --noproxy '*' --max-time 3 "http://$HOST:$port/health/ready" 2>/dev/null)" || return 1
    [[ "$body" == *"\"release\":\"$1\""* ]] || return 1
  done
}
all_active() {
  local unit
  for unit in "${UNIT_ORDER[@]}"; do [ "$(systemctl_fake is-active "$unit" || true)" = active ] || return 1; done
}
history_ends_with() { [ "$(tail -n 1 "$LIB/deploy-history" | cut -d' ' -f2-)" = "$1" ]; }
same_file() { cmp -s "$1" "$2"; }
fingerprint() { # paths -> every entry (path, type, inode, mtime, mode, owner, link target) and the files' SHA-256
  find "$@" \( -path "$ROOT/run" -o -path "$LOGS/deploy.log" \) -prune -o \
    -printf '%p %y %i %T@ %m %u:%g %l\n' 2>/dev/null | sort
  find "$@" \( -path "$ROOT/run" -o -path "$LOGS/deploy.log" \) -prune -o -type f -exec sha256sum {} + 2>/dev/null |
    sort -k 2
}
same_fingerprint() { [ "$1" = "$2" ] || { diff <(printf '%s\n' "$1") <(printf '%s\n' "$2") | sed -e "s#$PREFIX#<tmp>#g" -e 's/^/     /' | head -n 20; return 1; }; }
nothing_changed() { same_fingerprint "$FP_BEFORE" "$(fingerprint "$ROOT")"; }
release_read_only() { # sha: nobody can write, only the owner and group read (o=x on the folder), storefront o+r
  local rel="$SRV/releases/$1"
  [ "$(stat -c '%U:%G %a' "$rel")" = "$(id -un):$(id -gn) 551" ] || return 1
  [ -z "$(find "$rel" ! -type l -perm /222 | head -n 1)" ] || return 1
  [ -z "$(find "$rel" ! -type l ! -user "$(id -un)" | head -n 1)" ] || return 1
  [ -z "$(find "$rel" -mindepth 1 ! -type l ! -path "$rel/storefront" ! -path "$rel/storefront/*" -perm /007 | head -n 1)" ] ||
    return 1
  [ "$(stat -c %a "$rel/RELEASE.json")" = 440 ] && [ "$(stat -c %a "$rel/storefront/index.html")" = 444 ]
}
units_of_release_installed() { # sha: the installed unit files are those of the release's deploy/systemd
  local f src="$SRV/releases/$1/deploy/systemd"
  for f in "$src"/*.service "$src"/*.timer "$src/caddy.service.d/velexis.conf"; do
    same_file "$f" "$UNITS/${f#"$src"/}" || return 1
  done
}
snapshot_of_release() { # sha: /var/lib/velexis/system/<sha> holds the release's units, Caddyfile and maintenance page
  local s="$LIB/system/$1" r="$SRV/releases/$1/deploy"
  same_file "$s/systemd/$MARKED_UNIT.service" "$r/systemd/$MARKED_UNIT.service" &&
    same_file "$s/Caddyfile" "$r/caddy/Caddyfile" && same_file "$s/maintenance/index.html" "$r/caddy/maintenance/index.html"
}
root_scripts_of_release() { # sha: the root-owned scripts are the release's copies, mode 0755
  local r="$SRV/releases/$1/deploy/scripts" pair
  for pair in deploy:velexis-deploy backup:velexis-backup restore:velexis-restore alert:velexis-alert run-as:velexis-run; do
    same_file "$r/${pair%%:*}.sh" "$SBIN/${pair#*:}" && [ "$(stat -c %a "$SBIN/${pair#*:}")" = 755 ] || return 1
  done
}
# A release folder's own copies of its unit file and Caddyfile, which root must never install from: on the VM no one
# can change them, but the test's user owns them, so it can mark them and see that rollbacks use the snapshot.
COPIES_OF_RELEASE=("deploy/systemd/$MARKED_UNIT.service" deploy/caddy/Caddyfile)
tamper_release_copies() { # sha: the marker "release-folder" in those copies; the originals are kept for the restore
  local rel="$SRV/releases/$1" f
  mkdir -p "$PREFIX/originals/$1"
  for f in "${COPIES_OF_RELEASE[@]}"; do
    cp "$rel/$f" "$PREFIX/originals/$1/${f##*/}"
    chmod u+w "$rel/$f"
    printf '# deploy.test.sh marker: release-folder\n' >>"$rel/$f"
    chmod u-w "$rel/$f"
  done
}
restore_release_copies() { # sha
  local rel="$SRV/releases/$1" f
  for f in "${COPIES_OF_RELEASE[@]}"; do
    chmod u+w "$rel/$f"
    cp "$PREFIX/originals/$1/${f##*/}" "$rel/$f"
    chmod u-w "$rel/$f"
  done
}
from_snapshot() { # sha marker: the installed and loaded unit file and the live Caddyfile are the snapshot's
  unit_marker_is "$2" && loaded_marker_is "$2" && caddy_marker_is "$2" &&
    same_file "$LIB/system/$1/systemd/$MARKED_UNIT.service" "$UNITS/$MARKED_UNIT.service" &&
    same_file "$LIB/system/$1/Caddyfile" "$CADDYFILE"
}
oneoffs_are() { [ "$ONEOFFS" = "$1" ] || { printf '%s\n' "$ONEOFFS" | sed -e "s#$PREFIX#<tmp>#g" -e 's/^/     got: /'; return 1; }; }
releases_on_vm() { find "$SRV/releases" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | paste -sd' ' -; }
snapshots_on_vm() { find "$LIB/system" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | paste -sd' ' -; }
sorted() { printf '%s\n' "$@" | sort | paste -sd' ' -; }

# ---- 0. usage ---------------------------------------------------------------------------------------------------
step "0. velexis-deploy --status, usage and argument validation before any release"
deploy --status
status_none() { rc_is 0 && output_has "current: none"; }
check "--status without a release exits 0 and shows current: none [X-023 AC1]" status_none
deploy
usage_shown() { rc_is 1 && output_has "usage: velexis-deploy"; }
check "no argument: usage, exit 1 [X-023 AC1]" usage_shown
deploy '../etc'
id_refused() { rc_is 1 && output_has "invalid release id"; }
check "a release id that is not a hex sha is refused [X-023 AC1]" id_refused
deploy "$(sha_of nothing)"
no_upload_refused() { rc_is 1 && output_has "nothing uploaded at"; }
check "a sha without an upload is refused [X-023 AC1]" no_upload_refused

# ---- 1. happy path ----------------------------------------------------------------------------------------------
step "1. Happy path: release r1"
make_release r1 unit=r1 caddy=r1
R1="$BUILT"
REL1="$SRV/releases/$R1"
upload "$R1"
deploy "$R1"
r1_done() { rc_is 0 && output_has "deploy $R1 done"; }
r1_moved() { [ ! -e "$SRV/incoming/$R1" ] && [ -d "$REL1" ]; }
r1_loaded() { reload_before_first_restart && unit_marker_is r1 && loaded_marker_is r1; }
r1_enabled_in_order() { restarted_all_in_order && [ "$(calls_matching '^enable ')" = 7 ]; }
r1_serving() { every_restart_of "$R1" && all_active && serving "$R1"; }
r1_validated() { [ "$VALIDATES" = "validate $ROOT/etc/caddy/Caddyfile.next edge-secret=set" ]; }
r1_caddy_live() { caddy_marker_is r1 && no_staged_caddyfile && caddy_reload_after_restarts; }
r1_transients() {
  [ "$(printf '%s\n' "$TRANSIENTS" | cut -d' ' -f1 | paste -sd' ' -)" = \
    "env=$ETC/migrator.env env=$ETC/migrator.env env=$ETC/migrator.env env=$ETC/reference-loader.env" ]
}
r1_report_kept() {
  [ "$(stat -c %a "$LIB/migrate-$R1.json")" = 600 ] && [ "$(stat -c %a "$LOGS/migrate-$R1.json")" = 600 ] &&
    [ ! -e "$ROOT/var/lib/velexis-migrate/migrate-$R1.json" ]
}
r1_recorded() { [ -s "$LIB/reference-data.sha256" ] && history_ends_with "$R1"; }
check "deploy of r1 exits 0 and logs 'deploy <sha> done' [X-023 AC1]" r1_done
check "current points at releases/r1 [X-023 AC1]" current_is "$R1"
check "the upload moved from incoming/ to releases/ [X-023 AC1]" r1_moved
check "the release is read-only: the deploy owner and group read it, others only cross it, storefront world-readable [X-023 AC1]" \
  release_read_only "$R1"
check "the root-owned scripts (velexis-deploy, -backup, -restore, -alert, -run) are the release's copies, 0755 [X-023 AC1]" \
  root_scripts_of_release "$R1"
check "the snapshot /var/lib/velexis/system/r1 holds the release's units, Caddyfile and maintenance page [X-023 AC1]" \
  snapshot_of_release "$R1"
check "the installed unit files and the Caddy drop-in are the release's [X-023 AC1]" units_of_release_installed "$R1"
check "daemon-reload ran before the first restart, and the units loaded are r1's [X-023 AC1]" r1_loaded
check "the seven units were enabled and restarted in order: workers, APIs, front ends [X-023 AC1]" r1_enabled_in_order
check "every restart started r1, and every unit answers /health/ready for r1 [X-023 AC1]" r1_serving
check "the new Caddyfile was validated as Caddyfile.next with caddy.env loaded [X-023 AC1]" r1_validated
check "the Caddyfile is r1's, nothing stays staged, and Caddy was reloaded once, after the restarts [X-023 AC1]" r1_caddy_live
check "the maintenance page is the release's [X-023 AC1]" \
  same_file "$REL1/deploy/caddy/maintenance/index.html" "$SRV/maintenance/index.html"
check "migrations ran through the fake migrate.js: platform, reference, the tenant fan-out with migrator.env's flags, then the reference data loader [X-023 AC1]" \
  oneoffs_are "migrate argv=platform --dir $REL1/migrations/platform cwd=$REL1/db migrator-dsn=yes platform-dsn=no node-env=production
migrate argv=reference --dir $REL1/migrations/reference cwd=$REL1/db migrator-dsn=yes platform-dsn=no node-env=production
migrate argv=tenants --dir $REL1/migrations/tenant --concurrency 2 --max-failure-ratio 0.25 --report $ROOT/var/lib/velexis-migrate/migrate-$R1.json cwd=$REL1/db migrator-dsn=yes platform-dsn=no node-env=production
load argv=--data data cwd=$REL1/reference-data migrator-dsn=no platform-dsn=yes node-env=production"
check "each one-off ran through RUN_TRANSIENT with exactly its own env file (migrator.env, reference-loader.env) [X-023 AC1]" \
  r1_transients
check "the fan-out report is kept root-only in /var/lib/velexis and /var/log/velexis and leaves the state folder [X-023 AC1]" \
  r1_report_kept
check "the reference data checksum is recorded and the history names r1 [X-023 AC1]" r1_recorded
deploy --status
status_r1() { rc_is 0 && output_has "current: $REL1" && [ "$(grep -c ' active$' "$DEPLOY_LOG")" = 7 ]; }
check "--status shows current releases/r1 and seven active units [X-023 AC1]" status_r1

# ---- 2. the same sha again -------------------------------------------------------------------------------------------
step "2. A second deploy of the same sha (deploy.yml uploads it again)"
upload "$R1"
stable_state() {
  fingerprint "$SRV/releases" "$SRV/current" "$SRV/maintenance" "$UNITS" "$ROOT/etc/caddy" "$SBIN" "$LIB/system" \
    "$LIB/reference-data.sha256"
}
FP_STABLE="$(stable_state)"
deploy "$R1"
again_ok() { rc_is 0 && current_is "$R1"; }
again_unchanged() { same_fingerprint "$FP_STABLE" "$(stable_state)"; }
again_quiet() {
  no_call '^daemon-reload' && no_call '^reload ' && ! printf '%s\n' "$ONEOFFS" | grep -q '^load ' &&
    [ ! -e "$SRV/incoming/$R1" ]
}
again_serving() { restarted_all_in_order && serving "$R1"; }
check "it exits 0 and current still points at r1 [X-023 AC1]" again_ok
check "it changes nothing: release, current, snapshot, units, Caddyfile, maintenance page, root scripts and reference data checksum are the same entries [X-023 AC1]" \
  again_unchanged
check "no daemon-reload, no Caddy reload, the reference data is not loaded again, the unused upload is removed [X-023 AC1]" \
  again_quiet
check "the units restart on r1 and stay healthy [X-023 AC1]" again_serving

# ---- 3. tampered upload ------------------------------------------------------------------------------------------------
step "3. A tampered upload, and an upload with a file that SHA256SUMS does not list"
make_release r2 unit=r2 caddy=r2
R2="$BUILT"
upload "$R2"
printf 'ExecStartPre=/bin/true\n' >>"$SRV/incoming/$R2/deploy/systemd/$MARKED_UNIT.service"
FP_BEFORE="$(fingerprint "$ROOT")"
deploy "$R2"
tampered_refused() { rc_is 1 && output_has "checksum verification failed for $SRV/incoming/$R2"; }
r1_untouched() { current_is "$R1" && nothing_changed; }
nothing_ran() { [ -z "$CALLS" ] && [ -z "$ONEOFFS" ]; }
check "a changed file: SHA256SUMS refusal, exit 1 [X-023 AC1]" tampered_refused
check "current is unchanged and nothing else changed (no snapshot, unit, Caddyfile or script) [X-023 AC1]" r1_untouched
check "no systemctl call and no migration [X-023 AC1]" nothing_ran
upload "$R2"
cp "$SRV/incoming/$R2/deploy/systemd/$MARKED_UNIT.service" "$SRV/incoming/$R2/deploy/systemd/velexis-extra.service"
FP_BEFORE="$(fingerprint "$ROOT")"
deploy "$R2"
unlisted_refused() { rc_is 1 && output_has "SHA256SUMS does not list: ./deploy/systemd/velexis-extra.service"; }
check "a file that SHA256SUMS does not list: refusal naming it, exit 1 [X-023 AC1]" unlisted_refused
check "current is unchanged and nothing changed [X-023 AC1]" r1_untouched
check "no systemctl call and no migration [X-023 AC1]" nothing_ran
rm -rf "${SRV:?}/incoming/$R2"

# ---- 4. Node major --------------------------------------------------------------------------------------------------------
step "4. A release built with another Node major"
make_release r3 node=v18.20.4
R3="$BUILT"
upload "$R3"
FP_BEFORE="$(fingerprint "$ROOT")"
deploy "$R3"
VM_NODE="$("$NODE" --version)"
node_refused() { rc_is 1 && output_has "release built with Node v18, VM runs $VM_NODE"; }
check "refused: 'release built with Node v18, VM runs $VM_NODE', exit 1 [X-023 AC1]" node_refused
check "current is unchanged and nothing changed [X-023 AC1]" r1_untouched
check "no systemctl call and no migration [X-023 AC1]" nothing_ran
rm -rf "${SRV:?}/incoming/$R3"

# ---- 5. env drift ---------------------------------------------------------------------------------------------------------
step "5. An env file without a variable of the release's templates"
make_release r4 unit=r4 caddy=r4 env-var=ota-backend:X023_NEW_SETTING optional-template=x023-optional
R4="$BUILT"
REL4="$SRV/releases/$R4"
upload "$R4"
FP_BEFORE="$(fingerprint "$ROOT")"
deploy "$R4"
drift_refused() {
  rc_is 1 && output_has "env files lack variables of this release's templates: ota-backend.env:X023_NEW_SETTING." &&
    output_has "Nothing was changed."
}
optional_ignored() { not output_has "platform-worker.env" && not output_has "x023-optional"; }
upload_waits() { [ -d "$SRV/incoming/$R4" ]; }
check "refused before anything changes, naming ota-backend.env:X023_NEW_SETTING, exit 1 [X-023 AC1]" drift_refused
check "templates with only comments (platform-worker, x023-optional) are ignored: the message names nothing else [X-023 AC1]" \
  optional_ignored
check "current is unchanged and nothing changed [X-023 AC1]" r1_untouched
check "no systemctl call and no migration; the upload waits in incoming/ [X-023 AC1]" all_of nothing_ran upload_waits
printf 'X023_NEW_SETTING=\n' >>"$ETC/ota-backend.env"
deploy "$R4"
r4_live() {
  rc_is 0 && current_is "$R4" && unit_marker_is r4 && loaded_marker_is r4 && caddy_marker_is r4 && serving "$R4"
}
no_optional_files() { [ ! -e "$ETC/platform-worker.env" ] && [ ! -e "$ETC/x023-optional.env" ]; }
check "with the variable added (empty value), the same upload deploys [X-023 AC1]" r4_live
check "there is still no platform-worker.env nor x023-optional.env on the VM [X-023 AC1]" no_optional_files

# ---- 6. unhealthy release -------------------------------------------------------------------------------------------------
step "6. An unhealthy release: automatic rollback to r4"
make_release r5 unit=r5 caddy=r5 unhealthy
R5="$BUILT"
upload "$R5"
deploy "$R5"
r5_rolled_back() { rc_is 1 && output_has "deploy of $R5 failed health checks; rolled back to $R4"; }
r5_restarts() {
  local restarts
  restarts="$(printf '%s\n' "$CALLS" | awk '$1 == "restart" { print $2, $5 }')"
  [ "$(printf '%s\n' "$restarts" | head -n 1)" = "velexis-platform-worker release=$R5" ] &&
    [ "$(printf '%s\n' "$restarts" | tail -n +2 | awk '{ print $1 }' | paste -sd' ' -)" = "${UNIT_ORDER[*]}" ] &&
    ! printf '%s\n' "$restarts" | tail -n +2 | grep -qv " release=$R4$" &&
    output_has "velexis-platform-worker is not healthy"
}
r4_back() { current_is "$R4" && all_active && serving "$R4"; }
r4_units_back() {
  unit_marker_is r4 && loaded_marker_is r4 && [ "$(restart_field "$MARKED_UNIT" marker)" = r4 ] &&
    [ "$(calls_matching '^daemon-reload')" = 2 ] &&
    [ "$(last_line_of '^daemon-reload')" -lt "$(first_line_of "^restart velexis-platform-worker .*release=$R4")" ]
}
r5_caddyfile_never_live() {
  [ "$VALIDATES" = "validate $ROOT/etc/caddy/Caddyfile.next edge-secret=set" ] && caddy_marker_is r4 &&
    no_call '^reload ' && no_staged_caddyfile
}
r5_not_recorded() { history_ends_with "$R4 rollback" && ! grep -q " $R5" "$LIB/deploy-history"; }
check "exit 1: 'deploy of r5 failed health checks; rolled back to r4' [X-023 AC1]" r5_rolled_back
check "the first unit started on r5 and failed its health check, then every unit restarted on r4 [X-023 AC1]" r5_restarts
check "current points at r4 again and every unit answers for r4 [X-023 AC1]" r4_back
check "r4's unit file is back from /var/lib/velexis/system/r4 and loaded (daemon-reload) before the rollback restarts [X-023 AC1]" \
  r4_units_back
check "r5's Caddyfile was staged and validated, but never activated: r4's stays live, no Caddy reload, nothing staged [X-023 AC1]" \
  r5_caddyfile_never_live
check "the history records the rollback, never r5 [X-023 AC1]" r5_not_recorded

# ---- 7. --rollback --------------------------------------------------------------------------------------------------------
step "7. velexis-deploy --rollback (from r4 to the previous release, r1)"
tamper_release_copies "$R1"
deploy --rollback
check "r1's unit file and Caddyfile come from /var/lib/velexis/system/r1, not from the release folder [X-023 AC1]" \
  from_snapshot "$R1" r1
restore_release_copies "$R1"
rollback_r1() { rc_is 0 && output_has "ROLLBACK to $R1" && current_is "$R1" && all_active && serving "$R1"; }
r1_units_back() {
  units_of_release_installed "$R1" && unit_marker_is r1 && loaded_marker_is r1 && reload_before_first_restart &&
    [ "$(restart_field "$MARKED_UNIT" marker)" = r1 ] && restarted_all_in_order
}
r1_caddyfile_back() {
  caddy_marker_is r1 && no_staged_caddyfile && caddy_reload_after_restarts &&
    [ "$(printf '%s\n' "$VALIDATES" | wc -l)" = 1 ]
}
check "exit 0, current points at r1 and every unit answers for r1 [X-023 AC1]" rollback_r1
check "r1's unit files are re-installed from its snapshot and loaded before the restarts [X-023 AC1]" r1_units_back
check "r1's Caddyfile is validated and goes live after the restarts, with one Caddy reload [X-023 AC1]" r1_caddyfile_back
check "the history records the rollback [X-023 AC1]" history_ends_with "$R1 rollback"

# ---- 8. re-deploy a release on the VM -------------------------------------------------------------------------------------
step "8. Re-deploying r4, which is already on the VM"
upload "$R4"
tamper_release_copies "$R4"
FP_R4="$(fingerprint "$REL4" "$LIB/system/$R4")"
deploy "$R4"
r4_from_snapshot() {
  rc_is 0 && output_has "release $R4 is already on the VM: units and Caddyfile from its snapshot" && current_is "$R4"
}
r4_units_again() {
  units_of_release_installed "$R4" && unit_marker_is r4 && loaded_marker_is r4 && reload_before_first_restart &&
    [ "$(restart_field "$MARKED_UNIT" marker)" = r4 ] && serving "$R4"
}
r4_caddyfile_again() { caddy_marker_is r4 && no_staged_caddyfile && caddy_reload_after_restarts; }
r4_untouched() { same_fingerprint "$FP_R4" "$(fingerprint "$REL4" "$LIB/system/$R4")" && [ ! -e "$SRV/incoming/$R4" ]; }
check "exit 0 from r4's snapshot ('already on the VM'), current points at r4 [X-023 AC1]" r4_from_snapshot
check "r4's unit file and Caddyfile come from /var/lib/velexis/system/r4, not from the release folder [X-023 AC1]" \
  from_snapshot "$R4" r4
check "the release and its snapshot are untouched, and the unused upload is removed [X-023 AC1]" r4_untouched
restore_release_copies "$R4"
check "r4's units are re-installed from its snapshot and loaded before the restarts [X-023 AC1]" r4_units_again
check "r4's Caddyfile is live again (one reload after the restarts) [X-023 AC1]" r4_caddyfile_again

# ---- 9. failing migration -------------------------------------------------------------------------------------------------
step "9. A failing migration (r6): no switch, r4's units re-installed"
make_release r6 unit=r6 caddy=r6 migrate-fail=reference
R6="$BUILT"
upload "$R6"
app_pids() { local u; for u in "${UNIT_ORDER[@]}"; do cat "$STATE/run/$u.pid"; done | paste -sd' ' -; }
PIDS_BEFORE="$(app_pids)"
deploy "$R6"
r6_failed() { rc_is 1 && output_has "migrations failed; the previous release keeps running"; }
r6_oneoffs() { [ "$(printf '%s\n' "$ONEOFFS" | cut -d' ' -f1-2 | paste -sd' ' -)" = "migrate argv=platform migrate argv=reference" ]; }
r6_no_switch() { current_is "$R4" && no_call '^(restart|enable) ' && [ "$(app_pids)" = "$PIDS_BEFORE" ] && serving "$R4"; }
r6_units_restored() {
  [ "$(calls_matching '^daemon-reload')" = 2 ] && output_has "re-install the units and Caddyfile of the running release $R4" &&
    units_of_release_installed "$R4" && unit_marker_is r4 && loaded_marker_is r4
}
r6_caddyfile_dropped() { caddy_marker_is r4 && no_staged_caddyfile && no_call '^reload '; }
check "exit 1: 'migrations failed; the previous release keeps running' [X-023 AC1]" r6_failed
check "platform ran, reference failed, the fan-out never started [X-023 AC1]" r6_oneoffs
check "no switch: current is r4, no unit restarted, the same processes answer for r4 [X-023 AC1]" r6_no_switch
check "r6's units were installed, then r4's re-installed from its snapshot and reloaded [X-023 AC1]" r6_units_restored
check "r4's Caddyfile stays live and r6's staged one is gone, without a Caddy reload [X-023 AC1]" r6_caddyfile_dropped
check "r6 stays on the VM, read-only (its expand-only migrations may have run in part) [X-023 AC1]" release_read_only "$R6"

# ---- 10. masked unit ------------------------------------------------------------------------------------------------------
step "10. A masked unit (velexis-platform-worker) is skipped"
systemctl_fake stop velexis-platform-worker
systemctl_fake mask velexis-platform-worker
make_release r7
R7="$BUILT"
upload "$R7"
deploy "$R7"
masked_skipped() { rc_is 0 && output_has "skip velexis-platform-worker (masked)" && current_is "$R7"; }
masked_untouched() {
  no_call '^(enable|restart) velexis-platform-worker' && [ "$(restart_order)" = "${UNIT_ORDER[*]:1}" ] &&
    [ "$(systemctl_fake is-active velexis-platform-worker || true)" = inactive ]
}
check "exit 0 and 'skip velexis-platform-worker (masked)' [X-023 AC1]" masked_skipped
check "the masked unit is neither enabled nor restarted and stays stopped; the six others restart in order [X-023 AC1]" \
  masked_untouched
systemctl_fake unmask velexis-platform-worker

# ---- 11. Caddyfile that does not validate ---------------------------------------------------------------------------------
step "11. A Caddyfile that does not validate"
make_release bad caddy=FAKE_INVALID unit=bad script=bad
RBAD="$BUILT"
upload "$RBAD"
live_state() { fingerprint "$UNITS" "$CADDYFILE" "$SBIN" "$SRV/maintenance" "$SRV/releases" "$SRV/current"; }
FP_BEFORE="$(live_state)"
deploy "$RBAD"
bad_refused() { rc_is 1 && output_has "does not validate; nothing was activated"; }
bad_changed_nothing() {
  same_fingerprint "$FP_BEFORE" "$(live_state)" && no_staged_caddyfile && [ -z "$CALLS" ] && [ -d "$SRV/incoming/$RBAD" ] &&
    not output_has "velexis-deploy updated"
}
bad_redacted() {
  output_has "caddy validate failed: Error: adapting config using caddyfile" && output_has "<redacted>" &&
    ! grep -qF "$TOKEN" "$DEPLOY_LOG"
}
check "exit 1: 'does not validate; nothing was activated' [X-023 AC1]" bad_refused
check "units, the live Caddyfile, root scripts, maintenance page, releases and current are unchanged, nothing is staged or restarted [X-023 AC1]" \
  bad_changed_nothing
check "caddy's message reaches the log with the edge secret redacted [X-023 AC1]" bad_redacted
rm -rf "${SRV:?}/incoming/$RBAD"

# ---- 12. pruning ----------------------------------------------------------------------------------------------------------
step "12. Pruning: five releases and their snapshots, never the active one nor the --rollback target"
# From here on deploy.sh reaches the VM through a symbolic link, as through /srv -> /data/srv on a VM: `current` then
# resolves to another path than the one `find` lists, so only a comparison by sha keeps the active release.
ln -s "$(basename "$ROOT")" "$PREFIX/vm-link"
VM_ROOT="$PREFIX/vm-link"
make_release r8
R8="$BUILT"
upload "$R8"
five_on_vm() { [ "$(releases_on_vm)" = "$(sorted "$R1" "$R4" "$R5" "$R6" "$R7")" ] && [ -d "$LIB/system/$RBAD" ]; }
check "before r8: r1, r4, r5, r6 and r7 are on the VM, and the refused release left an orphan snapshot [X-023 AC1]" five_on_vm
deploy "$R8"
r1_pruned() { rc_is 0 && output_has "prune $R1" && [ "$(releases_on_vm)" = "$(sorted "$R4" "$R5" "$R6" "$R7" "$R8")" ]; }
snapshots_follow() { [ "$(snapshots_on_vm)" = "$(releases_on_vm)" ]; }
orphan_pruned() { snapshots_follow && output_has "prune the snapshot $RBAD (no release)"; }
check "deploying r8 (six releases) prunes the oldest, r1, with its snapshot [X-023 AC1]" r1_pruned
check "the snapshots are exactly those of the five releases (the orphan one is pruned too) [X-023 AC1]" orphan_pruned
make_release r9 oldest
R9="$BUILT"
upload "$R9"
deploy "$R9"
active_kept() {
  rc_is 0 && current_is "$R9" && [ "$(releases_on_vm)" = "$(sorted "$R4" "$R5" "$R6" "$R7" "$R8" "$R9")" ] &&
    snapshots_follow && not output_has "prune $R9"
}
check "an active release older than the five newest (r9, built first) is never pruned, also through a symbolic link: six stay [X-023 AC1]" \
  active_kept
make_release r10
R10="$BUILT"
upload "$R10"
deploy "$R10"
rollback_target_kept() {
  rc_is 0 && current_is "$R10" && [ "$(releases_on_vm)" = "$(sorted "$R5" "$R6" "$R7" "$R8" "$R9" "$R10")" ] &&
    snapshots_follow && output_has "prune $R4" && not output_has "prune $R9"
}
check "the next deploy (r10) prunes r4 but keeps r9, the release --rollback would switch to, with its snapshot [X-023 AC1]" \
  rollback_target_kept
make_release r11
R11="$BUILT"
upload "$R11"
deploy "$R11"
back_to_five() {
  rc_is 0 && current_is "$R11" && [ "$(releases_on_vm)" = "$(sorted "$R6" "$R7" "$R8" "$R10" "$R11")" ] && snapshots_follow
}
check "the deploy after that (r11) prunes back to five: r5 and r9, no longer the --rollback target, go with their snapshots [X-023 AC1]" \
  back_to_five
deploy --status
status_r11() { rc_is 0 && output_has "current: $SRV/releases/$R11" && [ "$(grep -c ' active$' "$DEPLOY_LOG")" = 7 ]; }
check "--status shows releases/r11 (the resolved path) and seven active units [X-023 AC1]" status_r11

# ---- over the whole run -----------------------------------------------------------------------------------------------------
step "Over the whole run"
DEPLOY_LOG=""
check "no DSN or secret of the env files in any deploy.sh output, deploy log, command line or fake log [X-023 AC1]" \
  not grep -rqF "$TOKEN" "$OUT" "$LOGS" "$STATE"
check "no unit was restarted from a file that changed on disk without a daemon-reload [X-023 AC1]" \
  test ! -s "$STATE/stale.log"
check "deploy.sh called only systemctl commands that fake-systemctl.sh knows [X-023 AC1]" \
  not grep -q '^unexpected' "$STATE/systemctl.log"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "deploy.test.sh: all checks passed ($RUNS runs of deploy.sh)"
else
  echo "deploy.test.sh: FAILED"
fi
[ "$FAILED" -eq 0 ]
