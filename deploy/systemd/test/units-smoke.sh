#!/usr/bin/env bash
# =====================================================================================================
# units-smoke.sh — runs the real unit files of deploy/systemd/ under systemd with a stand-in app, on the layout that
# provision-vm.sh creates (tasks X-021 and X-033).
#
#   sudo env SMOKE_NODE="$(command -v node)" bash deploy/systemd/test/units-smoke.sh
#
# Needs root, systemd as PID 1, Node 22 (SMOKE_NODE; the units run a root-owned copy of it), openssl, PostgreSQL and
# Redis on loopback, outbound DNS and HTTPS, and a Mailpit. CI runs it in the "systemd-units" job of
# .github/workflows/ci.yml (ubuntu-24.04 runner, PostgreSQL, Redis and Mailpit service containers). On a
# throwaway VM, start Mailpit first (mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025). Never run it on
# the production VM: it stops nothing there, but it creates and removes test units, users and folders. Without
# systemd as PID 1 it runs steps 1 to 3 and then fails.
#
# What it proves (docs/mvp/plans/foundation-tasks.md; a check that proves an acceptance criterion ends in
# [<task> AC<n>]):
#   1. `systemd-analyze security --offline=true` rates every app unit and velexis-alert@ 2.0 or lower (X-021).
#   2. provision-vm.sh --steps users,keys,envfiles, run twice with VELEXIS_ROOT=<temporary prefix>, creates the five
#      zone users of ADR-0026 (no shell, locked password) and the group velexis with exactly those members, the
#      folders of deployment-single-vm.md §4, both key folders (0500, files 0400 owned by the zone's user) with
#      identical master-key and pepper copies, and env files root:root 0600 with one DSN per one-off process. The
#      second run changes no key, env or secrets file (content, inode, times, owner, mode). Every app unit names
#      its zone's user and SupplementaryGroups=velexis. deploy.sh starts every migrate.js and load.js through
#      run_transient with its own env file and never loads a DSN file into its own environment (X-033).
#   3. The OS user boundary on the host, with no sandbox at all: velexis-portal is denied the environment and the
#      root of a velexis-ota process ("Permission denied"), file modes alone deny every zone user every env file,
#      root's files and the other zones' keys, and velexis-platform cannot list the OTA key folder. A process of
#      the same user can read that environment: the reason why each zone has its own user (X-033).
#   4. All seven app units start from the templates with only their paths changed: /srv/velexis, /etc/velexis,
#      /var/lib/velexis and /usr/local/sbin/velexis-* move under the prefix, /usr/bin/node becomes <prefix>/bin/node,
#      CacheDirectory gets a test name, the units are renamed velexis-smoke-*, and OnFailure= points at a renamed
#      copy of velexis-alert@. Every sandboxing line is the production one (X-021).
#   5. The stand-in app (dist/main.js, dist/worker.js, <app>/server.js) checks at start-up what the real apps need:
#      its release folder (through the velexis group), the key files named by its env file (backends), PostgreSQL
#      and Redis (a protocol round trip), DNS and an HTTPS host outside the VM, os.cpus() and os.networkInterfaces().
#      It also tries the paths of SMOKE_FORBIDDEN (every env file, root's files, the other zones' keys), which must
#      fail with EACCES ("Permission denied") or ENOENT ("No such file") (X-021). It reports the names of the
#      variables it sees, never their values, and every unit sees every variable of its env files (X-033).
#   6. Cross-zone, from inside the units: the portal stand-in is denied the OTA API's /proc/<pid>/environ and
#      /proc/<pid>/root/etc/velexis/keys/ota/master-v1.key (ENOENT: its ProtectProc=invisible /proc has no such
#      process) and every env file, and the platform API stand-in cannot list the OTA key folder (X-033).
#   7. Defence in depth: in each unit's mount namespace every existing path of its InaccessiblePaths= is an
#      inaccessible node (mode 000), whatever the owner and mode of the real file (X-021, ADR-0026).
#   8. A migration started the way velexis-deploy starts it (deploy.sh's own run_transient function: a transient
#      unit, DynamicUser=yes, migrator.env read by systemd) runs as a dynamic user that only has the velexis group
#      added. While it runs, no process of an app user has DATABASE_MIGRATOR_URL in its environment and no command
#      line holds the DSN. The reference loader gets reference-loader.env and its one DSN; exit codes pass (X-033).
#   9. velexis-run (run-as.sh, pointed at the test units) runs `node -e "process.exit(3)"` as velexis-platform and
#      exits 3; the command gets the zone's working directory and variables and the unit's sandbox (X-033).
#  10. Killing the OTA API unit (at most 11 times within 300 s) puts it in failed through StartLimitBurst=10, and
#      velexis-alert@ mails Mailpit the unit name, its status and its last log lines, exactly once
#      (RestartMode=direct keeps the crashes before the start limit from triggering OnFailure=) (X-021).
#  11. A random canary value sits in every env file. Neither it nor any value of .provision-secrets appears in the
#      journal, the mail or the outputs of the one-off commands (X-021, X-033).
#
# Settings (environment), with defaults: SMOKE_NODE (node on PATH), SMOKE_PG (127.0.0.1:5432), SMOKE_REDIS
# (127.0.0.1:6379), SMOKE_HTTPS_URL (https://api.github.com/), SMOKE_SMTP_URL (smtp://127.0.0.1:1025),
# MAILPIT_API_URL (http://127.0.0.1:8025), SMOKE_SMTP_TLS (ALERT_SMTP_TLS of the test alert.env: none),
# SMOKE_NODE_EXTRA_CA_CERTS (a CA bundle, only where an egress proxy re-signs TLS), SMOKE_KEEP=1 (keep the
# prefix, the test units and users for inspection).
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/../.." && pwd)"
UNITS="$DEPLOY/systemd"

PG="${SMOKE_PG:-127.0.0.1:5432}"
REDIS="${SMOKE_REDIS:-127.0.0.1:6379}"
HTTPS_URL="${SMOKE_HTTPS_URL:-https://api.github.com/}"
SMTP_URL="${SMOKE_SMTP_URL:-smtp://127.0.0.1:1025}"
MAILPIT="${MAILPIT_API_URL:-http://127.0.0.1:8025}"
APP_UNITS=(velexis-platform-api velexis-platform-worker velexis-portal velexis-platform-admin
  velexis-ota-api velexis-ota-worker velexis-ota-admin)
SANDBOXED_UNITS=("${APP_UNITS[@]}" velexis-alert@) # the alert unit is held to the same limit
# The users of ADR-0026, and the zone of every app unit. The unit files must say the same.
ZONE_USERS=(velexis-platform velexis-ota velexis-portal velexis-platform-admin velexis-ota-admin)
declare -A ZONE_OF=(
  [velexis-platform-api]=velexis-platform [velexis-platform-worker]=velexis-platform
  [velexis-ota-api]=velexis-ota [velexis-ota-worker]=velexis-ota
  [velexis-portal]=velexis-portal [velexis-platform-admin]=velexis-platform-admin
  [velexis-ota-admin]=velexis-ota-admin
)
BACKEND=velexis-ota-api # the unit killed into failed (X-021) and the OTA process of the cross-zone checks (X-033)
FRONTEND=velexis-portal
PLATFORM=velexis-platform-api
MAX_EXPOSURE=20 # systemd-analyze --threshold counts in tenths: 20 is 2.0
MAX_KILLS=11
DYNAMIC_UID_MIN=61184 # systemd's range for DynamicUser= (systemd.exec(5))
DYNAMIC_UID_MAX=65519

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
denied() { case "$1" in EACCES | ENOENT | ESRCH) return 0 ;; *) return 1 ;; esac; }
mode_is() { [ "$(stat -c '%U:%G %a' "$1")" = "$2" ]; } # path "user:group octal"
unit_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }   # file key -> its last value
unit_values() { sed -n "s/^$2=//p" "$1"; }              # file key -> every value, one per line
short() { printf '%s' "${1/#"$PREFIX"/<prefix>}"; }     # a path for the output

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
NODE="$(readlink -f "${SMOKE_NODE:-$(command -v node || true)}")"
[ -x "$NODE" ] || die "node not found: set SMOKE_NODE"
for tool in curl runuser setpriv nsenter useradd getent openssl visudo mkfifo systemd-analyze; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done

