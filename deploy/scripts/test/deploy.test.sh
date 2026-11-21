#!/usr/bin/env bash
# =====================================================================================================
# deploy.test.sh — tests deploy/scripts/deploy.sh (velexis-deploy) without root, systemd or a VM (task X-023; the
# tenant migration report step of OBE-007; the refusal of values still at the templates' CHANGE_ME placeholders,
# KI-004).
#
#   bash deploy/scripts/test/deploy.test.sh
#
# Needs bash, Node 18 or newer (DEPLOY_TEST_NODE, else node on PATH; CI uses the `.nvmrc` major), curl, flock, setsid
# and GNU coreutils and findutils (Linux: Ubuntu 24.04 like the VM and the CI runner). No root, no systemd, no
# network beyond loopback. CI runs it in the "deploy-files" job of .github/workflows/ci.yml.
#
# deploy.sh runs exactly as it is, with the test overrides of its header:
#   VELEXIS_ROOT   a temporary folder laid out like a provisioned VM: /etc/velexis/*.env made from the deploy/env
#                  templates (a template with only comments gets no file, as on the VM) with their CHANGE_ME values
#                  filled in as the developer does after provisioning, the provisioned Caddyfile
#                  and maintenance page, /srv/velexis/{incoming,releases}, /var/lib/velexis, /usr/local/sbin, ...
#   SYSTEMCTL      fake-systemctl.sh: starts and stops fake-app.mjs processes that answer /health/ready on each
#                  unit's port, healthy or not depending on the flag file FAKE_UNHEALTHY in their release
#   RUN_TRANSIENT  a stand-in for the transient systemd-run unit (bin/run-transient): runs the command in its folder
#                  with a clean environment made of the env file, as systemd's EnvironmentFile= does
#   VELEXIS_RUN    a stand-in for velexis-run (bin/velexis-run): records its arguments, then runs the command the way
#                  run-as.sh runs it for the ota zone, from the installed velexis-ota-worker unit (its WorkingDirectory
#                  in the running release, refused with exit 125 when there is none, and a clean environment made of
#                  its EnvironmentFile= lines)
#   HEALTH_HOST    a random 127.x.y.z address, so the app ports (3000-3002, 3100, 3101, 4000, 4001) never collide
#                  with anything listening on 127.0.0.1
# with a fake `caddy` (validate only) and `journalctl` first on PATH. Fake releases are folders like the ones
# pack-release.sh builds: RELEASE.json, SHA256SUMS of every file, a copy of this repository's deploy/ folder,
# migrations, reference data, the five app folders and a storefront, with a fake migration CLI
# (db/dist/cli/migrate.js) and a fake reference loader (reference-data/dist/cli/load.js) that record their
# arguments, folder and which DSN variables they got (never a value), and, in a release made with `ota-cli`, a fake OTA
# CLI (ota-backend/dist/cli.js) that records the same for tenants:report-migrations and fails in a release made with
# `report-fail`. A release can carry a marker line in
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
#   13. the tenant migration report (OBE-007, every check ends with [OBE-007 AC4]): the first deploy (r1, no running
#       release) skips it; a second deploy of the same sha repeats the fan-out and the report; a release with an OTA
#       CLI publishes it after the fan-out and before the switch, with its own cli.js, the report of its sha (made
#       readable, 0644, for the OTA zone user), as the ota zone with ota-backend.env and ota-worker.env and never the
#       migrator DSN; a failing report stops the deploy and leaves the previous release current; a release without
#       ota-backend/ skips the step;
#   14. the Velexis Caddy build (X-039, every check ends with [X-039 AC3]): a release's caddy/bin/caddy (a fake build
#       that records its validations) waits while the VM's /usr/bin/caddy is no link to /usr/local/bin/caddy-velexis;
#       once it is (provision-vm.sh, simulated), the same binary again changes nothing and restarts nothing; a changed
#       binary is staged, validates the new Caddyfile with the staged rule files (deploy/caddy/waf), is installed
#       root-owned (0755) from the snapshot after the units are healthy, and Caddy is restarted once (no reload);
#       --rollback re-installs the previous release's binary from its snapshot and restarts Caddy; the same binary with
#       a changed Caddyfile only reloads; a binary that does not validate changes nothing; an unhealthy release with a
#       new binary, rule files and Caddyfile rolls back without any of them going live and without a Caddy restart; a
#       binary with which Caddy does not start stops the deploy with the way back, and --rollback restores the previous
#       release's binary and restarts Caddy;
#   15. the caddy drop-in (lead decision (21k) of 2026-11-13, every check ends with [FIX-W52-SHARED 21k]): a changed
#       drop-in is installed and loaded (daemon-reload) and Caddy is restarted once, after the units and with the new
#       Caddyfile live, and not also reloaded; an unchanged one restarts nothing (a changed Caddyfile is reloaded); an
#       unhealthy release with a new drop-in rolls back without a Caddy restart; a drop-in with which Caddy does not
#       start stops the deploy with the way back, and --rollback restores the previous one and restarts Caddy; on a VM
#       whose caddy service does not run the Velexis build the restart waits for provision-vm.sh; a new build and a
#       changed drop-in together restart Caddy once. fake-systemctl.sh records the loaded drop-in with each restart;
#       since lead decision (22b) of 2026-11-15 ([FIX-W53-SHARED 22b], [FIX-W53-SHARED 22a]) they also check
#       /var/lib/velexis/caddy-dropin.sha256, the record of the drop-in Caddy was last (re)started with: written after
#       each restart, unchanged without one and after the automatic rollback, "restarting" after a restart that failed
#       (the same release deployed again restarts Caddy again), and written by --rollback;
#   16. the record of the drop-in Caddy last started with (lead decision (22b) of 2026-11-15, [FIX-W53-SHARED 22b]): a
#       deploy killed (SIGKILL, by the fake migration) after it installed and loaded a new drop-in, then a deploy that
#       changes nothing restarts Caddy once and records it, and a third restarts nothing; without the record a deploy
#       compares with the drop-in installed when it began (no restart for an unchanged one, one for a new one, none for
#       an unhealthy release's automatic rollback, [FIX-W53-SHARED 22a]) and writes the record; --rollback records the
#       drop-in it restarted Caddy with;
#   17. values still at the templates' CHANGE_ME placeholders (KI-004, every check ends with [FIX-W67-KI004 AC1] or
#       [FIX-W67-KI004 AC3]): an env file whose value still holds CHANGE_ME (a template's value, a real secret pasted
#       beside the placeholder, an optional file's variable) -> refusal before anything changes, every file:VARIABLE
#       named and no value printed, also for a release already on the VM; with the values filled in, a commented line
#       that holds CHANGE_ME (the templates' own header comments included) deploys;
#   18. a release without one of its migration sets (KI-035, every check ends with [FIX-W68-DEPLOYSCRIPT AC1]): an
#       upload with db/dist/cli/migrate.js but without migrations/platform, reference or tenant -> refusal naming the
#       set before anything changes, also for a set folder that is a symbolic link (its SQL would escape SHA256SUMS)
#       and for a release already on the VM; pack-release.sh, run as it is from a copy
#       in a small workspace (a stand-in pnpm and build-caddy.sh), packs all three sets beside the migration CLI with
#       every file in SHA256SUMS, and fails naming a missing set folder before it packs anything;
#   19. --status while a deploy holds the lock (KI-038, [FIX-W68-DEPLOYSCRIPT AC3]): it prints the status, exits 0 and
#       writes nothing to deploy.log, while a deploy is still refused ("another deploy is running");
#   20. the rollback's checks of its target (KI-041, [FIX-W68-DEPLOYSCRIPT AC4]): --rollback to a release whose
#       template names a variable the env files no longer have -> refusal naming file:VARIABLE, nothing changed; a
#       target built on another Node major is not refused (ADR-0029 item 10, D12), only noted; an unhealthy release
#       whose automatic rollback target lacks a variable stays current, nothing switched back, the message naming both
#       releases, the reason and the way back, which then works;
#   21. a failed redeploy of the active release (KI-042, [FIX-W68-DEPLOYSCRIPT AC5]): no rollback, exit 1, the message
#       names --rollback and the release before it in deploy-history, or says that the history names none;
#   22. CHANGE_ME in every assignment systemd's EnvironmentFile= reads (lead decision (37m), [FIX-W68-DEPLOYSCRIPT
#       AC6]): indented, blanks around '=', tab-indented, continued and two-line quoted assignments are refused, each
#       named, no value shown; indented comments (# and ;) deploy; deploy.sh, check-vm.sh and provision-vm.sh hold the
#       same placeholder_names;
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
FAKEBIN="$PREFIX/bin" # caddy, journalctl, run-transient, velexis-run and node, first on deploy.sh's PATH
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
install -D -m 0644 "$DEPLOY/systemd/caddy.service.d/velexis.conf" "$UNITS/caddy.service.d/velexis.conf" # step scripts
# provision-vm.sh records the drop-in each of its Caddy restarts started with (lead decision (22b) of 2026-11-15).
CADDY_RECORD="$LIB/caddy-dropin.sha256"
sha256sum "$UNITS/caddy.service.d/velexis.conf" | cut -c1-64 >"$CADDY_RECORD"
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
# The values the developer fills in after provisioning (docs/mvp/deployment-single-vm.md §3 step 6): velexis-deploy
# refuses a release while a value still holds a template's CHANGE_ME placeholder (KI-004). The secrets carry the token.
set_env platform-backend.env SMTP_URL "smtps://vxmail:s-$TOKEN@smtp.mail.example.net:465"
set_env platform-backend.env OPS_ALERT_EMAIL ops@mail.example.net
set_env ota-backend.env SMTP_URL "smtps://vxmail:s-$TOKEN@smtp.mail.example.net:465"
set_env ota-backend.env OPS_ALERT_EMAIL ops@mail.example.net
set_env alert.env ALERT_SMTP_USER vxalerts
set_env alert.env ALERT_SMTP_PASSWORD "a-$TOKEN"
set_env backup.env RCLONE_REMOTE offsite:velexis-backups-vmtest
if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME' "$ETC"/*.env; then
  die "a template has a CHANGE_ME value that deploy.test.sh does not fill in: $(grep -lE '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME' "$ETC"/*.env | xargs -n 1 basename | paste -sd' ' -)"
