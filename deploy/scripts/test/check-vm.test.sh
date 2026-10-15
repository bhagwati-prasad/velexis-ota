#!/usr/bin/env bash
# =====================================================================================================
# check-vm.test.sh — tests deploy/scripts/check-vm.sh and the env file checks of provision-vm.sh (task X-020), and
# the master-key rotation of provision-vm.sh's step keys (task X-040).
#
#   sudo bash deploy/scripts/test/check-vm.test.sh
#
# Needs root and Ubuntu 24.04 (provision-vm.sh refuses anything else), openssl, visudo and python3 (for one unix
# socket). It needs no systemd, PostgreSQL, Redis or Caddy, and it never touches a service:
#   - provision-vm.sh runs only its steps users, keys and envfiles, under a temporary VELEXIS_ROOT (the five zone
#     users, the group velexis and a test deploy user are real, as in deploy/systemd/test/units-smoke.sh);
#   - check-vm.sh runs with that VELEXIS_ROOT and fake system tools first on PATH (systemctl, ufw, sshd, swapon, ss,
#     sysctl, timedatectl, runuser, psql, redis-cli, caddy, node). Each fake answers from a fixture file that the test
#     edits, logs its command line, and records as a violation any call that could change something.
# Users, groups and folders the test created are removed at the end (CHECKVM_KEEP=1 keeps them for inspection). It
# refuses to run on a provisioned Velexis VM. It prints one PASS or FAIL line per check; a check that proves an
# acceptance criterion of X-020 or X-040 ends in [X-020 AC<n>] or [X-040 AC<n>].
#
# What it proves:
#   1. Two runs of provision-vm.sh --steps users,keys,envfiles: the second changes no key, env or secrets file
#      (content, inode, times, owner, mode) and leaves the deploy key alone; the deploy key is installed once, with
#      restrict. A private key given as DEPLOY_SSH_PUBKEY_FILE is refused without being printed (AC2, the part that
#      runs without a VM).
#   2. On that layout, completed with what the other steps install and with fakes that describe a healthy VM,
#      check-vm.sh reports only PASS, covers every item of the task, exits 0 and changes no file (AC2).
#   3. Every item reports FAIL when its fixture is broken: a stopped unit, an extra firewall port, password or root
#      SSH logins, swap, core dumps, a missing role, a wrong search_path, PostgreSQL or Caddy's admin API on a public
#      or TCP address, the Redis eviction policy, a failing caddy validate, /run/caddy, key and env file modes,
#      differing key copies, a writable release, the velexis group, the deploy key options and shared env values.
#   4. With a variable removed from a test copy of an env file, check-vm.sh reports FAIL naming the variable, and
#      provision-vm.sh --steps envfiles warns about it by name and leaves the file as it is (AC3).
#   5. A master-key rotation (X-040): NEW_MASTER_KEY=v2 with the step keys creates master-v2.key once, as copies with
#      the same SHA-256 in both zone folders, leaves every other key file alone, restores a missing copy and refuses a
#      malformed or lower version; after the runbook's end (MASTER_KEY_CURRENT=local:v2, master-v1.key removed from
#      both folders) check-vm.sh --only files passes and the step keys does not create master-v1.key again (AC3).
#   6. No output of either script, no command line of a fake and no line of provision.log holds a generated
#      secret, a key, or a value of an env file, even when caddy validate fails with a message that quotes the edge
#      secret or caddy.env has a malformed line; provision-vm.sh substitutes no placeholder through sed (AC4).
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/../.." && pwd)"
PROVISION="$DEPLOY/scripts/provision-vm.sh"
CHECK="$DEPLOY/scripts/check-vm.sh"
ZONE_USERS=(velexis-platform velexis-ota velexis-portal velexis-platform-admin velexis-ota-admin)