# ---- 1. sandbox exposure ------------------------------------------------------------------------------------
step "systemd-analyze security --offline=true: every app unit and velexis-alert@ must be 2.0 or lower"
for u in "${SANDBOXED_UNITS[@]}"; do
  if out="$(systemd-analyze security --offline=true --threshold="$MAX_EXPOSURE" --no-pager \
              "$UNITS/$u.service" 2>&1)"; then
    pass "$(printf '%s\n' "$out" | grep 'Overall exposure level' | sed 's/^→ //') [X-021 AC1]"
  else
    printf '%s\n' "$out" | grep -E '✗|Overall' || true
    fail "$u.service is above 2.0 [X-021 AC1]"
  fi
done

# ---- 2. provision-vm.sh under a temporary prefix --------------------------------------------------------------
mkdir -p /opt
PREFIX="$(mktemp -d /opt/velexis-smoke.XXXXXX)"
chmod 0755 "$PREFIX"
RUN_ID="${PREFIX##*.}"
RUN_ID_LC="$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
CACHE_BASE="velexis-smoke.$RUN_ID"
STATE_NAME="velexis-smoke-migrate.$RUN_ID" # StateDirectory= of the test one-offs (velexis-migrate on the VM)
ETC="$PREFIX/etc/velexis"
SRV="$PREFIX/srv/velexis"
LIB="$PREFIX/var/lib/velexis"
SBIN="$PREFIX/usr/local/sbin"
REL="$SRV/releases/smoke"
DEPLOY_TEST_USER="vxsmoke-$RUN_ID_LC" # the deploy user of the test provisioning (provision-vm.sh needs one)
ALERT_TO="ops-smoke-$RUN_ID@example.com"
CANARY="canary-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
B_UNIT="velexis-smoke-${BACKEND#velexis-}.service"
F_UNIT="velexis-smoke-${FRONTEND#velexis-}.service"
P_UNIT="velexis-smoke-${PLATFORM#velexis-}.service"
A_TEMPLATE=velexis-smoke-alert@.service
A_UNIT="velexis-smoke-alert@$B_UNIT.service"
SMOKE_UNITS=()
CREATED_USERS=()
CREATED_GROUPS=()
VICTIM=""
ONEOFF_PID=""

cleanup() {
  local rc=$? u g
  [ -z "$VICTIM" ] || kill "$VICTIM" >/dev/null 2>&1 || true
  [ -z "$ONEOFF_PID" ] || kill "$ONEOFF_PID" >/dev/null 2>&1 || true
  if [ "${SMOKE_KEEP:-0}" = 1 ]; then
    echo "SMOKE_KEEP=1: kept $PREFIX, /etc/systemd/system/velexis-smoke-*, /var/cache/$CACHE_BASE," \
      "/var/lib/$STATE_NAME and the users ${CREATED_USERS[*]:-(none created)}"
    exit "$rc"
  fi
  if [ -d /run/systemd/system ]; then
    systemctl stop "${SMOKE_UNITS[@]}" "$A_UNIT" >/dev/null 2>&1 || true
    systemctl reset-failed "${SMOKE_UNITS[@]}" "$A_UNIT" >/dev/null 2>&1 || true
    for u in "${SMOKE_UNITS[@]}" "$A_TEMPLATE"; do rm -f "/etc/systemd/system/$u"; done
    systemctl daemon-reload || true
  fi
  rm -rf --one-file-system "$PREFIX" "/var/cache/$CACHE_BASE" "/var/lib/$STATE_NAME" "/var/lib/private/$STATE_NAME"
  for u in "${CREATED_USERS[@]}"; do userdel -r "$u" >/dev/null 2>&1 || true; done
  for g in "${CREATED_GROUPS[@]}"; do ! getent group "$g" >/dev/null || groupdel "$g" >/dev/null 2>&1 || true; done
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Users and the group that exist before this test (a throwaway VM that is already provisioned) are left alone.
for u in "${ZONE_USERS[@]}" "$DEPLOY_TEST_USER"; do id -u "$u" >/dev/null 2>&1 || CREATED_USERS+=("$u"); done
getent group velexis >/dev/null || CREATED_GROUPS+=(velexis)

step "provision-vm.sh --steps users,keys,envfiles with VELEXIS_ROOT=$PREFIX, twice"
provision() { # log file
  VELEXIS_ROOT="$PREFIX" DEPLOY_USER="$DEPLOY_TEST_USER" DEPLOY_SSH_PUBKEY_FILE='' \
    bash "$DEPLOY/scripts/provision-vm.sh" --steps users,keys,envfiles >"$1" 2>&1
}
fingerprint() { # every file under /etc/velexis: path, inode, modification and change times, mode, owner, SHA-256
  find "$ETC" -type f -printf '%p %i %T@ %C@ %m %u:%g\n' | sort
  find "$ETC" -type f -exec sha256sum {} + | sort -k 2
}
provision "$PREFIX/provision-1.log" || { cat "$PREFIX/provision-1.log"; die "provision-vm.sh failed"; }
sed "s#$PREFIX#<prefix>#g" "$PREFIX/provision-1.log" # names and paths only: it never prints a secret value
FP1="$(fingerprint)"
provision "$PREFIX/provision-2.log" || { cat "$PREFIX/provision-2.log"; die "the second provision-vm.sh run failed"; }
FP2="$(fingerprint)"

user_ok() { # user: no login shell, password locked
  local shell pw
  shell="$(getent passwd "$1" | cut -d: -f7)"
  pw="$(getent shadow "$1" | cut -d: -f2)"
  [ "$shell" = /usr/sbin/nologin ] && case "$pw" in '!'* | '*'*) true ;; *) false ;; esac
}
for u in "${ZONE_USERS[@]}"; do
  check "user $u: shell /usr/sbin/nologin, password locked [X-033]" user_ok "$u"
done
members="$(getent group velexis | cut -d: -f4 | tr ',' '\n' | sort | paste -sd, -)"
check "group velexis has exactly the five zone users as members: $members [X-033]" \
  test "$members" = "$(printf '%s\n' "${ZONE_USERS[@]}" | sort | paste -sd, -)"
velexis_gid="$(getent group velexis | cut -d: -f3)"
check "no account has velexis as its primary group [X-033]" \
  test -z "$(getent passwd | awk -F: -v gid="$velexis_gid" '$4 == gid')"
while read -r path want; do
  check "$(short "$path") is $want [X-033]" mode_is "$path" "$want"
done <<EOF
$ETC root:root 711
$ETC/keys root:root 711
$ETC/keys/platform velexis-platform:velexis-platform 500
$ETC/keys/ota velexis-ota:velexis-ota 500
$ETC/backup root:root 700
$SRV/releases root:velexis 751
$LIB root:root 711
$LIB/storage velexis-ota:velexis-ota 700
EOF