fi

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
cat >"$FAKEBIN/velexis-run" <<'SH'
#!/usr/bin/env bash
# deploy.test.sh's VELEXIS_RUN: velexis-run (deploy/scripts/run-as.sh) for the ota zone without root or systemd. It
# records its arguments, the release `current` points at and the mode of the --report file to velexis-run.log, then
# runs the command as run-as.sh would from the installed velexis-ota-worker unit: in its WorkingDirectory (under
# VELEXIS_ROOT; exit 125 when the running release has no such folder, as run-as.sh refuses), with a clean environment
# made of its EnvironmentFile= files (a missing one fails, as systemd does) and NODE_ENV, and returns its exit code.
set -euo pipefail
if [ "${VELEXIS_RUN_CLEAN:-}" != 1 ]; then
  exec env -i VELEXIS_RUN_CLEAN=1 PATH="$PATH" FAKE_STATE="$FAKE_STATE" VELEXIS_ROOT="$VELEXIS_ROOT" bash "$0" "$@"
fi
zone="${1:-}"
shift || true
current="$(readlink -e "$VELEXIS_ROOT/srv/velexis/current" 2>/dev/null || true)"
report=""
previous=""
for arg in "$@"; do
  [ "$previous" != --report ] || report="$arg"
  previous="$arg"
done
mode=none
[ -z "$report" ] || mode="$(stat -c %a "$report" 2>/dev/null || echo missing)"
printf 'zone=%s current=%s report-mode=%s argv=%s\n' "$zone" "$(basename "${current:-none}")" "$mode" "$*" \
  >>"$FAKE_STATE/velexis-run.log"
[ "$zone" = ota ] || { echo "fake velexis-run: only the ota zone" >&2; exit 125; }
unit="$VELEXIS_ROOT/etc/systemd/system/velexis-ota-worker.service"
[ -f "$unit" ] || { echo "velexis-run: $unit is not installed" >&2; exit 125; }
workdir="$VELEXIS_ROOT$(sed -n 's/^WorkingDirectory=-\{0,1\}//p' "$unit" | tail -n 1)"
[ -d "$workdir" ] || { echo "velexis-run: the active release has no $workdir" >&2; exit 125; }
while IFS= read -r env_file; do
  [ -f "$VELEXIS_ROOT$env_file" ] || { echo "velexis-run: $env_file does not exist" >&2; exit 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in [A-Za-z_]*=*) export "${line?}" ;; esac
  done <"$VELEXIS_ROOT$env_file"
done < <(sed -n 's/^EnvironmentFile=//p' "$unit")
export NODE_ENV=production
unset VELEXIS_RUN_CLEAN
cd "$workdir"
exec "$@"
SH
chmod 0755 "$FAKEBIN/caddy" "$FAKEBIN/journalctl" "$FAKEBIN/run-transient" "$FAKEBIN/velexis-run"

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
  find "$dir/deploy" -name '*.env' -type f ! -path "$dir/deploy/caddy/build/versions.env" -delete
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
// A run cut off between its staging and the activation (case 16): with the flag FAKE_KILL_DEPLOY in the state folder,
// the first migration removes the flag and kills deploy.sh and its migration subshell with SIGKILL, as a dropped
// session or the OOM killer would. run-transient execs this process, so its parent is that subshell and the
// subshell's parent is deploy.sh; anything else is refused instead of killed.
const killFlag = path.join(process.env.FAKE_STATE, "FAKE_KILL_DEPLOY");
if (fs.existsSync(killFlag)) {
  fs.unlinkSync(killFlag);
  const parentOf = (pid) => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  };
  const subshell = process.ppid;
  const deploySh = parentOf(subshell);
  const cmdline = fs.readFileSync(`/proc/${deploySh}/cmdline`, "utf8").split("\0");
  if (!cmdline.some((arg) => arg.endsWith("/deploy.sh"))) {
    process.stderr.write(`migrate: FAKE_KILL_DEPLOY found no deploy.sh above it (pid ${deploySh}: ${cmdline.join(" ")})\n`);
    process.exit(1);
  }
  process.kill(deploySh, "SIGKILL");
  process.kill(subshell, "SIGKILL");
  process.exit(137);
}
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
      env-drop=*) # a variable the release's template no longer names (renamed or removed, KI-041)
        v="${opt#env-drop=}"
        grep -q "^${v#*:}=" "$dir/deploy/env/${v%%:*}.env.example" || die "make_release: ${v%%:*}.env.example has no ${v#*:}"
        sed -i "/^${v#*:}=/d" "$dir/deploy/env/${v%%:*}.env.example" ;;
      no-migrations=*) rm -rf "${dir:?}/migrations/${opt#no-migrations=}" ;; # a release packed without a set (KI-035)
      optional-template=*)
        printf '# Optional overrides; nothing is required.\n# X023_OPTIONAL=1\n' \
          >"$dir/deploy/env/${opt#optional-template=}.env.example" ;;
      oldest) mtime=$((NOW - 7200)) ;;
      ota-cli)
        cat >"$dir/ota-backend/dist/cli.js" <<'JS'
"use strict";
// Fake OTA CLI of deploy/scripts/test/deploy.test.sh (OBE-007): records its arguments, release, folder, which DSN and
// Redis variables it got (never a value) and whether the --report file is a JSON report; fails in a release with
// FAKE_REPORT_FAIL, as tenants:report-migrations does when Redis refuses the events.
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const release = path.resolve(__dirname, "..", "..");
const has = (name) => ((process.env[name] ?? "") !== "" ? "yes" : "no");
let report = "none";
const at = args.indexOf("--report");
if (at >= 0) {
  try {
    report = Array.isArray(JSON.parse(fs.readFileSync(args[at + 1], "utf8")).applied) ? "json" : "other";
  } catch {
    report = "unreadable";
  }
}
fs.appendFileSync(
  path.join(process.env.FAKE_STATE, "oneoff.log"),
  `report argv=${args.join(" ")} release=${path.basename(release)} cwd=${process.cwd()} ` +
    `migrator-dsn=${has("DATABASE_MIGRATOR_URL")} app-dsn=${has("DATABASE_URL")} redis=${has("REDIS_URL")} ` +
    `report=${report} node-env=${process.env.NODE_ENV ?? ""}\n`,
);
if (fs.existsSync(path.join(release, "FAKE_REPORT_FAIL"))) {
  process.stderr.write("tenants:report-migrations: Redis refused the events (fake)\n");
  process.exit(1);
}
JS
        ;;
      report-fail) : >"$dir/FAKE_REPORT_FAIL" ;;
      no-ota-backend) rm -rf "${dir:?}/ota-backend" ;;
      caddy-bin=*) # the Velexis Caddy build of pack-release.sh (caddy/bin/caddy): a fake that records its validations
        mkdir -p "$dir/caddy/bin"
        sed "s/@@BUILD@@/${opt#caddy-bin=}/g" >"$dir/caddy/bin/caddy" <<'SH'