FAILED=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILED=1; }
die() { printf 'FAIL %s\n' "$*"; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
indent() { sed 's/^/     /' "$@"; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ ! -e /etc/velexis ] || die "/etc/velexis exists: this looks like a provisioned Velexis VM; run the test on a CI runner or a development machine"
for tool in openssl visudo python3 useradd userdel groupdel gpasswd getent sha256sum; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done

PREFIX="$(mktemp -d "${CHECKVM_TMPDIR:-/tmp}/velexis-checkvm.XXXXXX")"
chmod 0755 "$PREFIX"
RUN_ID="$(printf '%s' "${PREFIX##*.}" | tr '[:upper:]' '[:lower:]')"
ROOT="$PREFIX/root"         # VELEXIS_ROOT of both scripts
FAKE="$PREFIX/fake"         # fixture files of the fake tools
FAKEBIN="$PREFIX/fakebin"   # the fake tools
OUT="$PREFIX/out"           # every output of both scripts; searched for secrets at the end
DEPLOY_TEST_USER="vxcheck-$RUN_ID"
ETC="$ROOT/etc/velexis"
mkdir -p "$ROOT" "$FAKE" "$FAKEBIN" "$OUT"
chmod 0700 "$OUT" "$FAKE"

CREATED_USERS=()
CREATED_GROUPS=()
for u in "${ZONE_USERS[@]}" "$DEPLOY_TEST_USER" caddy; do id -u "$u" >/dev/null 2>&1 || CREATED_USERS+=("$u"); done
getent group velexis >/dev/null || CREATED_GROUPS+=(velexis)
cleanup() {
  local rc=$? u g
  if [ "${CHECKVM_KEEP:-0}" = 1 ]; then
    echo "CHECKVM_KEEP=1: kept $PREFIX and the users ${CREATED_USERS[*]:-(none created)}"
    exit "$rc"
  fi
  rm -rf --one-file-system "$PREFIX"
  for u in "${CREATED_USERS[@]}"; do userdel -r "$u" >/dev/null 2>&1 || true; done
  for g in "${CREATED_GROUPS[@]}"; do ! getent group "$g" >/dev/null || groupdel "$g" >/dev/null 2>&1 || true; done
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- 1. provision-vm.sh, twice ------------------------------------------------------------------------------
step "provision-vm.sh --steps users,keys,envfiles with VELEXIS_ROOT, twice"
# A throwaway deploy key pair: the public half in OpenSSH format, the private half to be given by mistake.
openssl genpkey -algorithm ed25519 -out "$PREFIX/deploy-key.pem" 2>/dev/null
chmod 0600 "$PREFIX/deploy-key.pem"
{ printf '\0\0\0\013ssh-ed25519\0\0\0\040'; openssl pkey -in "$PREFIX/deploy-key.pem" -pubout -outform DER | tail -c 32; } \
  | base64 -w0 | { printf 'ssh-ed25519 '; cat; printf ' velexis-check-vm-test\n'; } >"$PREFIX/deploy-key.pub"

provision() { # log steps [VAR=value...]: provision-vm.sh as an operator runs it, under the test prefix
  local log="$1" steps="$2"
  shift 2
  env VELEXIS_ROOT="$ROOT" DEPLOY_USER="$DEPLOY_TEST_USER" DEPLOY_SSH_PUBKEY_FILE="$PREFIX/deploy-key.pub" "$@" \
    bash "$PROVISION" --steps "$steps" >"$log" 2>&1
}
fingerprint() { # the files under the arguments: path, inode, modification and change times, mode, owner, SHA-256
  find "$@" -type f -printf '%p %i %T@ %C@ %m %u:%g\n' | sort
  find "$@" -type f -exec sha256sum {} + | sort -k 2
}
fingerprint_all() { # the same for every entry (folders, links, sockets too): proves that check-vm.sh changes nothing
  find "$@" -printf '%p %i %T@ %C@ %m %u:%g %y %l\n' | sort
  find "$@" -type f -exec sha256sum {} + | sort -k 2
}
DEPLOY_HOME="/home/$DEPLOY_TEST_USER"
provision "$OUT/provision-1.log" users,keys,envfiles || { indent "$OUT/provision-1.log"; die "provision-vm.sh failed"; }
sed "s#$PREFIX#<prefix>#g" "$OUT/provision-1.log"
DEPLOY_HOME="$(getent passwd "$DEPLOY_TEST_USER" | cut -d: -f6)"
FP1="$(fingerprint "$ETC" "$DEPLOY_HOME/.ssh")"
provision "$OUT/provision-2.log" users,keys,envfiles || { indent "$OUT/provision-2.log"; die "the second provision-vm.sh run failed"; }
FP2="$(fingerprint "$ETC" "$DEPLOY_HOME/.ssh")"
if [ "$FP1" = "$FP2" ]; then
  pass "the second run changed none of the $(find "$ETC" -type f | wc -l) key, env and secrets files, nor the deploy key [X-020 AC2]"
else
  diff <(printf '%s\n' "$FP1") <(printf '%s\n' "$FP2") | sed -E "s/[0-9a-f]{64}/<sha256>/; s#$PREFIX#<prefix>#g" || true
  fail "the second provision-vm.sh run changed generated files [X-020 AC2]"
fi
if [ "$(cat "$DEPLOY_HOME/.ssh/authorized_keys")" = "restrict $(cat "$PREFIX/deploy-key.pub")" ] &&
  [ "$(stat -c '%U %a' "$DEPLOY_HOME/.ssh/authorized_keys")" = "$DEPLOY_TEST_USER 600" ]; then
  pass "the deploy key is installed once, with restrict, 0600 [X-020]"
else
  fail "the deploy key is installed once, with restrict, 0600 [X-020]"
fi
if provision "$OUT/provision-private-key.log" users DEPLOY_SSH_PUBKEY_FILE="$PREFIX/deploy-key.pem"; then
  fail "provision-vm.sh refuses a private key as DEPLOY_SSH_PUBKEY_FILE [X-020 AC4]"
elif grep -q 'never the private key' "$OUT/provision-private-key.log" &&
  [ "$(fingerprint "$ETC" "$DEPLOY_HOME/.ssh")" = "$FP2" ]; then
  pass "provision-vm.sh refuses a private key as DEPLOY_SSH_PUBKEY_FILE and changes nothing [X-020 AC4]"
else
  indent "$OUT/provision-private-key.log"
  fail "provision-vm.sh refuses a private key as DEPLOY_SSH_PUBKEY_FILE and changes nothing [X-020 AC4]"
fi
if grep -nE '\bsed\b[^#]*@@' "$PROVISION" >/dev/null; then
  fail "provision-vm.sh substitutes no placeholder through sed: a secret would be on its command line [X-020 AC4]"
else
  pass "provision-vm.sh substitutes no placeholder through sed (secrets never on a command line) [X-020 AC4]"
fi

# ---- 2. the rest of a provisioned VM, and fakes for a healthy one ---------------------------------------------
step "check-vm.sh on a healthy VM (the layout of provision-vm.sh, fake system tools)"
id -u caddy >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin caddy
# What the steps scripts and caddyconf install, and the files of the steps harden and packages.
for s in deploy:velexis-deploy backup:velexis-backup restore:velexis-restore alert:velexis-alert run-as:velexis-run; do
  install -D -m 0755 -o root -g root "$DEPLOY/scripts/${s%%:*}.sh" "$ROOT/usr/local/sbin/${s#*:}"
done
install -d -m 0755 -o root -g root "$ROOT/srv/velexis/maintenance"
install -m 0644 -o root -g root "$DEPLOY/caddy/maintenance/index.html" "$ROOT/srv/velexis/maintenance/index.html"
install -D -m 0644 -o root -g root "$DEPLOY/caddy/Caddyfile" "$ROOT/etc/caddy/Caddyfile"
install -d -m 0700 -o caddy -g caddy "$ROOT/run/caddy"
python3 -I -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$ROOT/run/caddy/admin.sock"
printf 'LABEL=cloudimg-rootfs / ext4 discard,errors=remount-ro 0 1\n#/swap.img none swap sw 0 0\n' >"$PREFIX/fstab"
install -D -m 0644 "$PREFIX/fstab" "$ROOT/etc/fstab"
install -d "$ROOT/etc/apt/apt.conf.d" "$ROOT/var/lib/aide"
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >"$ROOT/etc/apt/apt.conf.d/20auto-upgrades"
printf 'AIDE test database\n' >"$ROOT/var/lib/aide/aide.db"
# One release, handed over the way velexis-deploy does it, and the current symlink.
REL="$ROOT/srv/velexis/releases/0123456789abcdef0123456789abcdef01234567"
mkdir -p "$REL/ota-backend/dist" "$REL/storefront"
echo 'module.exports = {};' >"$REL/ota-backend/dist/main.js"
echo '<!doctype html>' >"$REL/storefront/index.html"
chown -R root:velexis "$REL"
chmod -R u=rX,g=rX,o= "$REL"
chmod o+x "$REL"
chmod -R o+rX "$REL/storefront"
ln -s "$REL" "$ROOT/srv/velexis/current"

# ---- the fakes --------------------------------------------------------------------------------------------
fake() { # name, body on stdin: a fake tool that logs its command line and refuses anything check-vm.sh may not ask
  {
    printf '#!/usr/bin/env bash\n# fake %s (deploy/scripts/test/check-vm.test.sh)\nset -uo pipefail\nTOOL=%s\n' "$1" "$1"
    cat <<'EOF'
F="$CHECKVM_FAKE"
printf '%s %s\n' "$TOOL" "$*" >>"$F/calls.log"
refuse() { printf '%s %s\n' "$TOOL" "$*" >>"$F/violations"; echo "fake $TOOL: refused: $*" >&2; exit 1; }
EOF
    cat
  } >"$FAKEBIN/$1"
  chmod 0755 "$FAKEBIN/$1"
}
fake systemctl <<'EOF'
case "${1:-}" in is-active | is-enabled) ;; *) refuse "$@" ;; esac
u="${2%.service}"
read -r _ active enabled < <(awk -v u="$u" '$1 == u' "$F/units") || true
if [ "$1" = is-active ]; then
  echo "${active:-inactive}"
  [ "${active:-}" = active ]
else
  echo "${enabled:-not-found}"
  [ "${enabled:-}" = enabled ]
fi
EOF
fake ufw <<'EOF'
[ "$*" = "status verbose" ] || refuse "$@"
cat "$F/ufw"
EOF
fake sshd <<'EOF'
[ "$*" = "-T" ] || refuse "$@"
cat "$F/sshd"
EOF
fake swapon <<'EOF'
[ "$*" = "--show --noheadings" ] || refuse "$@"
cat "$F/swapon"
EOF
fake ss <<'EOF'
[ "$*" = "-Hltn" ] || refuse "$@"
cat "$F/ss"
EOF
fake sysctl <<'EOF'
[ "${1:-}" = -n ] && [ $# = 2 ] || refuse "$@"
awk -F' = ' -v k="$2" '$1 == k { print $2 }' "$F/sysctl"
EOF
fake timedatectl <<'EOF'
[ "$*" = "show -p Timezone --value" ] || refuse "$@"
cat "$F/timezone"
EOF
fake node <<'EOF'
[ "$*" = "--version" ] || refuse "$@"
cat "$F/node-version"
EOF
fake runuser <<'EOF'
[ "${1:-}" = -u ] && [ "${3:-}" = -- ] || refuse "$@"
export CHECKVM_AS="$2"
shift 3
exec "$@"
EOF
fake psql <<'EOF'
[ "${CHECKVM_AS:-}" = postgres ] || refuse "not as postgres: $*"
sql=""
while [ $# -gt 0 ]; do
  [ "$1" != -c ] || sql="${2:-}"
  shift
done
# Read-only: no statement that writes or changes a privilege.
if printf '%s' "$sql" | grep -qiE '\b(insert|update|delete|alter|create|drop|grant|revoke|truncate|copy|set)\b'; then
  refuse "$sql"
fi
case "$sql" in
  "/* check:settings */"*) cat "$F/psql-settings" ;;
  "/* check:database */"*) cat "$F/psql-database" ;;
  "/* check:roles */"*) cat "$F/psql-roles" ;;
  "/* check:search_path */"*) cat "$F/psql-search-path" ;;
  *) refuse "$sql" ;;