key_files_ok() { # folder owner file... -> exactly these files, each 0400 and owned by owner:owner
  local dir="$1" owner="$2" f
  shift 2
  [ "$(find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | paste -sd' ' -)" = \
    "$(printf '%s\n' "$@" | sort | paste -sd' ' -)" ] || return 1
  for f in "$@"; do mode_is "$dir/$f" "$owner:$owner 400" || return 1; done
}
same_sha() { [ "$(sha256sum <"$1")" = "$(sha256sum <"$2")" ]; }
check "keys/platform: master-v1.key, api-key-pepper, platform-jwt-ed25519.pem, each 0400 velexis-platform [X-033 AC2]" \
  key_files_ok "$ETC/keys/platform" velexis-platform master-v1.key api-key-pepper platform-jwt-ed25519.pem
check "keys/ota: master-v1.key, api-key-pepper, ota-jwt-ed25519.pem, document-url.key, 0400 velexis-ota [X-033 AC2]" \
  key_files_ok "$ETC/keys/ota" velexis-ota master-v1.key api-key-pepper ota-jwt-ed25519.pem document-url.key
for k in master-v1.key api-key-pepper; do
  check "$k: the copies in keys/platform and keys/ota have the same SHA-256 [X-033 AC2]" \
    same_sha "$ETC/keys/platform/$k" "$ETC/keys/ota/$k"
done
check "the platform and OTA JWT signing keys differ [X-033]" \
  not same_sha "$ETC/keys/platform/platform-jwt-ed25519.pem" "$ETC/keys/ota/ota-jwt-ed25519.pem"
if [ "$FP1" = "$FP2" ]; then
  pass "the second run changed none of the $(find "$ETC" -type f | wc -l) key, env and secrets files" \
    "(content, inode, times, owner, mode) [X-033 AC2]"
else
  diff <(printf '%s\n' "$FP1") <(printf '%s\n' "$FP2") | sed -E "s/[0-9a-f]{64}/<sha256>/; s#$PREFIX#<prefix>#g" || true
  fail "the second provision-vm.sh run changed files in /etc/velexis [X-033 AC2]"
fi

ENV_FILES=("$ETC"/*.env)
env_files_ok() {
  local tpl f ok=0
  for tpl in "$DEPLOY"/env/*.env.example; do
    f="$ETC/$(basename "$tpl" .example)"
    [ -f "$f" ] || { echo "     missing: $(short "$f")"; ok=1; continue; }
    mode_is "$f" "root:root 600" || { echo "     $(short "$f"): $(stat -c '%U:%G %a' "$f")"; ok=1; }
  done
  return "$ok"
}
check "every env file (${#ENV_FILES[@]}, one per deploy/env template) is root:root 0600 [X-033 AC3]" env_files_ok
check ".provision-secrets is root:root 0600 [X-033]" mode_is "$ETC/.provision-secrets" "root:root 600"
one_dsn() { # env file variable -> the file holds exactly one PostgreSQL DSN, in that variable
  [ "$(grep -cE '^[A-Z0-9_]+=postgres(ql)?://' "$1")" = 1 ] && grep -qE "^$2=postgres(ql)?://" "$1"
}
check "migrator.env holds one DSN, DATABASE_MIGRATOR_URL [X-033]" one_dsn "$ETC/migrator.env" DATABASE_MIGRATOR_URL
check "reference-loader.env holds one DSN, DATABASE_URL (platform role) [X-033]" \
  one_dsn "$ETC/reference-loader.env" DATABASE_URL

unit_zone_ok() { # template user
  [ "$(unit_value "$1" User)" = "$2" ] && [ "$(unit_value "$1" Group)" = "$2" ] &&
    [ "$(unit_value "$1" SupplementaryGroups)" = velexis ]
}
for u in "${APP_UNITS[@]}"; do
  check "$u.service: User=Group=${ZONE_OF[$u]}, SupplementaryGroups=velexis [X-033]" \
    unit_zone_ok "$UNITS/$u.service" "${ZONE_OF[$u]}"
done

# Step 8 runs deploy.sh's run_transient under systemd; these checks tie it to deploy.sh's own call sites, so a
# migration started any other way (runuser, the env file loaded into velexis-deploy) fails here, even without systemd.
deploy_code() { # deploy.sh without comment lines, continuation lines joined
  sed -e ':a' -e '/\\$/N' -e 's/[[:space:]]*\\\n[[:space:]]*/ /' -e 'ta' "$DEPLOY/scripts/deploy.sh" | grep -vE '^[[:space:]]*#'
}
oneoffs_via_run_transient() { # every migrate.js and load.js call: run_transient with its own env file and folder
  local line kinds="" ok=0
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    # shellcheck disable=SC2016 # the literal text of deploy.sh, not expansions
    case "$line" in
      'run_transient /etc/velexis/migrator.env "$REL/db" node dist/cli/migrate.js '*) kinds="$kinds migrate" ;;
      'run_transient /etc/velexis/reference-loader.env "$REL/reference-data" node dist/cli/load.js '*)
        kinds="$kinds load" ;;
      *) echo "     not started through run_transient: $line"; ok=1 ;;
    esac
  done < <(deploy_code | grep -E 'dist/cli/(migrate|load)\.js' | grep -vE '^[[:space:]]*if \[ -f ')
  [[ "$kinds" == *migrate* && "$kinds" == *load* ]] || { echo "     found:${kinds:- nothing}"; ok=1; }
  return "$ok"
}
no_dsn_in_deploy() { # velexis-deploy never names a DSN variable or loads a DSN file into its own environment
  local found load='(load_env_file|source|^[[:space:]]*\.|[;&|(][[:space:]]*\.)[[:space:]]+[^[:space:]]*'
  found="$(deploy_code | grep -E \
    "DATABASE_MIGRATOR_URL|REFERENCE_DATABASE_URL|$load(migrator|reference-loader)\.env|runuser|setpriv" || true)"
  [ -z "$found" ] || { printf '     %s\n' "$found"; return 1; }
}
check "deploy.sh runs migrate.js and load.js only through run_transient, each with its own env file [X-033 AC4]" \
  oneoffs_via_run_transient
check "deploy.sh never loads a DSN file into its own environment nor runs a command as an app user [X-033 AC4]" \
  no_dsn_in_deploy

# What each zone must not read: every env file (root:root 0600, also its own: systemd reads them), root's files
# and the keys of the other zones (the Next.js apps: every key).
ROOT_FILES=("$ETC/.provision-secrets" "$ETC/backup")
P_FORBIDDEN=("${ENV_FILES[@]}" "${ROOT_FILES[@]}" "$ETC/keys/ota" "$ETC/keys/ota/master-v1.key")
O_FORBIDDEN=("${ENV_FILES[@]}" "${ROOT_FILES[@]}" "$ETC/keys/platform" "$ETC/keys/platform/platform-jwt-ed25519.pem")
F_FORBIDDEN=("${ENV_FILES[@]}" "${ROOT_FILES[@]}" "$ETC/keys" "$ETC/keys/platform/master-v1.key"
  "$ETC/keys/ota/master-v1.key")