#!/usr/bin/env bash
# deploy.test.sh's Velexis Caddy build "@@BUILD@@": only `caddy validate --config <file> --adapter caddyfile`. It records
# the file, whether caddy.env's edge secret was loaded, its build and the rule files (VELEXIS_WAF_DIR); the build "bad"
# refuses every Caddyfile, and fake-systemctl.sh fails to restart Caddy with the build "nostart".
set -euo pipefail
[ "${1:-}" = validate ] || { echo "fake caddy build: only validate" >&2; exit 2; }
shift
cfg=""
while [ $# -gt 0 ]; do case "$1" in --config) cfg="$2"; shift 2 ;; *) shift ;; esac; done
printf 'validate %s edge-secret=%s build=@@BUILD@@ waf=%s\n' "$cfg" "${VELEXIS_EDGE_SECRET:+set}" "${VELEXIS_WAF_DIR:-}" \
  >>"$FAKE_STATE/caddy.log"
if [ "@@BUILD@@" = bad ]; then echo "Error: loading http app module: provision http.handlers.waf: fake build" >&2; exit 1; fi
echo 'Valid configuration'
SH
        if [ "${opt#caddy-bin=}" = nostart ]; then printf '# deploy.test.sh: fails to start\n' >>"$dir/caddy/bin/caddy"; fi
        chmod 0755 "$dir/caddy/bin/caddy" ;;
      waf=*) printf '# deploy.test.sh marker: %s\n' "${opt#waf=}" >>"$dir/deploy/caddy/waf/exclusions.conf" ;;
      dropin=*) # the caddy drop-in (21k); fake-systemctl.sh fails to restart Caddy with the drop-in "nostart"
        printf '# deploy.test.sh marker: %s\n' "${opt#dropin=}" >>"$dir/deploy/systemd/caddy.service.d/velexis.conf"
        if [ "${opt#dropin=}" = nostart ]; then
          printf '# deploy.test.sh: fails to start\n' >>"$dir/deploy/systemd/caddy.service.d/velexis.conf"
        fi ;;
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
deploy() { # args -> DEPLOY_RC, DEPLOY_LOG; CALLS, ONEOFFS, TRANSIENTS, VRUNS, VALIDATES: what this run did
  local c0 o0 t0 r0 v0
  RUNS=$((RUNS + 1))
  DEPLOY_LOG="$OUT/deploy-$RUNS.log"
  c0="$(lines_of "$STATE/systemctl.log")"
  o0="$(lines_of "$STATE/oneoff.log")"
  t0="$(lines_of "$STATE/run-transient.log")"
  r0="$(lines_of "$STATE/velexis-run.log")"
  v0="$(lines_of "$STATE/caddy.log")"
  DEPLOY_RC=0
  env VELEXIS_ROOT="$VM_ROOT" SYSTEMCTL="$FAKE_SYSTEMCTL" RUN_TRANSIENT="$FAKEBIN/run-transient" \
    VELEXIS_RUN="$FAKEBIN/velexis-run" HEALTH_HOST="$HOST" HEALTH_TIMEOUT=2 FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" \
    bash "$DEPLOY_SH" "$@" \
    </dev/null >"$DEPLOY_LOG" 2>&1 || DEPLOY_RC=$?
  CALLS="$(since "$STATE/systemctl.log" "$c0")"
  ONEOFFS="$(since "$STATE/oneoff.log" "$o0")"
  TRANSIENTS="$(since "$STATE/run-transient.log" "$t0")"
  VRUNS="$(since "$STATE/velexis-run.log" "$r0")"
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
restart_order() { printf '%s\n' "$CALLS" | awk '$1 == "restart" && $2 != "caddy" { print $2 }' | paste -sd' ' -; }
restarted_all_in_order() { [ "$(restart_order)" = "${UNIT_ORDER[*]}" ]; }
restart_field() { # unit field -> the field (release, marker, pid) of the unit's last restart in this run
  printf '%s\n' "$CALLS" | awk -v u="$1" -v f="$2=" '$1 == "restart" && $2 == u {
    for (i = 3; i <= NF; i++) if (index($i, f) == 1) v = substr($i, length(f) + 1) } END { print v }'
}
every_restart_of() { # release -> every restart of this run started the unit in that release
  [ -n "$CALLS" ] && ! printf '%s\n' "$CALLS" | awk -v r="$1" '$1 == "restart" && $2 != "caddy" && $5 != "release=" r' | grep -q .
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
make_release r1 unit=r1 caddy=r1 ota-cli
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
first_report_skipped() {
  output_has "skip the tenant migration report: no running release has ota-backend/ for velexis-run ota" &&
    [ -z "$VRUNS" ] && ! printf '%s\n' "$ONEOFFS" | grep -q '^report '
}
check "the first deploy (no running release, so velexis-run ota has no working folder) skips the tenant migration report [OBE-007 AC4]" \
  first_report_skipped
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
again_reported() {
  [ "$(printf '%s\n' "$ONEOFFS" | cut -d' ' -f1-2 | paste -sd' ' -)" = \
    "migrate argv=platform migrate argv=reference migrate argv=tenants report argv=tenants:report-migrations" ] &&
    [ "$VRUNS" = "zone=ota current=$R1 report-mode=644 argv=node $REL1/ota-backend/dist/cli.js tenants:report-migrations --report $LIB/migrate-$R1.json" ]
}
check "deploying the same sha again repeats the tenant fan-out and the report (nothing is applied twice) [OBE-007 AC4]" \
  again_reported

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

# ---- 13. tenant migration report ----------------------------------------------------------------------------------------------
step "13. The tenant migration report (OBE-007): after the fan-out, before the switch, as the OTA zone"
make_release r12 ota-cli
R12="$BUILT"
upload "$R12"
deploy "$R12"
report_line() { printf '%s\n' "$ONEOFFS" | grep '^report ' || true; }
r12_done() { rc_is 0 && current_is "$R12" && output_has "report tenant migrations (velexis-run ota, "; }
r12_after_fanout() {
  [ "$(printf '%s\n' "$ONEOFFS" | cut -d' ' -f1-2 | paste -sd' ' -)" = \
    "migrate argv=platform migrate argv=reference migrate argv=tenants report argv=tenants:report-migrations" ]
}
r12_own_cli() {
  [ "$VRUNS" = "zone=ota current=$R11 report-mode=644 argv=node $VM_ROOT/srv/velexis/releases/$R12/ota-backend/dist/cli.js tenants:report-migrations --report $VM_ROOT/var/lib/velexis/migrate-$R12.json" ] &&
    [[ "$(report_line)" == "report argv=tenants:report-migrations --report $VM_ROOT/var/lib/velexis/migrate-$R12.json release=$R12 cwd=$SRV/releases/$R11/ota-backend "* ]]
}
r12_ota_zone_env() {
  [[ "$(report_line)" == *" migrator-dsn=no app-dsn=yes redis=yes report=json node-env=production" ]] &&
    printf '%s\n' "$TRANSIENTS" | grep -q '/etc/velexis/migrator.env ' &&
    ! printf '%s\n' "$TRANSIENTS" | grep -q 'tenants:report-migrations'
}
r12_report_modes() { [ "$(stat -c %a "$LIB/migrate-$R12.json")" = 644 ] && [ "$(stat -c %a "$LOGS/migrate-$R12.json")" = 600 ]; }
r12_switched_after() { [ "$(restart_field velexis-ota-worker release)" = "$R12" ] && restarted_all_in_order && serving "$R12"; }
check "exit 0, current points at r12, and the report step ran [OBE-007 AC4]" r12_done
check "the report ran right after the tenant fan-out (platform, reference, tenants, then the report) [OBE-007 AC4]" r12_after_fanout
check "before the switch (current was still r11), through velexis-run ota with r12's own cli.js and the report of r12's sha [OBE-007 AC4]" \
  r12_own_cli
check "as the OTA zone: ota-backend.env and ota-worker.env (DATABASE_URL, REDIS_URL), never the migrator DSN, never as a migration unit [OBE-007 AC4]" \
  r12_ota_zone_env
check "the report in /var/lib/velexis is readable (0644) for the OTA zone user, the copy in /var/log/velexis stays 0600 [OBE-007 AC4]" \
  r12_report_modes
check "the units then restart on r12 and answer for it [OBE-007 AC4]" r12_switched_after

make_release r13 unit=r13 ota-cli report-fail
R13="$BUILT"
upload "$R13"
PIDS_BEFORE="$(app_pids)"
deploy "$R13"
r13_failed() {
  rc_is 1 && output_has "publishing the tenant migration report failed; the previous release keeps running" &&
    [[ "$(report_line)" == "report argv=tenants:report-migrations --report $VM_ROOT/var/lib/velexis/migrate-$R13.json release=$R13 "* ]]
}
r13_no_switch() {
  current_is "$R12" && no_call '^(restart|enable) ' && [ "$(app_pids)" = "$PIDS_BEFORE" ] && serving "$R12" &&
    output_has "re-install the units and Caddyfile of the running release $R12" && unit_marker_is "" && loaded_marker_is ""
}
check "a failing report: exit 1, 'publishing the tenant migration report failed; the previous release keeps running' [OBE-007 AC4]" \
  r13_failed
check "a failing report leaves r12 current: no switch, no restart, r12's units re-installed from its snapshot [OBE-007 AC4]" \
  r13_no_switch

make_release r14 no-ota-backend
R14="$BUILT"
upload "$R14"
deploy "$R14"
r14_skipped() {
  rc_is 0 && current_is "$R14" && [ -z "$VRUNS" ] && [ -z "$(report_line)" ] && not output_has "report tenant migrations" &&
    printf '%s\n' "$ONEOFFS" | grep -q '^migrate argv=tenants '
}
check "a release without ota-backend/ runs the fan-out but skips the report step [OBE-007 AC4]" r14_skipped

# ---- 14. the Velexis Caddy build (X-039) ----------------------------------------------------------------------------------------
step "14. The Velexis Caddy build: installed from the snapshot when it changed, Caddy restarted; unchanged, nothing restarted"
# deploy.sh still reaches the VM through the symbolic link of case 12 (VM_ROOT), so the paths it reports start there.
CADDY_BIN="$ROOT/usr/local/bin/caddy-velexis"
WAF="$ROOT/etc/caddy/waf"
sha_file() { sha256sum "$1" | cut -c1-64; }
caddy_calls() { printf '%s\n' "$CALLS" | grep -E '^(restart|reload) caddy' || true; }
no_staged_caddy_files() { [ ! -e "$ROOT/etc/caddy/Caddyfile.next" ] && [ ! -e "$CADDY_BIN.next" ] && [ ! -e "$WAF.next" ]; }
binary_is() { # release dir -> the installed build is that release's caddy/bin/caddy, root's 0755 (the test's user)
  same_file "$1/caddy/bin/caddy" "$CADDY_BIN" && [ "$(stat -c '%U:%G %a' "$CADDY_BIN")" = "$(id -un):$(id -gn) 755" ]
}
CADDY_DROPIN="$UNITS/caddy.service.d/velexis.conf"
restarted_after_units() { # exactly one Caddy restart, after the last unit restart, with the installed binary and the
  # installed drop-in as loaded by a daemon-reload; no reload
  local r s
  [ "$(calls_matching '^restart caddy ')" = 1 ] && no_call '^reload caddy' || return 1
  r="$(last_line_of '^restart caddy ')"
  s="$(printf '%s\n' "$CALLS" | grep -nE '^restart velexis-' | tail -n 1 | cut -d: -f1)"
  [ -n "$s" ] && [ "$r" -gt "$s" ] &&
    printf '%s\n' "$CALLS" |
    grep -q "^restart caddy binary=$(sha_file "$CADDY_BIN") caddyfile=$(sha_file "$CADDYFILE") dropin=$(sha_file "$CADDY_DROPIN")$"
}

make_release r15 caddy-bin=b1
R15="$BUILT"
REL15="$SRV/releases/$R15"
upload "$R15"
deploy "$R15"
r15_waits() {
  rc_is 0 && current_is "$R15" && output_has "this release's Caddy build waits for provision-vm.sh --steps caddy" &&
    [ ! -e "$CADDY_BIN" ] && [ -z "$(caddy_calls)" ] && no_staged_caddy_files
}
r15_snapshot() {
  same_file "$REL15/caddy/bin/caddy" "$LIB/system/$R15/caddy-velexis" && [ "$(stat -c %a "$LIB/system/$R15/caddy-velexis")" = 755 ] &&
    diff -r -q "$REL15/deploy/caddy/waf" "$LIB/system/$R15/caddy-waf" >/dev/null
}
check "a VM whose /usr/bin/caddy is no link to caddy-velexis: the release's build waits, nothing is installed or restarted [X-039 AC3]" \
  r15_waits
check "the snapshot holds the release's build (0755) and its rule files [X-039 AC3]" r15_snapshot
check "the rule files are installed from the snapshot (they need no build) [X-039 AC3]" \
  diff -r -q "$REL15/deploy/caddy/waf" "$WAF"

# provision-vm.sh --steps caddy (X-039): the build installed once, /usr/bin/caddy diverted to a link to it, and Caddy
# restarted, which records the drop-in it started with (22b).
mkdir -p "$ROOT/usr/bin" "$ROOT/usr/local/bin"
install -m 0755 "$REL15/caddy/bin/caddy" "$CADDY_BIN"
ln -s /usr/local/bin/caddy-velexis "$ROOT/usr/bin/caddy"
sha256sum "$UNITS/caddy.service.d/velexis.conf" | cut -c1-64 >"$CADDY_RECORD"
upload "$R15"
INODE_BEFORE="$(stat -c '%i %Y' "$CADDY_BIN")"
deploy "$R15"
r15_unchanged() {
  rc_is 0 && current_is "$R15" && [ -z "$(caddy_calls)" ] && [ "$(stat -c '%i %Y' "$CADDY_BIN")" = "$INODE_BEFORE" ] &&
    [ -z "$VALIDATES" ] && no_staged_caddy_files && restarted_all_in_order
}
check "an unchanged build (the same sha again): no install, no validation, Caddy neither restarted nor reloaded [X-039 AC3]" \
  r15_unchanged

make_release r16 caddy-bin=b2 caddy=r16 waf=r16
R16="$BUILT"
REL16="$SRV/releases/$R16"
upload "$R16"
deploy "$R16"
r16_validated() {
  [ "$VALIDATES" = "validate $VM_ROOT/etc/caddy/Caddyfile.next edge-secret=set build=b2 waf=$VM_ROOT/etc/caddy/waf.next" ]
}
r16_live() {
  rc_is 0 && current_is "$R16" && binary_is "$REL16" && caddy_marker_is r16 && [ "$(marker_of "$WAF/exclusions.conf")" = r16 ] &&
    no_staged_caddy_files && output_has "Caddy build installed: $VM_ROOT/usr/local/bin/caddy-velexis $(sha_file "$REL16/caddy/bin/caddy")"
}
check "a changed build validates the new Caddyfile with itself and the staged rule files (waf.next) [X-039 AC3]" r16_validated
check "the changed build, rule files and Caddyfile are live, from the snapshot, nothing stays staged [X-039 AC3]" r16_live
check "Caddy is restarted once after the units are healthy, with the new build, and not reloaded [X-039 AC3]" \
  restarted_after_units
r16_serving_check() { serving "$R16"; }
check "the units restarted in order on r16 and answer for it [X-039 AC3]" all_of restarted_all_in_order r16_serving_check
upload "$R16"
INODE_BEFORE="$(stat -c '%i %Y' "$CADDY_BIN")"
deploy "$R16"
r16_again() { rc_is 0 && [ -z "$(caddy_calls)" ] && [ "$(stat -c '%i %Y' "$CADDY_BIN")" = "$INODE_BEFORE" ] && [ -z "$VALIDATES" ]; }
check "the same build again (r16 re-deployed): no install, no validation, no restart, no reload [X-039 AC3]" r16_again

tamper_binary_copy() { # sha: the release folder's copy of the build gets a marker; rollbacks must use the snapshot
  chmod u+w "$SRV/releases/$1/caddy/bin/caddy"
  printf '# deploy.test.sh marker: release-folder\n' >>"$SRV/releases/$1/caddy/bin/caddy"
  chmod u-w "$SRV/releases/$1/caddy/bin/caddy"
}
cp "$REL15/caddy/bin/caddy" "$PREFIX/caddy-b1"
tamper_binary_copy "$R15"
deploy --rollback
r15_back() {
  rc_is 0 && current_is "$R15" && same_file "$PREFIX/caddy-b1" "$CADDY_BIN" && same_file "$LIB/system/$R15/caddy-velexis" "$CADDY_BIN" &&
    [ "$VALIDATES" = "validate $VM_ROOT/etc/caddy/Caddyfile.next edge-secret=set build=b1 waf=$VM_ROOT/etc/caddy/waf.next" ] && no_staged_caddy_files
}
check "--rollback to r15 re-installs r15's build from its snapshot (not the release folder's copy), validated with it [X-039 AC3]" \
  r15_back
check "--rollback restarts Caddy once, after the units, with r15's build [X-039 AC3]" restarted_after_units

make_release r17 caddy-bin=b1 caddy=r17
R17="$BUILT"
upload "$R17"
INODE_BEFORE="$(stat -c '%i %Y' "$CADDY_BIN")"
deploy "$R17"
r17_reloaded() {
  rc_is 0 && current_is "$R17" && caddy_marker_is r17 && [ "$(stat -c '%i %Y' "$CADDY_BIN")" = "$INODE_BEFORE" ] &&
    [ "$VALIDATES" = "validate $VM_ROOT/etc/caddy/Caddyfile.next edge-secret=set build=b1 waf=$VM_ROOT/etc/caddy/waf" ] &&
    no_call '^restart caddy' && caddy_reload_after_restarts
}
check "the same build with a changed Caddyfile: validated with the installed build, Caddy reloaded once, not restarted [X-039 AC3]" \
  r17_reloaded

make_release r18 caddy-bin=bad caddy=r18
R18="$BUILT"
upload "$R18"
FP_BEFORE="$(live_state; fingerprint "$CADDY_BIN" "$WAF")"
deploy "$R18"
r18_refused() {
  rc_is 1 && output_has "does not validate; nothing was activated" &&
    output_has "caddy validate failed: Error: loading http app module: provision http.handlers.waf: fake build"
}
r18_unchanged() {
  same_fingerprint "$FP_BEFORE" "$(live_state; fingerprint "$CADDY_BIN" "$WAF")" && no_staged_caddy_files &&
    [ -z "$CALLS" ] && current_is "$R17"
}
check "a build that does not validate the Caddyfile is refused with caddy's message [X-039 AC3]" r18_refused
check "it changes nothing: build, rule files, Caddyfile, units, releases and current stay, nothing is staged or called [X-039 AC3]" \
  r18_unchanged
rm -rf "${SRV:?}/incoming/$R18"

# An unhealthy release with a new build, rule files and Caddyfile: they are staged and validated, but none goes live,
# the automatic rollback to r17 has nothing of Caddy's to restore (r17's are still live), and Caddy is never restarted.
make_release r19 caddy-bin=b3 caddy=r19 waf=r19 unhealthy
R19="$BUILT"
upload "$R19"
FP_BEFORE="$(fingerprint "$CADDY_BIN" "$WAF" "$CADDYFILE")"
deploy "$R19"
r19_rolled_back() {
  rc_is 1 && output_has "deploy of $R19 failed health checks; rolled back to $R17" && current_is "$R17" &&
    history_ends_with "$R17 rollback"
}
r19_never_live() {
  [ "$VALIDATES" = "validate $VM_ROOT/etc/caddy/Caddyfile.next edge-secret=set build=b3 waf=$VM_ROOT/etc/caddy/waf.next" ] &&
    same_fingerprint "$FP_BEFORE" "$(fingerprint "$CADDY_BIN" "$WAF" "$CADDYFILE")" && [ -z "$(caddy_calls)" ] &&
    no_staged_caddy_files
}
check "an unhealthy release with a new build: exit 1, rolled back to r17 [X-039 AC3]" r19_rolled_back
check "its build, rule files and Caddyfile were staged and validated but never live: r17's stay, Caddy neither restarted nor reloaded, nothing staged [X-039 AC3]" \
  r19_never_live

# A build that validates but with which Caddy does not start: the deploy stops with what to do, its healthy release
# stays current, and --rollback puts r17's build back from its snapshot and restarts Caddy with it.
make_release r20 caddy-bin=nostart caddy=r20
R20="$BUILT"
upload "$R20"
deploy "$R20"
r20_stopped() {
  rc_is 1 && output_has "Caddy did not start with the new build $VM_ROOT/usr/local/bin/caddy-velexis; run: sudo velexis-deploy --rollback" &&
    current_is "$R20" && [ "$(calls_matching '^restart caddy ')" = 1 ] && ! grep -q " $R20" "$LIB/deploy-history"
}
check "a build with which Caddy does not start: exit 1 with the way back (--rollback), the release stays current [X-039 AC3]" \
  r20_stopped
deploy --rollback
r20_back() {
  rc_is 0 && current_is "$R17" && same_file "$LIB/system/$R17/caddy-velexis" "$CADDY_BIN" && caddy_marker_is r17 &&
    no_staged_caddy_files
}
check "--rollback then re-installs r17's build and Caddyfile [X-039 AC3]" r20_back
check "and restarts Caddy once, after the units, with r17's build [X-039 AC3]" restarted_after_units

# ---- 15. the caddy drop-in (lead decision (21k) of 2026-11-13) ------------------------------------------------------------
step "15. The caddy drop-in: a changed one restarts Caddy once, after the daemon-reload and the new Caddyfile; unchanged, no restart"
# systemd applies a changed drop-in only when Caddy starts again, so deploy.sh restarts Caddy (never only reloads it) when
# the drop-in it leaves installed differs from the one installed when it began, and only where the caddy service runs
# the Velexis build. Every release here carries r17's build (b1) unless it says otherwise.
LOADED_DROPIN="$STATE/loaded/caddy.service.d/velexis.conf"
dropin_marker_is() { [ "$(marker_of "$CADDY_DROPIN")" = "$1" ]; }
loaded_dropin_marker_is() { [ "$(marker_of "$LOADED_DROPIN")" = "$1" ]; }
reloaded_before_caddy_restart() { # the last daemon-reload of this run comes before Caddy's restart
  local d r
  d="$(last_line_of '^daemon-reload')"
  r="$(last_line_of '^restart caddy ')"
  [ -n "$d" ] && [ -n "$r" ] && [ "$d" -lt "$r" ]
}
# The record of the drop-in Caddy was last (re)started with (lead decision (22b) of 2026-11-15).
record_is() { [ "$(cat "$CADDY_RECORD" 2>/dev/null)" = "$1" ]; }
record_is_installed() { record_is "$(sha_file "$CADDY_DROPIN")"; }

make_release r21 caddy-bin=b1 caddy=r21 dropin=r21
R21="$BUILT"
upload "$R21"
deploy "$R21"
r21_live() {
  rc_is 0 && current_is "$R21" && dropin_marker_is r21 && loaded_dropin_marker_is r21 && caddy_marker_is r21 &&
    [ "$VALIDATES" = "validate $VM_ROOT/etc/caddy/Caddyfile.next edge-secret=set build=b1 waf=$VM_ROOT/etc/caddy/waf" ] &&
    no_staged_caddy_files && output_has "Caddy restarted (new drop-in)"
}
check "a deploy with a changed drop-in installs and loads it (daemon-reload); its new Caddyfile is validated and goes live [FIX-W52-SHARED 21k]" \
  r21_live
check "Caddy is restarted once, after the daemon-reload and the units, with the new drop-in and Caddyfile, and not also reloaded [FIX-W52-SHARED 21k]" \
  all_of reloaded_before_caddy_restart restarted_after_units
check "after the restart, /var/lib/velexis/caddy-dropin.sha256 records r21's drop-in, the one Caddy started with [FIX-W53-SHARED 22b]" \
  record_is_installed
R21_DROPIN_SHA="$(sha_file "$CADDY_DROPIN")"

make_release r22 caddy-bin=b1 caddy=r22 dropin=r21
R22="$BUILT"
upload "$R22"
deploy "$R22"
r22_reloaded() {
  rc_is 0 && current_is "$R22" && dropin_marker_is r21 && caddy_marker_is r22 && no_call '^daemon-reload' &&
    no_call '^restart caddy' && caddy_reload_after_restarts && not output_has "Caddy restarted"
}
check "a deploy whose drop-in is the installed one (only the Caddyfile changed): no daemon-reload, no Caddy restart, one reload [FIX-W52-SHARED 21k]" \
  r22_reloaded
check "without a restart the record stays r21's drop-in [FIX-W53-SHARED 22b]" record_is "$R21_DROPIN_SHA"

# An unhealthy release with a new drop-in: it is installed and loaded before the units restart, the automatic rollback
# puts r22's back and loads it again, so the running Caddy, which never had r23's, is neither restarted nor reloaded.
make_release r23 caddy-bin=b1 caddy=r23 dropin=r23 unhealthy
R23="$BUILT"
upload "$R23"
deploy "$R23"
r23_rolled_back() {
  rc_is 1 && output_has "deploy of $R23 failed health checks; rolled back to $R22" && current_is "$R22" &&
    history_ends_with "$R22 rollback"
}
r23_no_restart() {
  dropin_marker_is r21 && loaded_dropin_marker_is r21 && caddy_marker_is r22 && [ -z "$(caddy_calls)" ] &&
    [ "$(calls_matching '^daemon-reload')" = 2 ] && no_staged_caddy_files
}
check "an unhealthy release with a new drop-in: exit 1, rolled back to r22 [FIX-W52-SHARED 21k]" r23_rolled_back
check "its drop-in was loaded, then r22's put back and loaded again; Caddy neither restarted nor reloaded [FIX-W52-SHARED 21k]" \
  r23_no_restart
r23_record_kept() { record_is_installed && record_is "$R21_DROPIN_SHA"; }
check "after that automatic rollback the record equals the installed drop-in (r22's, which Caddy runs), so nothing restarts later either [FIX-W53-SHARED 22a]" \
  r23_record_kept

# A drop-in with which Caddy does not start: the deploy stops like a failed reload, with the way back; --rollback puts
# r22's drop-in back from its snapshot and restarts Caddy with it.
make_release r24 caddy-bin=b1 dropin=nostart
R24="$BUILT"
upload "$R24"
deploy "$R24"
r24_stopped() {
  rc_is 1 && current_is "$R24" && [ "$(calls_matching '^restart caddy ')" = 1 ] && no_call '^reload caddy' &&
    output_has "Caddy did not start with the changed drop-in $VM_ROOT/etc/systemd/system/caddy.service.d/velexis.conf; run: sudo velexis-deploy --rollback (the previous release's drop-in)" &&
    ! grep -q " $R24" "$LIB/deploy-history"
}
check "a drop-in with which Caddy does not start: exit 1 with the way back (--rollback), the release stays current [FIX-W52-SHARED 21k]" \
  r24_stopped
check "the record says 'restarting', never r24's drop-in, which Caddy did not start with [FIX-W53-SHARED 22b]" record_is restarting
# The same release again (deploy.yml run once more, the cause not fixed): the record still says Caddy has not started,
# so the deploy restarts it again and fails the same way, instead of reporting success with Caddy down.
upload "$R24"
deploy "$R24"
r24_tries_again() {
  rc_is 1 && current_is "$R24" && [ "$(calls_matching '^restart caddy ')" = 1 ] && no_call '^daemon-reload' &&
    output_has "Caddy did not start with the changed drop-in" && record_is restarting
}
check "deploying r24 again restarts Caddy again (no daemon-reload, nothing else changed) and stops the same way [FIX-W53-SHARED 22b]" \
  r24_tries_again
deploy --rollback
r24_back() {
  rc_is 0 && current_is "$R22" && dropin_marker_is r21 && loaded_dropin_marker_is r21 && caddy_marker_is r22 &&
    no_staged_caddy_files && output_has "Caddy restarted (new drop-in)"
}
check "--rollback then re-installs r22's drop-in and Caddyfile from its snapshot [FIX-W52-SHARED 21k]" r24_back
check "and restarts Caddy once, after the daemon-reload and the units, with r22's drop-in, not also reloaded [FIX-W52-SHARED 21k]" \
  all_of reloaded_before_caddy_restart restarted_after_units
check "--rollback records the drop-in Caddy restarted with (r22's) [FIX-W53-SHARED 22b]" record_is "$R21_DROPIN_SHA"

# A VM whose caddy service does not run the Velexis build yet (no link from provision-vm.sh --steps caddy): the drop-in is
# installed and loaded, and Caddy's restart waits for that step, which restarts Caddy.
rm -f "$ROOT/usr/bin/caddy"
make_release r25 caddy-bin=b1 dropin=r25
R25="$BUILT"
upload "$R25"
deploy "$R25"
r25_waits() {
  rc_is 0 && current_is "$R25" && dropin_marker_is r25 && loaded_dropin_marker_is r25 && no_call '^restart caddy' &&
    output_has "Caddy's restart for its changed drop-in waits for provision-vm.sh --steps caddy" &&
    not output_has "Caddy restarted"
}
check "a VM whose caddy service does not run the Velexis build: the changed drop-in is loaded, Caddy not restarted, the restart waits for provision-vm.sh [FIX-W52-SHARED 21k]" \
  r25_waits
check "the record stays the drop-in the running Caddy started with (r22's) [FIX-W53-SHARED 22b]" record_is "$R21_DROPIN_SHA"
# provision-vm.sh --steps caddy: the link, and Caddy restarted with r25's drop-in, which it records.
ln -s /usr/local/bin/caddy-velexis "$ROOT/usr/bin/caddy"
sha_file "$CADDY_DROPIN" >"$CADDY_RECORD"

make_release r26 caddy-bin=b4 dropin=r26
R26="$BUILT"
upload "$R26"
deploy "$R26"
r26_once() {
  rc_is 0 && current_is "$R26" && binary_is "$SRV/releases/$R26" && dropin_marker_is r26 && loaded_dropin_marker_is r26 &&
    output_has "Caddy restarted (new build and drop-in)"
}
check "a new build and a changed drop-in together: one Caddy restart for both, after the units, not also reloaded [FIX-W52-SHARED 21k]" \
  all_of r26_once reloaded_before_caddy_restart restarted_after_units
check "and the record names r26's drop-in [FIX-W53-SHARED 22b]" record_is_installed
R26_DROPIN_SHA="$(sha_file "$CADDY_DROPIN")"

# ---- 16. the record of the drop-in Caddy last started with (lead decision (22b) of 2026-11-15) -----------------------
step "16. The drop-in Caddy last started with: a run cut off before the activation loses no restart; without a record the run start stands in"
LOCK="$ROOT/run/velexis-deploy.lock"
# A run cut off between its staging and the activation: r27's new drop-in is installed and loaded (daemon-reload), then
# deploy.sh is killed (SIGKILL, during its first migration) before it switches or restarts anything.
make_release r27 caddy-bin=b4 dropin=r27
R27="$BUILT"
upload "$R27"
: >"$STATE/FAKE_KILL_DEPLOY"
deploy "$R27"
flock -w 10 "$LOCK" true || die "the killed deploy's lock was not released"
r27_cut_off() {
  rc_is 137 && [ ! -e "$STATE/FAKE_KILL_DEPLOY" ] && current_is "$R26" && dropin_marker_is r27 &&
    loaded_dropin_marker_is r27 && [ -z "$(caddy_calls)" ] && record_is "$R26_DROPIN_SHA" &&
    not output_has "deploy $R27 done"
}
check "a run killed during its migrations: r27's drop-in installed and loaded, no switch, no Caddy restart, the record still r26's [FIX-W53-SHARED 22b]" \
  r27_cut_off
# The next run changes nothing itself (r27 again, from its snapshot): its drop-in is already installed, so with the run
# start alone ((21k)) nothing would restart Caddy, which still runs r26's.
upload "$R27"
deploy "$R27"
r27_restarted() {
  rc_is 0 && current_is "$R27" && output_has "release $R27 is already on the VM" && no_call '^daemon-reload' &&
    output_has "Caddy restarted (new drop-in)" && record_is_installed && dropin_marker_is r27
}
check "the next deploy, which changes nothing (no daemon-reload), restarts Caddy once with r27's drop-in, after the units, not also reloaded, and records it [FIX-W53-SHARED 22b]" \
  all_of r27_restarted restarted_after_units
upload "$R27"
deploy "$R27"
r27_settled() { rc_is 0 && [ -z "$(caddy_calls)" ] && record_is_installed; }
check "a third deploy of r27 restarts nothing: the record equals the installed drop-in [FIX-W53-SHARED 22b]" r27_settled

# A VM without the record (provisioned before the decision): the drop-in installed when the run began stands in for it,
# and the run writes the record.
R27_DROPIN_SHA="$(sha_file "$CADDY_DROPIN")"
rm -f "$CADDY_RECORD"
upload "$R27"
deploy "$R27"
no_record_unchanged() {
  rc_is 0 && [ -z "$(caddy_calls)" ] && record_is "$R27_DROPIN_SHA" &&
    output_has "no record of the drop-in Caddy last started with"
}
check "without a record, a deploy that changes no drop-in restarts nothing and writes the record (the installed drop-in) [FIX-W53-SHARED 22b]" \
  no_record_unchanged
rm -f "$CADDY_RECORD"
make_release r28 caddy-bin=b4 dropin=r28
R28="$BUILT"
upload "$R28"
deploy "$R28"
no_record_changed() {
  rc_is 0 && current_is "$R28" && dropin_marker_is r28 && output_has "Caddy restarted (new drop-in)" && record_is_installed
}
check "without a record, a deploy that brings a new drop-in compares with the run start: one Caddy restart, after the units, and the record names it [FIX-W53-SHARED 22b]" \
  all_of no_record_changed reloaded_before_caddy_restart restarted_after_units
R28_DROPIN_SHA="$(sha_file "$CADDY_DROPIN")"
rm -f "$CADDY_RECORD"
make_release r29 caddy-bin=b4 dropin=r29 unhealthy
R29="$BUILT"
upload "$R29"
deploy "$R29"
no_record_rolled_back() {
  rc_is 1 && output_has "deploy of $R29 failed health checks; rolled back to $R28" && current_is "$R28" &&
    dropin_marker_is r28 && loaded_dropin_marker_is r28 && [ -z "$(caddy_calls)" ] && record_is "$R28_DROPIN_SHA"
}
check "without a record, an unhealthy release's automatic rollback restarts nothing and writes the record: the installed drop-in (r28's) [FIX-W53-SHARED 22a]" \
  no_record_rolled_back
# --rollback (to r27, the release before r28) records the drop-in it restarted Caddy with.
deploy --rollback
rollback_recorded() {
  rc_is 0 && current_is "$R27" && dropin_marker_is r27 && output_has "Caddy restarted (new drop-in)" &&
    record_is "$R27_DROPIN_SHA"
}
check "--rollback to r27 restarts Caddy once with r27's drop-in, after the daemon-reload and the units, and records it [FIX-W53-SHARED 22b]" \
  all_of rollback_recorded reloaded_before_caddy_restart restarted_after_units

# ---- 17. values still at the templates' CHANGE_ME placeholders (KI-004) -----------------------------------------
step "17. Env values still at the templates' CHANGE_ME placeholders: refused before anything changes, named, never shown"
# r30 has r27's Caddy build and drop-in, so its deploy restarts no Caddy: only the env files differ between the runs.
make_release r30 unit=r30 caddy=r30 caddy-bin=b4 dropin=r27
R30="$BUILT"
upload "$R30"
cp -p "$ETC/platform-backend.env" "$PREFIX/platform-backend.env.filled"
cp -p "$ETC/alert.env" "$PREFIX/alert.env.filled"
# A template's value again, the same with a real secret pasted beside the placeholder (never to be printed), and a
# placeholder pasted into a variable of the optional platform-worker.env (its template names no variable), followed by
# a byte that is not UTF-8 (the check reads bytes, also under the VM's C.UTF-8 locale).
set_env alert.env ALERT_SMTP_PASSWORD CHANGE_ME
set_env platform-backend.env SMTP_URL "smtps://CHANGE_ME_USER:p-$TOKEN@smtp.example.com:465"
( umask 077; printf '# operator overrides\nLOG_LEVEL=debug-CHANGE_ME-\377\n' >"$ETC/platform-worker.env" )
FP_BEFORE="$(fingerprint "$ROOT")"
deploy "$R30"
PLACEHOLDERS_NAMED="env files hold values still at the templates' CHANGE_ME placeholders: alert.env:ALERT_SMTP_PASSWORD platform-backend.env:SMTP_URL platform-worker.env:LOG_LEVEL."
placeholders_refused() { rc_is 1 && output_has "$PLACEHOLDERS_NAMED" && output_has "Nothing was changed."; }
no_value_shown() {
  not output_has "p-$TOKEN" && not output_has "smtp.example.com" && not output_has "CHANGE_ME_USER" &&
    not output_has "debug-CHANGE_ME" && not grep -qF "p-$TOKEN" "$LOGS/deploy.log"
}
r27_untouched() { current_is "$R27" && nothing_changed; }
r30_waits() { [ -d "$SRV/incoming/$R30" ] && [ ! -e "$SRV/releases/$R30" ] && [ ! -e "$LIB/system/$R30" ]; }
check "refused, exit 1, naming alert.env:ALERT_SMTP_PASSWORD, platform-backend.env:SMTP_URL and platform-worker.env:LOG_LEVEL, with 'Nothing was changed.' [FIX-W67-KI004 AC1]" \
  placeholders_refused
check "no value is shown: neither the pasted secret nor the placeholder values reach the output or the deploy log [FIX-W67-KI004 AC1]" \
  no_value_shown
check "nothing changed before the refusal: current is r27, no snapshot, unit, Caddyfile, root script or release; the upload waits in incoming/ [FIX-W67-KI004 AC1]" \
  all_of r27_untouched nothing_ran r30_waits
# The same files refuse a release that is already on the VM (deploy.sh's other branch), before its snapshot is staged.
deploy "$R27"
check "re-deploying r27, already on the VM, is refused the same way, changing nothing [FIX-W67-KI004 AC1]" \
  all_of placeholders_refused no_value_shown r27_untouched nothing_ran
# Filled in again, with the placeholder only in comments: a commented-out line, the optional file's comment and the
# templates' own header comments ("CHANGE_ME values are filled in by the developer").
cp -p "$PREFIX/platform-backend.env.filled" "$ETC/platform-backend.env"
cp -p "$PREFIX/alert.env.filled" "$ETC/alert.env"
printf '# SMTP_URL=smtps://CHANGE_ME_USER:CHANGE_ME_PASSWORD@smtp.example.com:465\n' >>"$ETC/platform-backend.env"
( umask 077; printf '# operator overrides\n# LOG_LEVEL=debug-CHANGE_ME\n' >"$ETC/platform-worker.env" )
header_comments_hold_it() { grep -q '^#.*CHANGE_ME' "$ETC/ota-backend.env" && grep -q '^#.*CHANGE_ME' "$ETC/platform-backend.env"; }
deploy "$R30"
r30_live() { rc_is 0 && current_is "$R30" && unit_marker_is r30 && caddy_marker_is r30 && serving "$R30"; }
check "with real values and CHANGE_ME only in comments (a commented-out line, the optional file, the templates' header comments), r30 deploys [FIX-W67-KI004 AC3]" \
  all_of header_comments_hold_it r30_live
rm -f "$ETC/platform-worker.env"

# ---- 18. a release without one of its migration sets (KI-035) ---------------------------------------------------
step "18. A release with the migration CLI but without one of its migration sets: refused before anything changes; pack-release.sh fails"
r30_current_unchanged() { current_is "$R30" && nothing_changed; }
for set in platform reference tenant; do
  make_release "r31-$set" "no-migrations=$set"
  R31="$BUILT"
  upload "$R31"
  FP_BEFORE="$(fingerprint "$ROOT")"
  deploy "$R31"
  lacks_set() {
    rc_is 1 && output_has "release lacks migrations/$set (a release with the migration CLI needs migrations/platform, migrations/reference and migrations/tenant). Nothing was changed."
  }
  r31_waits() { [ -d "$SRV/incoming/$R31" ] && [ ! -e "$SRV/releases/$R31" ] && [ ! -e "$LIB/system/$R31" ]; }
  check "an upload without migrations/$set is refused, exit 1, naming it, with 'Nothing was changed.' [FIX-W68-DEPLOYSCRIPT AC1]" \
    lacks_set
  check "nothing changed: current is r30, no snapshot, unit, Caddyfile, root script, migration or systemctl call; the upload waits [FIX-W68-DEPLOYSCRIPT AC1]" \
    all_of r30_current_unchanged nothing_ran r31_waits
  rm -rf "${SRV:?}/incoming/$R31"
done
# A set folder that is a symbolic link counts as missing: SHA256SUMS lists regular files only, so the SQL behind the
# link would run without its checksum ever being verified.
make_release r31-link no-migrations=tenant
R31="$BUILT"
ln -s "$SRV/releases/$R30/migrations/tenant" "$BUILD/$R31/migrations/tenant"
upload "$R31"
FP_BEFORE="$(fingerprint "$ROOT")"
deploy "$R31"
set=tenant
check "an upload whose migrations/tenant is a symbolic link (to r30's) is refused the same way, changing nothing [FIX-W68-DEPLOYSCRIPT AC1]" \
  all_of lacks_set r30_current_unchanged nothing_ran r31_waits
rm -rf "${SRV:?}/incoming/$R31"
# A release already on the VM that lost a set (copied there before this check existed) is refused the same way.
chmod u+w "$SRV/releases/$R30/migrations"
mv "$SRV/releases/$R30/migrations/reference" "$PREFIX/r30-reference"
FP_BEFORE="$(fingerprint "$ROOT")"
deploy "$R30"
set=reference
check "re-deploying r30, already on the VM, without migrations/reference is refused the same way, changing nothing [FIX-W68-DEPLOYSCRIPT AC1]" \
  all_of lacks_set r30_current_unchanged nothing_ran
mv "$PREFIX/r30-reference" "$SRV/releases/$R30/migrations/reference"
chmod u-w "$SRV/releases/$R30/migrations"

# pack-release.sh, run as it is from a copy in a small workspace: the migration sets of the repository, the migration
# CLI's package.json, a stand-in for build-caddy.sh and a pnpm on PATH that only records `pnpm deploy` and writes a
# package. Nothing else of the repository is needed: every app the workspace lacks is skipped, as pack-release.sh does.
PACK_WS="$PREFIX/pack-ws"
mkdir -p "$PACK_WS/deploy/scripts" "$PACK_WS/deploy/caddy/build" "$PACK_WS/packages/db" "$PACK_WS/bin"
cp "$DEPLOY/scripts/pack-release.sh" "$PACK_WS/deploy/scripts/pack-release.sh"
printf '{ "name": "@velexis/db", "private": true }\n' >"$PACK_WS/packages/db/package.json"
cat >"$PACK_WS/deploy/caddy/build/build-caddy.sh" <<'SH'
#!/usr/bin/env bash
# deploy.test.sh's build-caddy.sh: writes a stand-in binary into the output folder.
set -euo pipefail
mkdir -p "$1"
printf '#!/bin/sh\necho fake caddy\n' >"$1/caddy"
chmod 0755 "$1/caddy"
SH
cat >"$PACK_WS/bin/pnpm" <<'SH'
#!/usr/bin/env bash
# deploy.test.sh's pnpm for pack-release.sh: `pnpm --filter <name> deploy --prod <dest>` writes a package into <dest>.
set -euo pipefail
printf '%s\n' "$*" >>"$PACK_LOG"
[ "${1:-}" = --filter ] && [ "${3:-}" = deploy ] && [ "${4:-}" = --prod ] || { echo "fake pnpm: unexpected $*" >&2; exit 2; }
mkdir -p "$5/dist/cli"
printf '{ "name": "%s" }\n' "$2" >"$5/package.json"
printf '// fake migration CLI\n' >"$5/dist/cli/migrate.js"
SH
chmod 0755 "$PACK_WS/bin/pnpm"
PACK_SHA="$(sha_of pack)"
pack() { # -> PACK_RC, PACK_OUT (output of pack-release.sh); the release goes to $PACK_WS/out/<sha>
  PACK_RC=0
  PACK_OUT="$OUT/pack-$((RUNS + 1)).log"
  RUNS=$((RUNS + 1))
  env PATH="$PACK_WS/bin:$FAKEBIN:$PATH" PACK_LOG="$PACK_WS/pnpm.log" RELEASE_SHA="$PACK_SHA" RELEASE_REF=deploy.test.sh \
    bash "$PACK_WS/deploy/scripts/pack-release.sh" "$PACK_WS/out" </dev/null >"$PACK_OUT" 2>&1 || PACK_RC=$?
}
PACK_SETS=("platform platform/backend/migrations/platform" "reference platform/backend/migrations/reference"
  "tenant ota/backend/migrations/tenant")
for entry in "${PACK_SETS[@]}"; do
  read -r set src <<<"$entry"
  mkdir -p "$PACK_WS/$src"
  printf -- '-- the %s baseline of the pack workspace\n' "$set" >"$PACK_WS/$src/0001_baseline.sql"
done
pack
PACKED="$PACK_WS/out/$PACK_SHA"
packed_all_sets() {
  local entry set src
  [ "$PACK_RC" = 0 ] || return 1
  for entry in "${PACK_SETS[@]}"; do
    read -r set src <<<"$entry"
    same_file "$PACK_WS/$src/0001_baseline.sql" "$PACKED/migrations/$set/0001_baseline.sql" || return 1
  done
  (cd "$PACKED" && sha256sum --quiet --strict -c SHA256SUMS) && grep -q '\./db/dist/cli/migrate.js$' "$PACKED/SHA256SUMS"
}
check "pack-release.sh packs migrations/platform, migrations/reference and migrations/tenant beside the migration CLI, every file in SHA256SUMS [FIX-W68-DEPLOYSCRIPT AC1]" \
  packed_all_sets
for entry in "${PACK_SETS[@]}"; do
  read -r set src <<<"$entry"
  mv "$PACK_WS/$src" "$PACK_WS/$src.away"
  rm -rf "${PACK_WS:?}/out" "$PACK_WS/pnpm.log"
  pack
  pack_refused() {
    [ "$PACK_RC" = 1 ] &&
      grep -qxF "ERROR: $src is missing: a release with the migration CLI (packages/db) needs migrations/$set, and velexis-deploy refuses one without it" "$PACK_OUT" &&
      [ ! -e "$PACK_WS/out" ] && [ ! -e "$PACK_WS/pnpm.log" ]
  }
  check "pack-release.sh without $src fails (exit 1, naming it) before it packs anything: no release folder, no pnpm deploy [FIX-W68-DEPLOYSCRIPT AC1]" \
    pack_refused
  mv "$PACK_WS/$src.away" "$PACK_WS/$src"
done

# ---- 19. --status while a deploy holds the lock (KI-038) ---------------------------------------------------------
step "19. velexis-deploy --status while a deploy holds the lock: the status, exit 0, nothing in deploy.log"
# The test's own shell holds the lock, as a running deploy does (flock on its own open file of the lock).
exec 8>"$LOCK"
flock -n 8 || die "could not take $LOCK for the test"
cp -p "$LOGS/deploy.log" "$PREFIX/deploy.log.before"
deploy --status
status_during_deploy() {
  rc_is 0 && output_has "current: $SRV/releases/$R30" && [ "$(grep -c ' active$' "$DEPLOY_LOG")" = 7 ] &&
    not output_has "ERROR"
}
log_untouched() { same_file "$PREFIX/deploy.log.before" "$LOGS/deploy.log"; }
check "--status during a deploy prints current releases/r30 and seven active units, exits 0, and prints no ERROR [FIX-W68-DEPLOYSCRIPT AC3]" \
  status_during_deploy
check "--status writes nothing to deploy.log (no 'ERROR: another deploy is running') [FIX-W68-DEPLOYSCRIPT AC3]" log_untouched
upload "$R30"
deploy "$R30"
locked_out() { rc_is 1 && output_has "ERROR: another deploy is running"; }
check "a deploy during the other one's lock is still refused: 'another deploy is running', exit 1 [FIX-W68-DEPLOYSCRIPT AC3]" \
  locked_out
rm -rf "${SRV:?}/incoming/$R30"
flock -u 8
exec 8>&-

# ---- 20. the rollback's checks of its target (KI-041) ------------------------------------------------------------
step "20. --rollback and the automatic rollback check their target's env templates first and refuse before switching; another Node major is only noted"
OTA_ENV="$ETC/ota-backend.env"
# r35's template renames TRUST_PROXY to X068_RENAMED; the developer adds the new name and removes the old one.
make_release r35 unit=r35 caddy=r35 env-var=ota-backend:X068_RENAMED env-drop=ota-backend:TRUST_PROXY
R35="$BUILT"
upload "$R35"
printf 'X068_RENAMED=\n' >>"$OTA_ENV"
cp -p "$OTA_ENV" "$PREFIX/ota-backend.env.both"
sed -i '/^TRUST_PROXY=/d' "$OTA_ENV"
deploy "$R35"
r35_live() { rc_is 0 && current_is "$R35" && unit_marker_is r35 && serving "$R35"; }
check "r35, whose template renamed TRUST_PROXY, deploys with the new name only [FIX-W68-DEPLOYSCRIPT AC4]" r35_live
r35_untouched() { current_is "$R35" && nothing_changed; }
FP_BEFORE="$(fingerprint "$ROOT")"
deploy --rollback
rollback_env_refused() {
  rc_is 1 &&
    output_has "rollback to $R30 refused: env files lack variables of release $R30's templates: ota-backend.env:TRUST_PROXY (add them to /etc/velexis, empty is allowed). Nothing was changed." &&
    not output_has "ROLLBACK to"
}
check "--rollback to r30, whose template still names TRUST_PROXY, is refused naming ota-backend.env:TRUST_PROXY, exit 1 [FIX-W68-DEPLOYSCRIPT AC4]" \
  rollback_env_refused
check "nothing changed: current is r35, no unit, Caddyfile or snapshot staged, no systemctl call [FIX-W68-DEPLOYSCRIPT AC4]" \
  all_of r35_untouched nothing_ran
# r30's RELEASE.json as if it had been built with another Node major (the VM's Node changed since it ran): a rollback
# across majors is not refused (ADR-0029 item 10, decision D12: every native module is N-API), only noted in the log;
# with TRUST_PROXY back, r30's env check passes.
cp -p "$PREFIX/ota-backend.env.both" "$OTA_ENV"
cp -p "$SRV/releases/$R30/RELEASE.json" "$PREFIX/r30-RELEASE.json"
chmod u+w "$SRV/releases/$R30/RELEASE.json"
sed -i -E 's/"node": "[^"]*"/"node": "v18.20.4"/' "$SRV/releases/$R30/RELEASE.json"
chmod u-w "$SRV/releases/$R30/RELEASE.json"
deploy --rollback
rollback_across_majors() {
  rc_is 0 &&
    output_has "note: release $R30 was built with Node v18 and the VM runs $VM_NODE; a rollback does not refuse that (ADR-0029 item 10, D12: every native module is N-API)" &&
    output_has "ROLLBACK to $R30" && current_is "$R30" && all_active && serving "$R30"
}
check "--rollback to r30, whose RELEASE.json names Node v18, is not refused (ADR-0029 D12): it notes both majors, switches, and every unit answers for r30 [FIX-W68-DEPLOYSCRIPT AC4]" \
  rollback_across_majors
chmod u+w "$SRV/releases/$R30/RELEASE.json"
cp "$PREFIX/r30-RELEASE.json" "$SRV/releases/$R30/RELEASE.json"
chmod u-w "$SRV/releases/$R30/RELEASE.json"
deploy "$R35"
check "re-deploying r35 (already on the VM) makes it current again [FIX-W68-DEPLOYSCRIPT AC4]" r35_live
# The automatic rollback: r36 (the repository's templates, without X068_RENAMED) is unhealthy, and the developer has
# removed X068_RENAMED, which r35, the release it would roll back to, still needs.
make_release r36 unit=r36 caddy=r36 unhealthy
R36="$BUILT"
upload "$R36"
sed -i '/^X068_RENAMED=/d' "$OTA_ENV"
deploy "$R36"
auto_refused() {
  rc_is 1 &&
    output_has "deploy of $R36 failed health checks, and the automatic rollback to $R35 was refused before anything was switched back: env files lack variables of release $R35's templates: ota-backend.env:X068_RENAMED (add them to /etc/velexis, empty is allowed). $R36 stays current (the units restarted so far run it, the first unhealthy one is down); fix that, then run: sudo velexis-deploy --rollback (to $R35), or deploy a release that works" &&
    not output_has "ROLLBACK to"
}
r36_stays() {
  current_is "$R36" && [ "$(restart_order)" = velexis-platform-worker ] && every_restart_of "$R36" &&
    [ "$(calls_matching '^daemon-reload')" = 1 ] && unit_marker_is r36 && caddy_marker_is r35 && no_staged_caddyfile &&
    history_ends_with "$R35" && ! grep -q " $R36" "$LIB/deploy-history"
}
check "an unhealthy r36 whose rollback target r35 lacks ota-backend.env:X068_RENAMED: exit 1, the message names both releases, the reason and the way back [FIX-W68-DEPLOYSCRIPT AC4]" \
  auto_refused
check "nothing was switched back: r36 stays current with its units, only its first unit restarted, r35's Caddyfile stays live, r36's staged one is dropped, no history entry [FIX-W68-DEPLOYSCRIPT AC4]" \
  r36_stays
printf 'X068_RENAMED=\n' >>"$OTA_ENV"
deploy --rollback
back_to_r35() { rc_is 0 && output_has "ROLLBACK to $R35" && current_is "$R35" && all_active && serving "$R35"; }
check "with X068_RENAMED back, the --rollback the message names goes back to r35, and every unit answers for it [FIX-W68-DEPLOYSCRIPT AC4]" \
  back_to_r35

# ---- 21. a failed redeploy of the active release (KI-042) --------------------------------------------------------
step "21. Re-deploying the active release r35, which now fails its health checks: no rollback, the way back named"
chmod u+w "$SRV/releases/$R35"
: >"$SRV/releases/$R35/FAKE_UNHEALTHY"
chmod u-w "$SRV/releases/$R35"
cp -p "$LIB/deploy-history" "$PREFIX/deploy-history.before"
deploy "$R35"
redeploy_failed() {
  rc_is 1 &&
    output_has "deploy of $R35 failed health checks; $R35 was already the active release, so nothing was rolled back and it stays current. To go back to the release before it ($R30 in $VM_ROOT/var/lib/velexis/deploy-history), run: sudo velexis-deploy --rollback" &&
    not output_has "no other release was active" && not output_has "ROLLBACK to"
}
redeploy_no_rollback() {
  current_is "$R35" && every_restart_of "$R35" && [ "$(restart_order)" = velexis-platform-worker ] &&
    same_file "$PREFIX/deploy-history.before" "$LIB/deploy-history"
}
check "exit 1: r35 was already the active release, nothing was rolled back, and the message names --rollback and r30, the release before it in deploy-history [FIX-W68-DEPLOYSCRIPT AC5]" \
  redeploy_failed
check "no automatic rollback: r35 stays current, every restart was r35's, the history is unchanged [FIX-W68-DEPLOYSCRIPT AC5]" \
  redeploy_no_rollback
# With a deploy-history that names no release before r35 (as after a VM's first deploy), the message says so.
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$R35" >"$LIB/deploy-history"
deploy "$R35"
redeploy_failed_alone() {
  rc_is 1 &&
    output_has "deploy of $R35 failed health checks; $R35 was already the active release and $VM_ROOT/var/lib/velexis/deploy-history names no release before it, so there is nothing to roll back to" &&
    not output_has "no other release was active" && not output_has "ROLLBACK to" && current_is "$R35"
}
check "exit 1: with no release before r35 in deploy-history, the message says there is nothing to roll back to, and r35 stays current [FIX-W68-DEPLOYSCRIPT AC5]" \
  redeploy_failed_alone
cp -p "$PREFIX/deploy-history.before" "$LIB/deploy-history"
chmod u+w "$SRV/releases/$R35"
rm -f "$SRV/releases/$R35/FAKE_UNHEALTHY"
chmod u-w "$SRV/releases/$R35"
deploy "$R35"
check "healthy again, the same redeploy of r35 succeeds [FIX-W68-DEPLOYSCRIPT AC5]" r35_live

# ---- 22. CHANGE_ME in every assignment systemd reads (lead decision (37m)) ---------------------------------------
step "22. CHANGE_ME in indented, spaced, continued and quoted assignments: refused; in indented comments: deployed"
make_release r37 unit=r37 caddy=r37
R37="$BUILT"
upload "$R37"
for f in platform-backend.env alert.env; do cp -p "$ETC/$f" "$PREFIX/$f.filled"; done
# systemd 255's EnvironmentFile= reads each of these as an assignment: blanks before the name and around '=', a value
# continued with a backslash, and a double-quoted value over two lines (whose second line looks like a comment).
printf '   SMTP_URL=smtps://CHANGE_ME_USER:p-%s@smtp.example.com:465\n' "$TOKEN" >>"$ETC/platform-backend.env"
printf 'ALERT_SMTP_PASSWORD = CHANGE_ME\n' >>"$ETC/alert.env"
( umask 077; printf '\tLOG_LEVEL=debug-CHANGE_ME\nX068_JOINED=abc\\\nCHANGE_ME\nX068_QUOTED="first\n# CHANGE_ME"\n' >"$ETC/platform-worker.env" )
FP_BEFORE="$(fingerprint "$ROOT")"
deploy "$R37"
SPACED_NAMED="env files hold values still at the templates' CHANGE_ME placeholders: alert.env:ALERT_SMTP_PASSWORD platform-backend.env:SMTP_URL platform-worker.env:LOG_LEVEL platform-worker.env:X068_JOINED platform-worker.env:X068_QUOTED."
spaced_refused() { rc_is 1 && output_has "$SPACED_NAMED" && output_has "Nothing was changed."; }
spaced_no_value() { not output_has "p-$TOKEN" && not output_has "smtp.example.com" && not output_has "debug-CHANGE_ME"; }
r35_current_unchanged() { current_is "$R35" && nothing_changed; }
check "an indented SMTP_URL, 'ALERT_SMTP_PASSWORD = CHANGE_ME', a tab-indented LOG_LEVEL, a continued and a two-line quoted value are refused, each named as file:VARIABLE [FIX-W68-DEPLOYSCRIPT AC6]" \
  spaced_refused
check "no value shown, nothing changed, no systemctl call [FIX-W68-DEPLOYSCRIPT AC6]" \
  all_of spaced_no_value r35_current_unchanged nothing_ran
for f in platform-backend.env alert.env; do cp -p "$PREFIX/$f.filled" "$ETC/$f"; done
printf '   # SMTP_URL=smtps://CHANGE_ME_USER:CHANGE_ME_PASSWORD@smtp.example.com:465\n' >>"$ETC/platform-backend.env"
printf '\t; ALERT_SMTP_PASSWORD=CHANGE_ME\n' >>"$ETC/alert.env"
( umask 077; printf '  # LOG_LEVEL=debug-CHANGE_ME\n\t# X068_JOINED=CHANGE_ME\n' >"$ETC/platform-worker.env" )
deploy "$R37"
r37_live() { rc_is 0 && current_is "$R37" && unit_marker_is r37 && serving "$R37"; }
check "with CHANGE_ME only in indented comments (# and ;), r37 deploys [FIX-W68-DEPLOYSCRIPT AC6]" r37_live
rm -f "$ETC/platform-worker.env"
copies_identical() {
  local f first=""
  for f in deploy check-vm provision-vm; do
    [ -n "$(sed -n '/^placeholder_names() {/,/^}/p' "$DEPLOY/scripts/$f.sh")" ] || return 1
    [ -n "$first" ] || first="$(sed -n '/^placeholder_names() {/,/^}/p' "$DEPLOY/scripts/$f.sh")"
    [ "$(sed -n '/^placeholder_names() {/,/^}/p' "$DEPLOY/scripts/$f.sh")" = "$first" ] || return 1
  done
}
check "deploy.sh, check-vm.sh and provision-vm.sh hold the same placeholder_names [FIX-W68-DEPLOYSCRIPT AC6]" copies_identical

# ---- over the whole run -----------------------------------------------------------------------------------------------------
step "Over the whole run"
DEPLOY_LOG=""
check "no DSN or secret of the env files in any deploy.sh output, deploy log, command line or fake log [X-023 AC1]" \
  not grep -rqF "$TOKEN" "$OUT" "$LOGS" "$STATE"
check "no unit was restarted from a file that changed on disk without a daemon-reload, Caddy with its drop-in included [X-023 AC1] [FIX-W52-SHARED 21k]" \
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