esac
EOF
fake redis-cli <<'EOF'
want="$(sed -n 's/^REDIS_PASSWORD=//p' "$CHECKVM_SECRETS")"
for a in "$@"; do [ "$a" != "$want" ] || refuse "the password is on the command line"; done
[ "${1:-}" = -h ] && [ "${2:-}" = 127.0.0.1 ] && [ "${3:-}" = -p ] && [ "${4:-}" = 6379 ] || refuse "$@"
shift 4
[ "${1:-}" != --no-auth-warning ] || shift
if [ "${REDISCLI_AUTH:-}" != "$want" ] && [ ! -e "$F/redis-open" ]; then
  echo "NOAUTH Authentication required."
  exit 0
fi
case "$*" in
  PING) echo PONG ;;
  "INFO server") printf '# Server\r\nredis_version:%s\r\nredis_mode:standalone\r\n' "$(cat "$F/redis-version")" ;;
  "CONFIG GET "*)
    printf '%s\n' "$3"
    awk -v k="$3" '$1 == k { print $2 }' "$F/redis-config" ;;
  *) refuse "$@" ;;
esac
EOF
fake caddy <<'EOF'
case "${1:-}" in
  version)
    [ $# = 1 ] || refuse "$@"
    echo "v2.8.4 h1:fake=" ;;
  validate)
    [ "${CHECKVM_AS:-}" = caddy ] || refuse "validate not as caddy"
    [ "$*" = "validate --config $CHECKVM_CADDYFILE --adapter caddyfile" ] || refuse "$@"
    if [ -z "${VELEXIS_EDGE_SECRET:-}" ] || [ -z "${PLATFORM_BASE_DOMAIN:-}" ]; then
      echo "Error: caddy.env is not in the environment" >&2
      exit 1
    fi
    echo "{\"level\":\"info\",\"msg\":\"using config from file\",\"file\":\"$CHECKVM_CADDYFILE\"}" >&2
    if [ -e "$F/caddy-invalid" ]; then
      # A message that quotes the secret, which check-vm.sh must never print.
      echo "Error: adapting config using caddyfile: header_up: bad value \"$VELEXIS_EDGE_SECRET\" for $PLATFORM_BASE_DOMAIN" >&2
      exit 1
    fi
    echo "Valid configuration" ;;
  *) refuse "$@" ;;
esac
EOF