# ---- 3. the OS user boundary on the host, without any sandbox -------------------------------------------------
# The stand-in app (CommonJS, no dependencies). It logs check names and results and variable names, never values,
# and listens only after its start-up checks. `node standin.js --probe <path>` only tries to read the path.
STANDIN="$(cat <<'JS'
'use strict';
// Stand-in for a Velexis app, written by deploy/systemd/test/units-smoke.sh (X-021, X-033).
const fs = require('fs'), os = require('os'), net = require('net'), http = require('http');
const https = require('https'), dns = require('dns').promises;
const env = process.env, results = {};
// Reads a file or lists a folder: READABLE, LISTED or the error code (EACCES, ENOENT, ...). Never the content.
const probe = (p) => {
  try { fs.readFileSync(p); return 'READABLE'; } catch (e) { if (e.code !== 'EISDIR') return e.code || 'ERROR'; }
  try { fs.readdirSync(p); return 'LISTED'; } catch (e) { return e.code || 'ERROR'; }
};
const tcp = (addr, hello, isReply) => new Promise((resolve, reject) => {
  const [host, port] = addr.split(':'), s = net.connect(Number(port), host, () => s.write(hello));
  s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  s.once('error', reject).once('data', (d) => {
    s.destroy();
    if (isReply(d)) resolve(`reply ${JSON.stringify(d.toString('latin1', 0, 1))}`);
    else reject(new Error('unexpected reply'));
  });
});
const read = (p) => {
  try { fs.readFileSync(p); } catch (e) { if (e.code !== 'EISDIR') throw e; fs.readdirSync(p); }
};
const checks = {
  release: () => `${fs.readdirSync('.').length} entries, ${fs.readFileSync(__filename).length} bytes read`,
  keys: () => {
    const files = Object.keys(env).filter((k) => k.endsWith('_FILE')).map((k) => env[k]);
    if (env.MASTER_KEY_DIR) {
      const masters = fs.readdirSync(env.MASTER_KEY_DIR).filter((f) => /^master-v\d+\.key$/.test(f));
      files.push(...masters.map((f) => `${env.MASTER_KEY_DIR}/${f}`));
    }
    files.forEach(read);
    if (env.SMOKE_ROLE === 'backend' && files.length < 2) throw new Error('no key files configured');
    return `${files.length} key files read`;
  },
  // PostgreSQL SSLRequest: the server answers S or N. Redis PING: +PONG, or -NOAUTH with a password set.
  postgres: () => tcp(env.SMOKE_PG, Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]), (d) => d[0] === 83 || d[0] === 78),
  redis: () => tcp(env.SMOKE_REDIS, 'PING\r\n', (d) => d[0] === 43 || d[0] === 45),
  dns: async () => {
    const addresses = await dns.lookup(new URL(env.SMOKE_HTTPS_URL).hostname, { all: true });
    return `${addresses.length} addresses`;
  },
  https: () => new Promise((resolve, reject) => {
    const options = { headers: { 'user-agent': 'velexis-units-smoke' }, timeout: 15000 };
    https.get(env.SMOKE_HTTPS_URL, options, (r) => { r.resume(); resolve(`HTTP ${r.statusCode}`); })
      .on('timeout', function () { this.destroy(new Error('timeout')); }).on('error', reject);
  }),
  os: () => {
    const c = os.cpus().length, n = Object.keys(os.networkInterfaces()).length;
    if (!c || !n) throw new Error(`${c} cpus, ${n} interfaces`);
    return `${c} cpus, ${n} interfaces`;
  },
  forbidden: () => (env.SMOKE_FORBIDDEN || '').split(':').filter(Boolean).map((p) => {
    try { read(p); } catch (e) {
      if (e.code === 'EACCES' || e.code === 'ENOENT') return `${e.code} ${p}`;
      throw new Error(`${e.code} ${p}`);
    }
    throw new Error(`READABLE ${p}`);
  }),
};
const serve = async () => {
  console.log(JSON.stringify({ level: 30, msg: 'stand-in starting', pid: process.pid }));
  for (const [name, check] of Object.entries(checks)) {
    try {
      results[name] = { ok: true, detail: await check() };
    } catch (e) {
      results[name] = { ok: false, detail: e.message };
    }
  }
  const ok = Object.values(results).every((r) => r.ok);
  const summary = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.ok]));
  const envNames = Object.keys(env).sort();
  const msg = ok ? 'stand-in ready' : 'stand-in checks failed';
  console.log(JSON.stringify({ level: ok ? 30 : 50, msg, envNames, checks: summary }));
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health/live') return res.end('ok');
    // Test only: what this process may read, as a code (the cross-zone checks of X-033).
    if (url.pathname === '/probe') return res.end(probe(url.searchParams.get('path') || ''));
    if (url.pathname !== '/health/ready') return res.writeHead(404).end();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok, checks: results, envNames }, null, 1));
  }).listen(Number(env.PORT || env.HEALTH_PORT), env.HOSTNAME || '127.0.0.1');
};
if (process.argv[2] === '--probe') process.stdout.write(probe(process.argv[3]));
else serve();
JS
)"

step "The OS user boundary on the host: no unit, no sandbox, only users and file modes"
install -d -m 0755 "$PREFIX/bin"
# A root-owned copy of node, like /usr/bin/node on the VM: a setup-node or nvm install may not be readable by the
# app users, or may sit under /home, which ProtectHome=yes hides.
install -m 0755 "$NODE" "$PREFIX/bin/node"
printf '%s\n' "$STANDIN" >"$PREFIX/bin/standin.js"
chmod 0644 "$PREFIX/bin/standin.js"
probe_as() { # user path -> READABLE, LISTED or the error code, for that user outside any unit
  (cd / && runuser -u "$1" -- "$PREFIX/bin/node" "$PREFIX/bin/standin.js" --probe "$2") 2>/dev/null || echo FAILED
}
all_denied_as() { # user path... -> true when every path is denied; prints the ones that are not
  local user="$1" p r ok=0
  shift
  for p in "$@"; do
    r="$(probe_as "$user" "$p")"
    denied "$r" || { echo "     $user: $r $(short "$p")"; ok=1; }
  done
  return "$ok"
}
environ_has() { # pid name -> the process's environment has the variable (read by root; names only)
  local env
  env="$(tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null)" || return 1
  case $'\n'"$env" in *$'\n'"$2="*) return 0 ;; *) return 1 ;; esac
}
boundary_checks() { # pid description -> what velexis-portal gets for that velexis-ota process, from the host
  local r
  r="$(probe_as velexis-portal "/proc/$1/environ")"
  check "velexis-portal is denied /proc/<pid>/environ of $2: $r [X-033 AC1]" denied "$r"
  r="$(probe_as velexis-portal "/proc/$1/root/")"
  check "velexis-portal is denied /proc/<pid>/root/ of $2: $r [X-033 AC1]" denied "$r"
  r="$(probe_as velexis-portal "/proc/$1/root$ETC/keys/ota/master-v1.key")"
  check "velexis-portal is denied /proc/<pid>/root/etc/velexis/keys/ota/master-v1.key of $2: $r [X-033 AC1]" \
    denied "$r"
}

(cd / && exec setpriv --reuid=velexis-ota --regid=velexis-ota --init-groups \
  env -i SMOKE_ROLE=boundary "$PREFIX/bin/node" -e 'setInterval(() => {}, 1 << 30)') </dev/null >/dev/null 2>&1 &
VICTIM=$!
victim_up() { [ "$(stat -c %U "/proc/$VICTIM")" = velexis-ota ] && environ_has "$VICTIM" SMOKE_ROLE; }
retry 40 victim_up || die "the velexis-ota test process did not start"
pass "a velexis-ota process (PID $VICTIM) runs on the host, outside any unit"
boundary_checks "$VICTIM" "a velexis-ota process"
r="$(probe_as velexis-ota "/proc/$VICTIM/environ")"
check "a process of the same user (velexis-ota) reads that environment: $r (hence one user per zone, ADR-0026)" \
  test "$r" = READABLE
check "file modes alone deny velexis-portal every env file (${#ENV_FILES[@]}), root's files and every key [X-033 AC1]" \
  all_denied_as velexis-portal "${F_FORBIDDEN[@]}"
for u in velexis-platform-admin velexis-ota-admin; do
  check "file modes alone deny $u every env file, root's files and every key [X-033]" \
    all_denied_as "$u" "${F_FORBIDDEN[@]}"
done
check "file modes alone deny velexis-platform every env file, root's files and the OTA keys [X-033]" \
  all_denied_as velexis-platform "${P_FORBIDDEN[@]}"
check "file modes alone deny velexis-ota every env file, root's files and the platform keys [X-033]" \
  all_denied_as velexis-ota "${O_FORBIDDEN[@]}"
r="$(probe_as velexis-platform "$ETC/keys/ota")"
check "velexis-platform cannot list /etc/velexis/keys/ota/: $r [X-033 AC1]" denied "$r"
r="$(probe_as velexis-ota "$ETC/keys/ota/master-v1.key")"
check "control: velexis-ota reads its own master key: $r" test "$r" = READABLE
r="$(probe_as velexis-platform "$ETC/keys/platform")"
check "control: velexis-platform lists its own key folder: $r" test "$r" = LISTED
kill "$VICTIM"
wait "$VICTIM" 2>/dev/null || true
VICTIM=""

[ -d /run/systemd/system ] ||
  die "systemd is not the init system here: steps 1 to 3 ran, steps 4 to 11 need systemd as PID 1"

# ---- 4. release folder, the seven units and their env files ---------------------------------------------------
step "Release folder and the seven app units under $PREFIX"
install -d -m 0755 "$SBIN"
install -d "$REL"
ln -sfn "$REL" "$SRV/current"

# Only the paths change; every other line of the template is kept as it is.
render_unit() { # template-file destination-name
  sed -e "s#/srv/velexis#$PREFIX/srv/velexis#g" \
      -e "s#/etc/velexis#$PREFIX/etc/velexis#g" \
      -e "s#/var/lib/velexis#$PREFIX/var/lib/velexis#g" \
      -e "s#/usr/local/sbin/velexis-#$SBIN/velexis-#g" \
      -e "s#^ExecStart=/usr/bin/node #ExecStart=$PREFIX/bin/node #" \
      -e "s#^CacheDirectory=velexis/#CacheDirectory=$CACHE_BASE/#" \
      -e "s#velexis-alert@#velexis-smoke-alert@#g" "$1" >"/etc/systemd/system/$2"
  local production='(^|[^A-Za-z0-9._-])/(srv|etc|var/lib|var/log|var/cache|var/backups|usr/local/sbin)/velexis'
  if grep -nE "$production|^CacheDirectory=velexis/|velexis-alert@|^ExecStart=/usr/bin/" "/etc/systemd/system/$2"
  then
    die "$2 still names a production path that this test does not map; extend render_unit"
  fi
}
for u in "${APP_UNITS[@]}"; do
  SMOKE_UNITS+=("velexis-smoke-${u#velexis-}.service")
  render_unit "$UNITS/$u.service" "velexis-smoke-${u#velexis-}.service"
done
render_unit "$UNITS/velexis-alert@.service" "$A_TEMPLATE"
for s in "${SMOKE_UNITS[@]}"; do
  wd="$(unit_value "/etc/systemd/system/$s" WorkingDirectory)"
  main="$(sed -n 's/^ExecStart=.* //p' "/etc/systemd/system/$s")" # the last word: dist/main.js, .../server.js
  install -d "$(dirname "$wd/$main")"
  printf '%s\n' "$STANDIN" >"$wd/$main"
done

# Stand-in for migrate.js and load.js (step 8): prints its user, groups, folder and variable names (never values),
# writes --report if asked, then waits for the end of its standard input and exits with --exit <code> (default 0).
ONEOFF="$(cat <<'JS'
'use strict';
const fs = require('fs');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const report = arg('--report');
if (report) fs.writeFileSync(report, JSON.stringify({ target: 'smoke', total: 0, applied: [], failed: [] }));
console.log(JSON.stringify({
  msg: 'one-off running', uid: process.getuid(), groups: process.getgroups(), cwd: process.cwd(),
  envNames: Object.keys(process.env).sort(), report: Boolean(report),
}));
process.stdin.on('data', () => {}).on('end', () => process.exit(Number(arg('--exit') || 0)));
JS
)"
install -d "$REL/db/dist/cli" "$REL/reference-data/dist/cli" "$REL/reference-data/data" \
  "$REL/migrations/platform" "$REL/migrations/reference" "$REL/migrations/tenant"
printf '%s\n' "$ONEOFF" >"$REL/db/dist/cli/migrate.js"
printf '%s\n' "$ONEOFF" >"$REL/reference-data/dist/cli/load.js"
# Handed over as deploy.sh does: root:velexis, u=rX,g=rX,o= (deployment-single-vm.md §4).
chown -R root:velexis "$REL"
chmod -R u=rX,g=rX,o= "$REL"
chmod o+x "$REL"

# Env files: the ones provision-vm.sh wrote (root:root 0600), plus a canary in every file and the stand-in's
# settings in the zone files. Appending keeps their owner and mode.
for f in "${ENV_FILES[@]}"; do printf '# units-smoke.sh\nSMOKE_CANARY=%s\n' "$CANARY" >>"$f"; done
join() { local IFS=:; echo "$*"; }
smoke_settings() { # role forbidden-path...
  printf 'SMOKE_ROLE=%s\nSMOKE_PG=%s\nSMOKE_REDIS=%s\nSMOKE_HTTPS_URL=%s\n' "$1" "$PG" "$REDIS" "$HTTPS_URL"
  [ -z "${SMOKE_NODE_EXTRA_CA_CERTS:-}" ] || printf 'NODE_EXTRA_CA_CERTS=%s\n' "$SMOKE_NODE_EXTRA_CA_CERTS"
  shift
  echo "SMOKE_FORBIDDEN=$(join "$@")"
}
smoke_settings backend "${P_FORBIDDEN[@]}" >>"$ETC/platform-backend.env"
smoke_settings backend "${O_FORBIDDEN[@]}" >>"$ETC/ota-backend.env"
for f in platform-frontend platform-admin ota-admin; do
  smoke_settings frontend "${F_FORBIDDEN[@]}" >>"$ETC/$f.env"
done
cat >"$ETC/alert.env" <<EOF
ALERT_SMTP_URL=$SMTP_URL
ALERT_SMTP_USER=
ALERT_SMTP_PASSWORD=
ALERT_SMTP_TLS=${SMOKE_SMTP_TLS:-none}
ALERT_FROM=velexis-smoke@example.com
ALERT_TO=$ALERT_TO
ALERT_HOST_LABEL=units-smoke-$RUN_ID
SMOKE_CANARY=$CANARY
EOF
check "the env files are still root:root 0600 after the test settings [X-033 AC3]" env_files_ok
install -m 0755 "$DEPLOY/scripts/alert.sh" "$SBIN/velexis-alert"

systemctl daemon-reload
step "systemd-analyze verify of the installed test units (node and the alert script exist: no message allowed)"
if out="$(systemd-analyze verify --man=no "${SMOKE_UNITS[@]/#//etc/systemd/system/}" \
            "/etc/systemd/system/$A_TEMPLATE" 2>&1)" && [ -z "$out" ]; then
  pass "systemd-analyze verify is clean"
else
  printf '%s\n' "$out"
  fail "systemd-analyze verify reported problems"
fi

# ---- 5. start the seven units and read the stand-ins' checks -------------------------------------------------
port_of() { sed -n 's/^Environment=\(PORT\|HEALTH_PORT\)=//p' "/etc/systemd/system/$1" | tail -n 1; }
for s in "${SMOKE_UNITS[@]}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$(port_of "$s")") 2>/dev/null; then die "port $(port_of "$s") is already in use"; fi
done
diagnose() { # unit
  systemctl status --no-pager --lines=0 "$1" || true
  journalctl -u "$1" -n 30 --no-pager -o cat || true
}
wait_ready() { # port -> prints the /health/ready body; fails on 503 (a check failed) or after 60 s
  local _ body url="http://127.0.0.1:$1/health/ready"
  for _ in $(seq 1 60); do
    if body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)"; then
      printf '%s\n' "$body"
      return 0
    fi
    if curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null | grep -x 503 >/dev/null; then
      curl -sS --max-time 5 "$url" || true
      echo
      return 1
    fi
    sleep 1
  done
  return 1
}
json() { # expression <json -> the JavaScript expression over v (an array prints one item per line)
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
  "$NODE" -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    const r = new Function("v", `return (${process.argv[1]});`)(JSON.parse(s));
    process.stdout.write(Array.isArray(r) ? r.join("\n") : String(r));
  });' "$1"
}