healthy() { # writes the fixtures of a healthy, provisioned VM
  cat >"$FAKE/units" <<'EOF'
postgresql active enabled
postgresql@16-main active enabled-runtime
redis-server active enabled
caddy active enabled
velexis-backup.timer active enabled
fail2ban active enabled
auditd active enabled
chrony active enabled
apport inactive masked
EOF
  cat >"$FAKE/ufw" <<'EOF'
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     LIMIT IN    Anywhere
80/tcp                     ALLOW IN    Anywhere
443/tcp                    ALLOW IN    Anywhere
443/udp                    ALLOW IN    Anywhere
22/tcp (v6)                LIMIT IN    Anywhere (v6)
80/tcp (v6)                ALLOW IN    Anywhere (v6)
443/tcp (v6)               ALLOW IN    Anywhere (v6)
443/udp (v6)               ALLOW IN    Anywhere (v6)

EOF
  printf '%s\n' 'port 22' 'permitrootlogin no' 'pubkeyauthentication yes' 'passwordauthentication no' \
    'kbdinteractiveauthentication no' 'maxauthtries 3' 'allowusers ubuntu' "allowusers $DEPLOY_TEST_USER" >"$FAKE/sshd"
  : >"$FAKE/swapon"
  cat >"$FAKE/ss" <<'EOF'
LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*
LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*
LISTEN 0      200        127.0.0.1:5432      0.0.0.0:*
LISTEN 0      200            [::1]:5432         [::]:*
LISTEN 0      511        127.0.0.1:6379      0.0.0.0:*
LISTEN 0      511            [::1]:6379         [::]:*
LISTEN 0      4096               *:443             *:*
LISTEN 0      4096               *:80              *:*
LISTEN 0      511        127.0.0.1:4000      0.0.0.0:*
EOF
  printf '%s\n' 'kernel.core_pattern = |/bin/false' 'fs.suid_dumpable = 0' >"$FAKE/sysctl"
  echo UTC >"$FAKE/timezone"
  echo v22.12.0 >"$FAKE/node-version"
  printf '%s\n' listen_addresses=localhost log_parameter_max_length=0 max_locks_per_transaction=256 \
    server_version_num=160010 shared_preload_libraries=pg_stat_statements >"$FAKE/psql-settings"
  echo velexis_migrator >"$FAKE/psql-database"
  printf '%s login nosuperuser\n' velexis_migrator velexis_ota_app velexis_platform_app velexis_provisioner >"$FAKE/psql-roles"
  echo search_path=pg_catalog >"$FAKE/psql-search-path"
  echo 7.4.2 >"$FAKE/redis-version"
  printf '%s\n' 'maxmemory-policy noeviction' 'maxmemory 536870912' 'appendonly yes' >"$FAKE/redis-config"
  rm -f "$FAKE/redis-open" "$FAKE/caddy-invalid"
}
healthy

N=0
run_check() { # output-file args... -> check-vm.sh as root runs it on the VM, plus the test prefix and the fakes
  local out="$1"
  shift
  env PATH="$FAKEBIN:$PATH" CHECKVM_FAKE="$FAKE" CHECKVM_SECRETS="$ETC/.provision-secrets" \
    CHECKVM_CADDYFILE="$ROOT/etc/caddy/Caddyfile" VELEXIS_ROOT="$ROOT" DEPLOY_USER="$DEPLOY_TEST_USER" \
    bash "$CHECK" "$@" >"$out" 2>&1
}

BEFORE="$(fingerprint_all "$ROOT" "$DEPLOY_HOME")"
if run_check "$OUT/healthy.out"; then rc=0; else rc=$?; fi
cat "$OUT/healthy.out"
AFTER="$(fingerprint_all "$ROOT" "$DEPLOY_HOME")"
if [ "$rc" = 0 ] && ! grep -q '^FAIL' "$OUT/healthy.out" && [ "$(grep -c '^PASS' "$OUT/healthy.out")" -ge 60 ]; then
  pass "check-vm.sh reports only PASS ($(grep -c '^PASS' "$OUT/healthy.out") items) and exits 0 on a healthy VM [X-020 AC2]"
else
  fail "check-vm.sh reports only PASS and exits 0 on a healthy VM (exit $rc) [X-020 AC2]"
fi
# Every item the task names (foundation-tasks.md, X-020 step 2) has a PASS line.
covered=1
while IFS= read -r item; do
  grep -qF -- "$item" "$OUT/healthy.out" || { echo "     no PASS line for: $item"; covered=0; }
done <<'EOF'
PASS postgresql is active and enabled
PASS redis-server is active and enabled
PASS caddy is active and enabled
PASS velexis-backup.timer is active and enabled
PASS ufw allows only 22, 80 and 443
PASS sshd -T: passwordauthentication no
PASS sshd -T: permitrootlogin no
PASS swapon --show is empty
PASS role velexis_migrator exists
PASS role velexis_provisioner exists
PASS role velexis_platform_app exists
PASS role velexis_ota_app exists
PASS velexis_ota_app's search_path is pg_catalog
PASS maxmemory-policy is noeviction
PASS caddy validate passes for /etc/caddy/Caddyfile with caddy.env
PASS every file in /etc/velexis/keys/platform is a plain file, 0400 velexis-platform
PASS every file in /etc/velexis/keys/ota is a plain file, 0400 velexis-ota
PASS /etc/velexis/keys/platform is velexis-platform:velexis-platform 500
PASS /etc/velexis/keys/ota is velexis-ota:velexis-ota 500
PASS every env file and .provision-secrets is root:root 600
PASS /srv/velexis is root:root 755
PASS /srv/velexis/releases is root:velexis 751
PASS /srv/velexis/incoming is
PASS /srv/velexis/releases/0123456789abcdef0123456789abcdef01234567 is root:velexis and read-only
PASS /etc/velexis/ota-backend.env has every variable of ota-backend.env.example
PASS /etc/velexis/platform-backend.env has every variable of platform-backend.env.example
PASS Caddy's admin API is not on TCP (ss -ltn shows no :2019)
PASS /run/caddy is caddy:caddy 700
EOF
if [ "$covered" = 1 ]; then pass "every item of the task has a PASS line [X-020 AC2]"; else fail "every item of the task has a PASS line [X-020 AC2]"; fi
if [ "$BEFORE" = "$AFTER" ] && [ ! -e "$FAKE/violations" ]; then
  pass "check-vm.sh changed no file and asked no tool to change anything (read-only) [X-020]"
else
  diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | sed "s#$PREFIX#<prefix>#g" || true
  [ ! -e "$FAKE/violations" ] || indent "$FAKE/violations"
  fail "check-vm.sh changed no file and asked no tool to change anything (read-only) [X-020]"
fi
for args in "--only nosuchgroup" "--bogus"; do
  # shellcheck disable=SC2086 # the arguments are split on purpose
  if run_check "$OUT/usage.out" $args; then rc=0; else rc=$?; fi
  if [ "$rc" = 2 ]; then pass "check-vm.sh $args exits 2 (usage) [X-020]"; else fail "check-vm.sh $args exits 2 (exit $rc) [X-020]"; fi
done

# ---- 3. every item fails when it is broken -------------------------------------------------------------------
step "check-vm.sh reports FAIL for each broken item"
broken() { # description group pattern -> check-vm.sh --only group exits 1 with a FAIL line matching pattern
  local what="$1" group="$2" pattern="$3" out rc
  N=$((N + 1))
  out="$OUT/broken-$N-$group.out"
  if run_check "$out" --only "$group"; then rc=0; else rc=$?; fi
  if [ "$rc" = 1 ] && grep -qE -- "^FAIL .*$pattern" "$out"; then
    pass "$what: $(grep -m 1 -E -- "^FAIL .*$pattern" "$out" | cut -c 6-) [X-020]"
  else
    indent "$out"
    fail "$what (exit $rc, expected a FAIL line matching: $pattern) [X-020]"
  fi
}
edit() { sed -i -E "$2" "$FAKE/$1"; } # fixture sed-expression

edit units 's/^caddy active/caddy failed/'
broken "a stopped caddy" services 'caddy is active and enabled \(found: failed enabled\)'
healthy
edit units 's/^velexis-backup.timer active enabled/velexis-backup.timer inactive disabled/'
broken "a disabled backup timer" services 'velexis-backup.timer is active and enabled'
healthy
edit units 's/^postgresql@16-main active/postgresql@16-main failed/'
broken "a stopped PostgreSQL cluster" services 'postgresql@16-main is active'
healthy
printf '5432/tcp                   ALLOW IN    Anywhere\n' >>"$FAKE/ufw"
broken "an extra firewall port" firewall 'ufw allows more than 22, 80 and 443: 5432/tcp'
healthy
printf 'Anywhere                   ALLOW IN    203.0.113.9\n' >>"$FAKE/ufw"
broken "a firewall rule for every port" firewall 'ufw allows more than 22, 80 and 443: Anywhere'
healthy
edit ufw '/^(80|443)\//d'
broken "a firewall without 80 and 443" firewall 'ufw does not allow: 80 443'
healthy
edit ufw 's#^22/tcp                     LIMIT IN    Anywhere$#OpenSSH                    ALLOW IN    Anywhere#'
if run_check "$OUT/openssh-profile.out" --only firewall && grep -q '^PASS ufw allows only 22, 80 and 443 (rules: .*OpenSSH' "$OUT/openssh-profile.out"; then
  pass "the ufw application profile OpenSSH counts as port 22 [X-020]"
else
  indent "$OUT/openssh-profile.out"
  fail "the ufw application profile OpenSSH counts as port 22 [X-020]"
fi
healthy
edit ufw 's/^Default: deny \(incoming\)/Default: allow (incoming)/'
broken "a firewall that accepts incoming connections" firewall 'ufw denies incoming connections by default'
healthy
edit ufw 's/^Status: active/Status: inactive/'
broken "a disabled firewall" firewall 'ufw is active'
healthy
edit sshd 's/^passwordauthentication no/passwordauthentication yes/'
broken "SSH password logins" ssh 'passwordauthentication no \(found: yes\)'
healthy
edit sshd 's/^permitrootlogin no/permitrootlogin without-password/'
broken "SSH root logins" ssh 'permitrootlogin no \(found: without-password\)'
healthy
echo '/swap.img file 2G 0B -2' >"$FAKE/swapon"
broken "swap in use" system 'swap is on: /swap.img'
healthy
echo '/swap.img none swap sw 0 0' >>"$ROOT/etc/fstab"
broken "a swap line in /etc/fstab" system '/etc/fstab activates swap at boot: /swap.img'
install -m 0644 "$PREFIX/fstab" "$ROOT/etc/fstab"
edit sysctl 's#^kernel.core_pattern = .*#kernel.core_pattern = |/usr/share/apport/apport -p%p -s%s -c%c -d%d -P%P -u%u -g%g -F%F -- %E#'
broken "core dumps through apport" system 'kernel.core_pattern is \|/bin/false'
healthy
edit units 's/^apport inactive masked/apport active enabled/'
broken "an enabled apport.service" system 'apport.service is enabled'
healthy
edit timezone 's/UTC/Europe\/Berlin/'
broken "a local time zone" system 'time zone is UTC \(found: Europe/Berlin\)'
healthy
edit psql-roles '/^velexis_ota_app /d'
broken "a missing database role" database 'role velexis_ota_app exists'
healthy
edit psql-roles 's/^velexis_platform_app login nosuperuser/velexis_platform_app login superuser/'
broken "a superuser app role" database 'role velexis_platform_app is login and not superuser'
healthy
printf '%s\n' 'search_path=public' >"$FAKE/psql-search-path"
broken "a wrong search_path of velexis_ota_app" database "velexis_ota_app's search_path is pg_catalog"
healthy
edit psql-settings 's/^max_locks_per_transaction=256/max_locks_per_transaction=64/'
broken "PostgreSQL without velexis.conf" database 'runs with conf.d/velexis.conf \(found: max_locks_per_transaction=64\)'
healthy
edit ss 's/127.0.0.1:5432/0.0.0.0:5432/'
broken "PostgreSQL on a public address" database 'PostgreSQL listens beyond loopback on :5432: 0.0.0.0'
healthy
edit redis-config 's/^maxmemory-policy noeviction/maxmemory-policy allkeys-lru/'
broken "a Redis eviction policy" redis 'maxmemory-policy is noeviction \(found: allkeys-lru\)'
healthy
touch "$FAKE/redis-open"
broken "a Redis without password" redis 'Redis refuses clients without the password'
healthy
echo '6.2.14' >"$FAKE/redis-version"
broken "an old Redis" redis 'Redis 7.4 \(found: 6.2.14\)'
healthy
echo 'LISTEN 0      4096       127.0.0.1:2019      0.0.0.0:*' >>"$FAKE/ss"
broken "Caddy's admin API on TCP" caddy 'something listens on TCP :2019: 127.0.0.1'
healthy
chmod 0755 "$ROOT/run/caddy"
broken "/run/caddy readable by everyone" caddy '/run/caddy is caddy:caddy 755, expected caddy:caddy 700'
chmod 0700 "$ROOT/run/caddy"
rm "$ROOT/run/caddy/admin.sock"
broken "no admin socket" caddy '/run/caddy/admin.sock is a unix socket'
python3 -I -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$ROOT/run/caddy/admin.sock"
touch "$FAKE/caddy-invalid"
broken "a Caddyfile that does not validate" caddy 'caddy validate passes for /etc/caddy/Caddyfile'
if grep -q '<redacted>' "$OUT/broken-$N-caddy.out" && ! grep -qF "$(sed -n 's/^EDGE_SECRET=//p' "$ETC/.provision-secrets")" "$OUT/broken-$N-caddy.out"; then
  pass "caddy's error message is shown with the edge secret replaced by <redacted> [X-020 AC4]"