step "Start the seven units: ${SMOKE_UNITS[*]}"
if ! systemctl start "${SMOKE_UNITS[@]}"; then
  for s in "${SMOKE_UNITS[@]}"; do diagnose "$s"; done
  die "systemctl start failed"
fi
declare -A READY=()
for s in "${SMOKE_UNITS[@]}"; do
  if body="$(wait_ready "$(port_of "$s")")"; then
    READY[$s]="$body"
    # shellcheck disable=SC2016 # a JavaScript template literal
    printf '%s\n' "$body" | json 'Object.entries(v.checks).map(([k, c]) => `     ${k}: ${c.detail}`)' | cut -c1-160
    echo
    pass "$s ($(unit_value "/etc/systemd/system/$s" User)): the stand-in passed its start-up checks (release" \
      "folder, key files for a backend, PostgreSQL, Redis, DNS, HTTPS, os.cpus(), os.networkInterfaces()) and every" \
      "forbidden path was denied [X-021 AC2]"
  else
    printf '%s\n' "${body:-}"
    diagnose "$s"
    fail "$s: the stand-in is not ready [X-021 AC2]"
  fi
done
[ "$FAILED" -eq 0 ] || die "the units did not start cleanly; not going on"

step "Every unit gets the variables of its root-only env files (the stand-in reports names, never values)"
env_names() { grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | tr -d = | sort -u; }
for s in "${SMOKE_UNITS[@]}"; do
  seen="$(printf '%s' "${READY[$s]}" | json 'v.envNames')"
  files=""
  missing=""
  count=0
  while IFS= read -r ef; do
    ef="${ef#-}"
    [ -f "$ef" ] || continue
    files="$files $(basename "$ef")"
    for n in $(env_names "$ef"); do
      count=$((count + 1))
      grep -qx -- "$n" <<<"$seen" || missing="$missing $n"
    done
  done < <(unit_values "/etc/systemd/system/$s" EnvironmentFile)
  check "$s sees all $count variables of$files [X-033 AC3]" test -z "$missing"
  [ -z "$missing" ] || echo "     missing:$missing"
done

# ---- 6. cross-zone checks from inside the units ----------------------------------------------------------------
step "Cross-zone: what the portal and the platform API stand-ins get, inside their units"
B_PORT="$(port_of "$B_UNIT")"
F_PORT="$(port_of "$F_UNIT")"
P_PORT="$(port_of "$P_UNIT")"
OTA_PID="$(systemctl show -P MainPID "$B_UNIT")"
probe_in() { # port path -> what the stand-in on that port gets for the path, inside its unit
  curl -fsS --max-time 5 --get --data-urlencode "path=$2" "http://127.0.0.1:$1/probe" 2>/dev/null || echo FAILED
}
all_denied_in() { # port path... -> true when every path is denied; prints the ones that are not
  local port="$1" p r ok=0
  shift
  for p in "$@"; do
    r="$(probe_in "$port" "$p")"
    denied "$r" || { echo "     $r $(short "$p")"; ok=1; }
  done
  return "$ok"
}
check "control: root reads the OTA API's environment (PID $OTA_PID, user $(stat -c %U "/proc/$OTA_PID"))" \
  environ_has "$OTA_PID" SMOKE_ROLE
r="$(probe_in "$B_PORT" "/proc/self/root$ETC/keys/ota/master-v1.key")"
check "control: the OTA API reads its own master key through /proc/self/root: $r" test "$r" = READABLE
r="$(probe_in "$F_PORT" "/proc/$OTA_PID/environ")"
check "velexis-portal, in its unit, is denied the OTA API's /proc/<pid>/environ: $r [X-033 AC1]" denied "$r"
r="$(probe_in "$F_PORT" "/proc/$OTA_PID/root$ETC/keys/ota/master-v1.key")"
check "velexis-portal, in its unit, is denied /proc/<pid>/root/etc/velexis/keys/ota/master-v1.key: $r [X-033 AC1]" \
  denied "$r"
check "velexis-portal, in its unit, is denied all ${#ENV_FILES[@]} /etc/velexis/*.env and .provision-secrets [X-033 AC1]" \
  all_denied_in "$F_PORT" "${ENV_FILES[@]}" "$ETC/.provision-secrets"
r="$(probe_in "$P_PORT" "$ETC/keys/ota")"
check "velexis-platform, in the platform API unit, cannot list /etc/velexis/keys/ota/: $r [X-033 AC1]" denied "$r"
r="$(probe_in "$P_PORT" "$ETC/keys/platform")"
check "control: the platform API lists its own key folder: $r" test "$r" = LISTED
boundary_checks "$OTA_PID" "the OTA API unit (from the host, where ProtectProc= does not apply)"

# ---- 7. InaccessiblePaths= in each unit's mount namespace ------------------------------------------------------
step "Defence in depth: InaccessiblePaths= inside each unit's mount namespace"
all_hidden() { [ "$1" -gt 0 ] && [ -z "$2" ]; } # count-checked not-hidden-list
for s in "${SMOKE_UNITS[@]}"; do
  pid="$(systemctl show -P MainPID "$s")"
  bad=""
  n=0
  while IFS= read -r line; do
    for p in $line; do
      p="${p#-}"
      [ -e "$p" ] || continue
      n=$((n + 1))
      m="$(nsenter -t "$pid" -m -- stat -c %a "$p" 2>&1)" || m="error"
      [ "$m" = 0 ] || bad="$bad $(short "$p")=$m"
    done
  done < <(unit_values "/etc/systemd/system/$s" InaccessiblePaths)
  check "$s: its $n existing InaccessiblePaths= entries are inaccessible (mode 000) [X-021 AC2]" \
    all_hidden "$n" "$bad"
  [ -z "$bad" ] || echo "     not hidden:$bad"
done
m="$(nsenter -t "$OTA_PID" -m -- stat -c %a "$ETC/keys/ota" 2>&1)" || true
check "control: in the OTA API's namespace its own key folder keeps mode 500: $m" test "$m" = 500

# ---- 8. migrations and reference data as velexis-deploy runs them ----------------------------------------------
step "One-off processes the way velexis-deploy starts them (deploy.sh's run_transient, DynamicUser=yes)"
RUN_TRANSIENT_SRC="$(sed -n '/^run_transient() {/,/^}/p' "$DEPLOY/scripts/deploy.sh")"
[ -n "$RUN_TRANSIENT_SRC" ] || die "run_transient() not found in deploy/scripts/deploy.sh"
# shellcheck disable=SC2034 # used by the evaluated function
RELEASE_GROUP=velexis
# shellcheck disable=SC2034 # used by the evaluated function
MIGRATE_STATE="/var/lib/$STATE_NAME"
eval "$RUN_TRANSIENT_SRC"
DSN="$(sed -n 's/^DATABASE_MIGRATOR_URL=//p' "$ETC/migrator.env")"
[ -n "$DSN" ] || die "no DATABASE_MIGRATOR_URL in migrator.env"
APP_UIDS=" $(for u in "${ZONE_USERS[@]}"; do id -u "$u"; done | paste -sd' ' -) "
VELEXIS_GID="$(getent group velexis | cut -d: -f3)"
is_dynamic() { [ "$1" -ge "$DYNAMIC_UID_MIN" ] && [ "$1" -le "$DYNAMIC_UID_MAX" ] && [[ "$APP_UIDS" != *" $1 "* ]]; }
scan_processes() { # sets SCAN_APP, SCAN_APP_HOLDERS, SCAN_HOLDERS (pid:uid) and SCAN_CMDLINE
  local d pid uids u is_app env cmd
  SCAN_APP=0 SCAN_APP_HOLDERS="" SCAN_HOLDERS="" SCAN_CMDLINE=""
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    uids="$(awk '/^Uid:/ { print $2, $3, $4, $5 }' "$d/status" 2>/dev/null)" || continue
    [ -n "$uids" ] || continue
    is_app=0
    for u in $uids; do [[ "$APP_UIDS" == *" $u "* ]] && is_app=1; done
    env="$(tr '\0' '\n' 2>/dev/null <"$d/environ")" || env=""
    cmd="$(tr '\0' ' ' 2>/dev/null <"$d/cmdline")" || cmd=""
    [ "$is_app" = 0 ] || SCAN_APP=$((SCAN_APP + 1))
    case $'\n'"$env" in
      *$'\n'DATABASE_MIGRATOR_URL=*)
        SCAN_HOLDERS="$SCAN_HOLDERS $pid:${uids%% *}"
        [ "$is_app" = 0 ] || SCAN_APP_HOLDERS="$SCAN_APP_HOLDERS $pid"
        ;;
    esac
    [[ "$cmd" != *"$DSN"* ]] || SCAN_CMDLINE="$SCAN_CMDLINE $pid"
  done
  return 0
}
oneoff_line() { grep -F '"msg":"one-off running"' "$1" | head -n 1; }

mkfifo -m 0600 "$PREFIX/oneoff.in"
run_transient "$ETC/migrator.env" "$REL/db" "$PREFIX/bin/node" dist/cli/migrate.js tenants \
  --dir "$REL/migrations/tenant" --report "$MIGRATE_STATE/migrate-smoke.json" \
  <"$PREFIX/oneoff.in" >"$PREFIX/oneoff-migrate.out" 2>&1 &
ONEOFF_PID=$!
exec 7<>"$PREFIX/oneoff.in" # never blocks; the migration reads until this, the only writer, is closed
if retry 120 oneoff_line "$PREFIX/oneoff-migrate.out" >/dev/null; then
  scan_processes
  info="$(oneoff_line "$PREFIX/oneoff-migrate.out")"
  uid="$(printf '%s' "$info" | json 'v.uid')"
  check "the migration runs as dynamic user $uid, not as an app user [X-033 AC4]" is_dynamic "$uid"
  check "its supplementary groups include velexis (gid $VELEXIS_GID) to read the release [X-033]" \
    test "$(printf '%s' "$info" | json "v.groups.includes($VELEXIS_GID)")" = true
  check "it runs in the release's db/ folder [X-033]" \
    test "$(printf '%s' "$info" | json 'v.cwd')" = "$(readlink -f "$REL/db")"
  one_dsn_js='v.envNames.includes("DATABASE_MIGRATOR_URL")
    && !v.envNames.some((n) => n === "DATABASE_URL" || n === "DATABASE_PROVISIONER_URL")'
  check "it has DATABASE_MIGRATOR_URL and no other DSN variable [X-033]" \
    test "$(printf '%s' "$info" | json "$one_dsn_js")" = true
  check "scanned $SCAN_APP processes of the app users while it ran (the seven stand-ins among them) [X-033 AC4]" \
    test "$SCAN_APP" -ge "${#SMOKE_UNITS[@]}"
  check "no process of an app user has DATABASE_MIGRATOR_URL in its environment [X-033 AC4]" \
    test -z "$SCAN_APP_HOLDERS"
  held_by() { local h; for h in $SCAN_HOLDERS; do [ "${h#*:}" = "$1" ] && return 0; done; return 1; }
  check "the scan finds it in the migration process, dynamic user $uid (pid:uid:$SCAN_HOLDERS) [X-033 AC4]" \
    held_by "$uid"
  check "no command line holds the migrator DSN [X-033 AC4]" test -z "$SCAN_CMDLINE"
else
  cat "$PREFIX/oneoff-migrate.out"
  fail "the transient migration did not start [X-033 AC4]"
fi
exec 7>&-
rc=0
wait "$ONEOFF_PID" || rc=$?
ONEOFF_PID=""
check "the transient migration exited 0 once its input ended [X-033]" test "$rc" = 0
check "it wrote its report into its StateDirectory=, where velexis-deploy picks it up [X-033]" \
  test -s "$MIGRATE_STATE/migrate-smoke.json"

rc=0
run_transient "$ETC/migrator.env" "$REL/db" "$PREFIX/bin/node" dist/cli/migrate.js platform \
  --dir "$REL/migrations/platform" --exit 3 </dev/null >"$PREFIX/oneoff-exit.out" 2>&1 || rc=$?
check "run_transient returns the command's exit code (3) [X-033]" test "$rc" = 3

rc=0
run_transient "$ETC/reference-loader.env" "$REL/reference-data" "$PREFIX/bin/node" dist/cli/load.js --data data \
  </dev/null >"$PREFIX/oneoff-load.out" 2>&1 || rc=$?
info="$(oneoff_line "$PREFIX/oneoff-load.out" || true)"
if [ "$rc" = 0 ] && [ -n "$info" ]; then
  check "the reference loader runs as a dynamic user too [X-033]" is_dynamic "$(printf '%s' "$info" | json 'v.uid')"
  check "the reference loader gets DATABASE_URL from reference-loader.env and never DATABASE_MIGRATOR_URL [X-033]" \
    test "$(printf '%s' "$info" |
      json 'v.envNames.includes("DATABASE_URL") && !v.envNames.includes("DATABASE_MIGRATOR_URL")')" = true
else
  cat "$PREFIX/oneoff-load.out"
  fail "the transient reference loader failed (exit $rc) [X-033]"
fi

# ---- 9. velexis-run ------------------------------------------------------------------------------------------
step "velexis-run (run-as.sh) with the test units"
sed -e 's#^UNIT_PREFIX=velexis-$#UNIT_PREFIX=velexis-smoke-#' "$DEPLOY/scripts/run-as.sh" >"$SBIN/velexis-run"
grep -qx 'UNIT_PREFIX=velexis-smoke-' "$SBIN/velexis-run" || die "run-as.sh: UNIT_PREFIX=velexis- not found"
chmod 0755 "$SBIN/velexis-run"
vrun() { (cd / && PATH="$PREFIX/bin:$PATH" "$SBIN/velexis-run" "$@" </dev/null); } # node is <prefix>/bin/node
rc=0
vrun platform node -e "process.exit(3)" || rc=$?
check "velexis-run platform node -e \"process.exit(3)\" exits 3 [X-033 AC5]" test "$rc" = 3
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
INFO_JS='const fs = require("fs"), os = require("os");
const probe = (p) => {
  try { fs.readFileSync(p); return "READABLE"; } catch (e) { if (e.code !== "EISDIR") return e.code || "ERROR"; }
  try { fs.readdirSync(p); return "LISTED"; } catch (e) { return e.code || "ERROR"; }
};
console.log(JSON.stringify({ uid: process.getuid(), user: os.userInfo().username, cwd: process.cwd(),
  envNames: Object.keys(process.env).sort(), otaEnviron: probe(`/proc/${process.argv[1]}/environ`),
  otaKeys: probe(process.argv[2]) }));'