else
  fail "caddy's error message is shown with the edge secret replaced by <redacted> [X-020 AC4]"
fi
healthy
# A malformed caddy.env line: bash runs the word after the value as a command and names it in its error message.
cp -p "$ETC/caddy.env" "$PREFIX/caddy.env.orig"
printf 'ACME_EMAIL=ops@example.com %s\n' "$(sed -n 's/^EDGE_SECRET=//p' "$ETC/.provision-secrets")" >>"$ETC/caddy.env"
if run_check "$OUT/caddy-malformed-env.out" --only caddy; then rc=0; else rc=$?; fi
if ! grep -qF "$(sed -n 's/^EDGE_SECRET=//p' "$ETC/.provision-secrets")" "$OUT/caddy-malformed-env.out"; then
  pass "a malformed caddy.env line does not reach the output through bash's error message (exit $rc) [X-020 AC4]"
else
  fail "a malformed caddy.env line does not reach the output through bash's error message [X-020 AC4]"
fi
cp -p "$PREFIX/caddy.env.orig" "$ETC/caddy.env"
rm -f "$PREFIX/caddy.env.orig"

chmod 0440 "$ETC/keys/ota/document-url.key"
broken "a group-readable key file" files 'files in /etc/velexis/keys/ota that are not 0400 velexis-ota: document-url.key \(velexis-ota:velexis-ota 440\)'
chmod 0400 "$ETC/keys/ota/document-url.key"
cp -p "$ETC/keys/ota/api-key-pepper" "$PREFIX/pepper.orig"
printf 'not the same pepper\n' >"$ETC/keys/ota/api-key-pepper"
broken "differing pepper copies" files 'api-key-pepper: identical copies in keys/platform and keys/ota'
cp -p "$PREFIX/pepper.orig" "$ETC/keys/ota/api-key-pepper"
rm -f "$PREFIX/pepper.orig"
install -m 0400 -o velexis-platform -g velexis-platform /dev/null "$ETC/keys/platform/document-url.key"
broken "an OTA key in the platform zone" files 'keys in the wrong zone: platform/document-url.key'
rm -f "$ETC/keys/platform/document-url.key"
chmod 0640 "$ETC/ota-backend.env"
broken "a group-readable env file" files 'env files that are not root:root 600: ota-backend.env \(root:root 640\)'
chmod 0600 "$ETC/ota-backend.env"
chmod u+w "$REL/ota-backend/dist/main.js"
broken "a writable file in a release" files 'releases/0123456789abcdef0123456789abcdef01234567 is root:velexis and read-only \(first exception: /srv/velexis/releases/.*/main.js\)'
chmod u-w "$REL/ota-backend/dist/main.js"
chmod 0755 "$ROOT/var/lib/velexis/storage"
broken "a readable storage folder" files '/var/lib/velexis/storage is velexis-ota:velexis-ota 755'
chmod 0700 "$ROOT/var/lib/velexis/storage"
rm "$ROOT/srv/velexis/current"
ln -s /tmp "$ROOT/srv/velexis/current"
broken "current outside the releases" files '/srv/velexis/current points outside /srv/velexis/releases'
rm "$ROOT/srv/velexis/current"
ln -s "$REL" "$ROOT/srv/velexis/current"
gpasswd -a "$DEPLOY_TEST_USER" velexis >/dev/null
broken "an extra member of the velexis group" users 'group velexis has exactly the five zone users'
gpasswd -d "$DEPLOY_TEST_USER" velexis >/dev/null
cp -p "$DEPLOY_HOME/.ssh/authorized_keys" "$PREFIX/authorized_keys.orig"
cat "$PREFIX/deploy-key.pub" >"$DEPLOY_HOME/.ssh/authorized_keys"
broken "a deploy key without restrict" users "1 of 1 keys of $DEPLOY_TEST_USER lack restrict"
cp -p "$PREFIX/authorized_keys.orig" "$DEPLOY_HOME/.ssh/authorized_keys"
cp -p "$ETC/caddy.env" "$PREFIX/caddy.env.orig"
sed -i -E 's/^VELEXIS_EDGE_SECRET=.*/VELEXIS_EDGE_SECRET=edge-secret-changed-on-one-side/' "$ETC/caddy.env"
broken "different edge secrets in caddy.env and ota-backend.env" envfiles 'VELEXIS_EDGE_SECRET is the same, and not empty, in caddy.env and ota-backend.env'
cp -p "$PREFIX/caddy.env.orig" "$ETC/caddy.env"

# ---- 4. a variable removed from a test copy of an env file --------------------------------------------------
step "a variable removed from a test copy of an env file"
cp -p "$ETC/ota-backend.env" "$PREFIX/ota-backend.env.orig"
sed -i -E '/^(REDIS_URL|STRIPE_SECRET_KEY_TEST)=/d' "$ETC/ota-backend.env"
broken "check-vm.sh names the removed variables" envfiles '/etc/velexis/ota-backend.env lacks variables of ota-backend.env.example: REDIS_URL STRIPE_SECRET_KEY_TEST$'
if grep -qE '^FAIL /etc/velexis/ota-backend.env lacks variables of ota-backend.env.example: REDIS_URL STRIPE_SECRET_KEY_TEST$' \
  "$OUT/broken-$N-envfiles.out"; then
  pass "check-vm.sh reports FAIL naming REDIS_URL and STRIPE_SECRET_KEY_TEST, without a value [X-020 AC3]"
else
  fail "check-vm.sh reports FAIL naming REDIS_URL and STRIPE_SECRET_KEY_TEST, without a value [X-020 AC3]"
fi
FP_REMOVED="$(fingerprint "$ETC")"
if provision "$OUT/provision-drift.log" envfiles; then rc=0; else rc=$?; fi
if [ "$rc" = 0 ] && grep -qE '^WARNING: .*/etc/velexis/ota-backend.env lacks variables of its template: REDIS_URL STRIPE_SECRET_KEY_TEST ' \
  "$OUT/provision-drift.log"; then
  pass "provision-vm.sh --steps envfiles warns: $(grep -m 1 'ota-backend.env lacks' "$OUT/provision-drift.log" | sed "s#$PREFIX#<prefix>#g") [X-020 AC3]"
else
  indent "$OUT/provision-drift.log"
  fail "provision-vm.sh --steps envfiles warns about REDIS_URL and STRIPE_SECRET_KEY_TEST (exit $rc) [X-020 AC3]"
fi
if [ "$(fingerprint "$ETC")" = "$FP_REMOVED" ]; then
  pass "provision-vm.sh --steps envfiles leaves the env file as it is (never overwritten) [X-020 AC3]"
else
  fail "provision-vm.sh --steps envfiles leaves the env file as it is (never overwritten) [X-020 AC3]"
fi
cp -p "$PREFIX/ota-backend.env.orig" "$ETC/ota-backend.env"
if run_check "$OUT/restored.out" --only envfiles,files; then
  pass "with the variables back, check-vm.sh --only envfiles,files passes again [X-020 AC3]"
else
  indent "$OUT/restored.out"
  fail "with the variables back, check-vm.sh --only envfiles,files passes again [X-020 AC3]"
fi

# ---- 5. a master-key rotation (X-040, docs/mvp/runbooks/master-key-rotation.md) ------------------------------
step "a master-key rotation: NEW_MASTER_KEY=v2, then master-v1.key removed"
K="$ETC/keys"
key_sha() { sha256sum <"$1" | cut -d' ' -f1; } # compared, never printed
without() { grep -vF -- "$1" || true; }         # the fingerprint lines that do not name the file
FP_V1="$(fingerprint "$K")"
if provision "$OUT/rotate-1.log" keys NEW_MASTER_KEY=v2 && [ -f "$K/platform/master-v2.key" ] && [ -f "$K/ota/master-v2.key" ] &&
  [ "$(key_sha "$K/platform/master-v2.key")" = "$(key_sha "$K/ota/master-v2.key")" ] &&
  [ "$(stat -c '%U:%G %a' "$K/platform/master-v2.key")" = "velexis-platform:velexis-platform 400" ] &&
  [ "$(stat -c '%U:%G %a' "$K/ota/master-v2.key")" = "velexis-ota:velexis-ota 400" ] &&
  [ "$(base64 -d <"$K/platform/master-v2.key" | wc -c)" = 32 ] &&
  ! cmp -s "$K/platform/master-v1.key" "$K/platform/master-v2.key"; then
  pass "NEW_MASTER_KEY=v2 creates master-v2.key in both zone folders with the same SHA-256 (32 new random bytes, 0400 per zone user) [X-040 AC3]"
else
  indent "$OUT/rotate-1.log"
  fail "NEW_MASTER_KEY=v2 creates master-v2.key in both zone folders with the same SHA-256 [X-040 AC3]"
fi
if [ "$(fingerprint "$K" | without master-v2.key)" = "$FP_V1" ]; then
  pass "adding master-v2.key changed no other key file [X-040 AC3]"
else
  fail "adding master-v2.key changed no other key file [X-040 AC3]"
fi
FP_V2="$(fingerprint "$K")"
if provision "$OUT/rotate-2.log" keys NEW_MASTER_KEY=v2 && [ "$(fingerprint "$K")" = "$FP_V2" ]; then
  pass "a second run with NEW_MASTER_KEY=v2 changes no key file (never overwritten) [X-040 AC3]"
else
  indent "$OUT/rotate-2.log"
  fail "a second run with NEW_MASTER_KEY=v2 changes no key file (never overwritten) [X-040 AC3]"
fi
rm -f "$K/ota/master-v2.key"
if provision "$OUT/rotate-restore.log" keys &&
  [ "$(fingerprint "$K" | without ota/master-v2.key)" = "$(printf '%s\n' "$FP_V2" | without ota/master-v2.key)" ] &&
  [ "$(key_sha "$K/platform/master-v2.key")" = "$(key_sha "$K/ota/master-v2.key")" ] &&
  [ "$(stat -c '%U:%G %a' "$K/ota/master-v2.key")" = "velexis-ota:velexis-ota 400" ]; then
  pass "a missing copy of master-v2.key is restored from the other zone folder, with the same SHA-256 [X-040 AC3]"
else
  indent "$OUT/rotate-restore.log"
  fail "a missing copy of master-v2.key is restored from the other zone folder, with the same SHA-256 [X-040 AC3]"
fi
FP_V2="$(fingerprint "$K")"
for bad in 2 v02 v0 local:v2 master-v3.key; do
  if provision "$OUT/rotate-bad.log" keys NEW_MASTER_KEY="$bad"; then rc=0; else rc=$?; fi
  if [ "$rc" != 0 ] && grep -q 'NEW_MASTER_KEY must be v<N>' "$OUT/rotate-bad.log" && [ "$(fingerprint "$K")" = "$FP_V2" ]; then
    pass "NEW_MASTER_KEY=$bad is refused and changes nothing [X-040]"
  else
    indent "$OUT/rotate-bad.log"
    fail "NEW_MASTER_KEY=$bad is refused and changes nothing (exit $rc) [X-040]"
  fi
done
if provision "$OUT/rotate-no-keys.log" envfiles NEW_MASTER_KEY=v3; then rc=0; else rc=$?; fi
if [ "$rc" != 0 ] && grep -q 'NEW_MASTER_KEY needs the step keys' "$OUT/rotate-no-keys.log" && [ "$(fingerprint "$K")" = "$FP_V2" ]; then
  pass "NEW_MASTER_KEY without the step keys is refused [X-040]"