if info="$(vrun platform node -e "$INFO_JS" "$OTA_PID" "$ETC/keys/ota" 2>&1)"; then
  user="$(printf '%s' "$info" | json 'v.user')"
  check "the command runs as $user (uid $(printf '%s' "$info" | json 'v.uid')) [X-033 AC5]" \
    test "$user:$(printf '%s' "$info" | json 'v.uid')" = "velexis-platform:$(id -u velexis-platform)"
  check "it runs in the zone's release folder (relative paths like dist/cli.js work) [X-033]" \
    test "$(printf '%s' "$info" | json 'v.cwd')" = "$(readlink -f "$SRV/current/platform-backend")"
  seen="$(printf '%s' "$info" | json 'v.envNames')"
  missing=""
  for n in $(env_names "$ETC/platform-backend.env"); do grep -qx -- "$n" <<<"$seen" || missing="$missing $n"; done
  no_migrator() { ! grep -qx DATABASE_MIGRATOR_URL <<<"$seen"; }
  check "it gets every variable of platform-backend.env (names only) [X-033]" test -z "$missing"
  check "it gets no DATABASE_MIGRATOR_URL [X-033]" no_migrator
  r="$(printf '%s' "$info" | json 'v.otaEnviron')"
  check "it is denied the OTA API's /proc/<pid>/environ (the unit's sandbox): $r [X-033]" denied "$r"
  r="$(printf '%s' "$info" | json 'v.otaKeys')"
  check "it cannot list /etc/velexis/keys/ota/: $r [X-033]" denied "$r"
else
  printf '%s\n' "$info"
  fail "velexis-run platform node -e ... failed [X-033 AC5]"
fi
rc=0
vrun nowhere true >/dev/null 2>&1 || rc=$?
check "velexis-run refuses an unknown zone with exit 125 [X-033]" test "$rc" = 125

# ---- 10. kill the backend unit into failed and check the alert ----------------------------------------------
wait_new_pid() { # unit old-pid -> prints the new main PID; fails when the unit is failed
  local _ state pid
  for _ in $(seq 1 60); do
    state="$(systemctl show -P ActiveState "$1")"
    pid="$(systemctl show -P MainPID "$1")"
    [ "$state" = failed ] && return 1
    if [ "$state" = active ] && [ "$pid" != 0 ] && [ "$pid" != "$2" ]; then
      echo "$pid"
      return 0
    fi
    sleep 0.5
  done
  return 1
}
is_live() { curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$1/health/live" 2>/dev/null; }
is_failed() { [ "$(systemctl show -P ActiveState "$1")" = failed ]; }

step "Kill $B_UNIT with SIGKILL at most $MAX_KILLS times within 300 s"
burst="$(unit_value "/etc/systemd/system/$B_UNIT" StartLimitBurst)"
interval="$(unit_value "/etc/systemd/system/$B_UNIT" StartLimitIntervalSec)"
t0="$(date +%s)"
kills=0
pid=0
while [ "$kills" -lt "$MAX_KILLS" ]; do
  pid="$(wait_new_pid "$B_UNIT" "$pid")" || break
  # The stand-in listens only after its start-up checks, so every run has logged before it dies.
  retry 60 is_live "$B_PORT" || { diagnose "$B_UNIT"; die "the restarted stand-in (PID $pid) did not come up"; }
  kill -KILL "$pid"
  kills=$((kills + 1))
done
retry 60 is_failed "$B_UNIT" || true
elapsed=$(($(date +%s) - t0))
state="$(systemctl show -P ActiveState "$B_UNIT")"
result="$(systemctl show -P Result "$B_UNIT")"
# The start limit keeps the result of the last run (Result=signal after a kill) and logs this line instead.
limit_hit() {
  journalctl -u "$B_UNIT" --since "@$t0" --no-pager -o cat \
    | grep -F 'Start request repeated too quickly' >/dev/null
}
if [ "$state" = failed ] && retry 20 limit_hit && [ "$elapsed" -le 300 ]; then
  pass "$B_UNIT is failed by its start limit (StartLimitBurst=$burst, StartLimitIntervalSec=$interval)" \
    "after $kills kills in ${elapsed}s (Result=$result) [X-021 AC3]"
else
  diagnose "$B_UNIT"
  die "$B_UNIT is $state (Result=$result) after $kills kills in ${elapsed}s; start limit message:" \
    "$(limit_hit && echo found || echo missing) [X-021 AC3]"
fi

step "Alert mail for $B_UNIT in Mailpit ($MAILPIT, to $ALERT_TO)"
search() { curl -fsS --max-time 5 --get --data-urlencode "query=to:$ALERT_TO" "$MAILPIT/api/v1/search"; }
messages() { # field: ID of the newest message, or count
  "$NODE" -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    const m = JSON.parse(s).messages || [];
    process.stdout.write(process.argv[1] === "count" ? String(m.length) : (m.length ? m[0].ID : ""));
  });' "$1"
}
id=""
for _ in $(seq 1 60); do
  id="$(search 2>/dev/null | messages ID || true)"
  [ -n "$id" ] && break
  sleep 1
done
if [ -z "$id" ]; then
  diagnose "$A_UNIT"
  die "no alert mail for $ALERT_TO in Mailpit"
fi
mail="$(curl -fsS --max-time 10 "$MAILPIT/api/v1/message/$id/raw" | tr -d '\r')"
printf '%s\n' "$mail" | sed -n '1,/^$/p' | grep -E '^(From|To|Subject):' || true
mail_has() { printf '%s\n' "$mail" | grep -F -- "$1" >/dev/null; }
mail_log_has() { printf '%s\n' "$mail" | sed -n '/^Last log lines:/,$p' | grep -F -- "$1" >/dev/null; }
check "the subject names $B_UNIT [X-021 AC3]" mail_has "Subject: [velexis][units-smoke-$RUN_ID] $B_UNIT failed"
check "the mail carries the unit status (Active: failed) [X-021 AC3]" mail_has "Active: failed"
check "the mail's last log lines show the start limit [X-021 AC3]" mail_log_has "Start request repeated too quickly"
check "the mail's last log lines include the app's own output [X-021 AC3]" mail_log_has '"msg":"stand-in ready"'
check "$A_UNIT finished with Result=success [X-021 AC3]" test "$(systemctl show -P Result "$A_UNIT")" = success
check "exactly one alert mail for $kills kills (RestartMode=direct: no mail per crash) [X-021 AC3]" \
  test "$(search | messages count)" = 1

# ---- 11. no value leaks ----------------------------------------------------------------------------------------
step "No env value reaches the journal, the mail or the one-off outputs"
# The canary and every generated secret, as fixed strings in a root-only file (never on a command line).
PATTERNS="$PREFIX/values.txt"
(umask 077 && { echo "$CANARY"; sed -n 's/^[A-Z0-9_]*=//p' "$ETC/.provision-secrets"; } | sed '/^$/d' >"$PATTERNS")
JOURNAL_UNITS=()
for s in "${SMOKE_UNITS[@]}" "$A_UNIT"; do JOURNAL_UNITS+=(-u "$s"); done
journal_leaks() { journalctl "${JOURNAL_UNITS[@]}" --no-pager -o cat | grep -F -f "$PATTERNS" >/dev/null; }
mail_leaks() { printf '%s\n' "$mail" | grep -F -f "$PATTERNS" >/dev/null; }
outputs_leak() { cat "$PREFIX"/oneoff-*.out | grep -F -f "$PATTERNS" >/dev/null; }
check "neither the canary nor a value of .provision-secrets is in the journal [X-021, X-033 AC3]" not journal_leaks
check "neither is in the mail [X-021]" not mail_leaks
check "neither is in the output of the one-off commands [X-033]" not outputs_leak

if [ "$FAILED" -ne 0 ]; then
  printf '\nunits-smoke: FAILED\n'
  exit 1
fi
printf '\nunits-smoke: all checks passed\n'