else
  indent "$OUT/rotate-no-keys.log"
  fail "NEW_MASTER_KEY without the step keys is refused (exit $rc) [X-040]"
fi

# The end of the runbook: both backends on local:v2, the old key removed from both folders. The removed key stays
# in a root-only copy for the secret search of step 6.
( umask 077; cp "$K/platform/master-v1.key" "$PREFIX/removed-master-v1.key" )
for f in platform-backend.env ota-backend.env; do sed -i -E 's/^MASTER_KEY_CURRENT=.*/MASTER_KEY_CURRENT=local:v2/' "$ETC/$f"; done
rm -f "$K/platform/master-v1.key" "$K/ota/master-v1.key"
if run_check "$OUT/rotated.out" --only files && grep -q '^PASS /etc/velexis/keys/platform holds master-v2.key ' "$OUT/rotated.out" &&
  grep -q '^PASS /etc/velexis/keys/ota holds master-v2.key ' "$OUT/rotated.out"; then
  pass "after the rotation (MASTER_KEY_CURRENT=local:v2, master-v1.key removed) check-vm.sh --only files passes [X-040]"
else
  indent "$OUT/rotated.out"
  fail "after the rotation (MASTER_KEY_CURRENT=local:v2, master-v1.key removed) check-vm.sh --only files passes [X-040]"
fi
FP_ROTATED="$(fingerprint "$K")"
if provision "$OUT/rotate-after.log" keys && [ ! -e "$K/platform/master-v1.key" ] && [ ! -e "$K/ota/master-v1.key" ] &&
  [ "$(fingerprint "$K")" = "$FP_ROTATED" ]; then
  pass "a later run of the step keys does not create master-v1.key again and changes nothing [X-040 AC3]"
else
  indent "$OUT/rotate-after.log"
  fail "a later run of the step keys does not create master-v1.key again and changes nothing [X-040 AC3]"
fi
if provision "$OUT/rotate-reuse.log" keys NEW_MASTER_KEY=v1; then rc=0; else rc=$?; fi
if [ "$rc" != 0 ] && grep -q 'NEW_MASTER_KEY=v1 is below master-v2.key' "$OUT/rotate-reuse.log" &&
  [ "$(fingerprint "$K")" = "$FP_ROTATED" ]; then
  pass "NEW_MASTER_KEY=v1 after the rotation is refused: a version is never reused [X-040]"
else
  indent "$OUT/rotate-reuse.log"
  fail "NEW_MASTER_KEY=v1 after the rotation is refused: a version is never reused (exit $rc) [X-040]"
fi
sed -i -E 's/^MASTER_KEY_CURRENT=.*/MASTER_KEY_CURRENT=local:v3/' "$ETC/ota-backend.env"
if run_check "$OUT/rotated-missing.out" --only files; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] && grep -q '^FAIL /etc/velexis/keys/ota holds master-v3.key$' "$OUT/rotated-missing.out"; then
  pass "check-vm.sh fails when a zone lacks the master key its MASTER_KEY_CURRENT names [X-040]"
else
  indent "$OUT/rotated-missing.out"
  fail "check-vm.sh fails when a zone lacks the master key its MASTER_KEY_CURRENT names (exit $rc) [X-040]"
fi
sed -i -E 's/^MASTER_KEY_CURRENT=.*/MASTER_KEY_CURRENT=local:v2/' "$ETC/ota-backend.env"

# ---- 6. no secret in any output ------------------------------------------------------------------------------
step "no generated secret, key or env value in any output, command line or log"
PATTERNS="$PREFIX/secret-patterns" # root-only, removed with the prefix
(
  umask 077
  # The generated values (they are also inside every DSN of the env files).
  sed -n 's/^[A-Z_]*=//p' "$ETC/.provision-secrets"
  # Key files (also the master key removed in step 5) and the deploy private key: every line except PEM armour.
  cat "$ETC"/keys/platform/* "$ETC"/keys/ota/* "$PREFIX/removed-master-v1.key" "$PREFIX/deploy-key.pem" | grep -v -- '-----'
) | grep -E '.{8,}' | sort -u >"$PATTERNS"
leaks="$(grep -lF -f "$PATTERNS" "$OUT"/* "$FAKE/calls.log" "$ROOT/var/log/velexis/provision.log" 2>/dev/null || true)"
# Positive control: the same search finds a value that is there.
( umask 077; printf 'leaked %s here\n' "$(sed -n 's/^EDGE_SECRET=//p' "$ETC/.provision-secrets")" >"$PREFIX/control" )
grep -qF -f "$PATTERNS" "$PREFIX/control" || fail "the secret search finds a planted value (positive control) [X-020 AC4]"
if [ "$(wc -l <"$PATTERNS")" -ge 10 ] && [ -z "$leaks" ]; then
  pass "none of $(wc -l <"$PATTERNS") secret values appears in $(find "$OUT" -type f | wc -l) outputs, the fakes' command lines or provision.log [X-020 AC4]"
else
  fail "a secret value appears in: $(printf '%s' "$leaks" | sed "s#$PREFIX#<prefix>#g" | paste -sd' ' -) [X-020 AC4]"
fi
if grep -q 'provision-vm.sh started' "$ROOT/var/log/velexis/provision.log" &&
  [ "$(stat -c '%U:%G %a' "$ROOT/var/log/velexis/provision.log")" = "root:adm 640" ]; then
  pass "provision-vm.sh logs its runs to /var/log/velexis/provision.log (root:adm 640) [X-020 AC4]"
else
  fail "provision-vm.sh logs its runs to /var/log/velexis/provision.log (root:adm 640) [X-020 AC4]"
fi
if [ ! -e "$FAKE/violations" ]; then
  pass "no fake tool was asked to change anything, or given the Redis password on its command line [X-020 AC4]"
else
  indent "$FAKE/violations"
  fail "no fake tool was asked to change anything, or given the Redis password on its command line [X-020 AC4]"
fi

echo
if [ "$FAILED" = 0 ]; then echo "check-vm.test: all checks passed"; else echo "check-vm.test: FAILED"; fi
[ "$FAILED" = 0 ]
