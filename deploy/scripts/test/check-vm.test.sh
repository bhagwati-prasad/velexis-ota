#!/usr/bin/env bash
# =====================================================================================================
# check-vm.test.sh — tests deploy/scripts/check-vm.sh and the env file checks of provision-vm.sh (task X-020), the
# master-key rotation of provision-vm.sh's step keys (task X-040), and the SSH second factor of its step ssh (X-037).
#
#   sudo bash deploy/scripts/test/check-vm.test.sh
#
# Needs root and Ubuntu 24.04 (provision-vm.sh refuses anything else), openssl, visudo and python3 (for one unix
# socket). It needs no systemd, PostgreSQL, Redis or Caddy, and it never touches a service:
#   - provision-vm.sh runs only its steps users, keys, envfiles and ssh, under a temporary VELEXIS_ROOT (the five zone
#     users, the group velexis, a test deploy user and a test admin user are real, as in
#     deploy/systemd/test/units-smoke.sh; /etc/ssh and /etc/pam.d/sshd are test copies under VELEXIS_ROOT);
#   - check-vm.sh runs with that VELEXIS_ROOT and fake system tools first on PATH (systemctl, ufw, sshd, swapon, ss,
#     sysctl, timedatectl, runuser, psql, redis-cli, caddy, node). Each fake answers from a fixture file that the test
#     edits, logs its command line, and records as a violation any call that could change something. The step ssh
#     uses the fakes sshd and systemctl too; the fake systemctl records its reloads of ssh instead of refusing them.
#   - A real sshd validates the SSH drop-ins when one works here: CHECKVM_SSHD=<command>, else /usr/sbin/sshd
#     (package openssh-server). sshd -t and sshd -T only read files; without a working sshd the test says so and
#     checks the drop-ins with the fake alone.
# Users, groups and folders the test created are removed at the end (CHECKVM_KEEP=1 keeps them for inspection). It
# refuses to run on a provisioned Velexis VM. It prints one PASS or FAIL line per check; a check that proves an
# acceptance criterion of X-020, X-040 or X-037 ends in [X-020 AC<n>], [X-040 AC<n>] or [X-037 AC<n>].
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
#   6. The SSH second factor (X-037): provision-vm.sh --steps ssh without an enrolled FIDO2 key or TOTP secret
#      (or with one it cannot use) changes no file of sshd or PAM, reloads nothing and says why, with the enrolment
#      steps (AC3); it writes nothing when sshd -t refuses the new configuration or sshd -T would not show the second
#      factor, and puts every previous file back when sshd -t refuses the real configuration after the write; with
#      the factor enrolled it writes 01-velexis-mfa.conf (and, for TOTP, /etc/pam.d/sshd) once and reloads ssh once,
#      and a later run removes the old name 90-velexis.conf. check-vm.sh --only ssh reports PASS for the admin's FIDO2 or TOTP factor and the deploy
#      user's public key only, and FAIL for each weakened setting (AC2). With a real sshd, the same on its sshd -T.
#      Also decision 11j: velexis-healthcheck.timer and /usr/local/sbin/velexis-healthcheck are checked.
#   7. No output of either script, no command line of a fake and no line of provision.log holds a generated
#      secret, a key, a TOTP secret or a value of an env file, even when caddy validate fails with a message that
#      quotes the edge secret or caddy.env has a malformed line; provision-vm.sh substitutes no placeholder through
#      sed (AC4).
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
ADMIN_TEST_USER="vxadmin-$RUN_ID"   # the admin user of the SSH checks (X-037)
ETC="$ROOT/etc/velexis"
mkdir -p "$ROOT" "$FAKE" "$FAKEBIN" "$OUT"
chmod 0700 "$OUT" "$FAKE"

CREATED_USERS=()
CREATED_GROUPS=()
for u in "${ZONE_USERS[@]}" "$DEPLOY_TEST_USER" "$ADMIN_TEST_USER" caddy; do id -u "$u" >/dev/null 2>&1 || CREATED_USERS+=("$u"); done
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
for s in deploy:velexis-deploy backup:velexis-backup restore:velexis-restore alert:velexis-alert run-as:velexis-run \
  healthcheck:velexis-healthcheck; do
  install -D -m 0755 -o root -g root "$DEPLOY/scripts/${s%%:*}.sh" "$ROOT/usr/local/sbin/${s#*:}"
done

# The admin user of the cloud image (X-037), with public keys only: never a private key in the test.
id -u "$ADMIN_TEST_USER" >/dev/null 2>&1 || useradd --create-home --user-group --shell /bin/bash "$ADMIN_TEST_USER"
ADMIN_HOME="$(getent passwd "$ADMIN_TEST_USER" | cut -d: -f6)"
install -d -m 0700 -o "$ADMIN_TEST_USER" -g "$ADMIN_TEST_USER" "$ADMIN_HOME/.ssh"
ssh_ed25519_pub() { # comment -> an OpenSSH ssh-ed25519 public key line of a fresh key pair (the private half is dropped)
  { printf '\0\0\0\013ssh-ed25519\0\0\0\040'; openssl genpkey -algorithm ed25519 2>/dev/null | openssl pkey -pubout -outform DER | tail -c 32; } \
    | base64 -w0 | { printf 'ssh-ed25519 '; cat; printf ' %s\n' "$1"; }
}
sk_ed25519_pub() { # comment -> an sk-ssh-ed25519@openssh.com public key line (32 random bytes, application "ssh:")
  { printf '\0\0\0\032sk-ssh-ed25519@openssh.com\0\0\0\040'; openssl rand 32; printf '\0\0\0\004ssh:'; } \
    | base64 -w0 | { printf 'sk-ssh-ed25519@openssh.com '; cat; printf ' %s\n' "$1"; }
}
ADMIN_PLAIN_KEY="$(ssh_ed25519_pub "$ADMIN_TEST_USER plain key")"
ADMIN_SK_KEY="verify-required $(sk_ed25519_pub "$ADMIN_TEST_USER security key")"
ADMIN_SK_BACKUP_KEY="no-agent-forwarding,verify-required $(sk_ed25519_pub "$ADMIN_TEST_USER backup security key")"
admin_keys() { # line... -> the admin's authorized_keys, 0600 and the admin's, as an operator leaves it
  printf '%s\n' "$@" >"$ADMIN_HOME/.ssh/authorized_keys"
  chown "$ADMIN_TEST_USER:$ADMIN_TEST_USER" "$ADMIN_HOME/.ssh/authorized_keys"
  chmod 0600 "$ADMIN_HOME/.ssh/authorized_keys"
}
admin_keys "$ADMIN_SK_KEY" "$ADMIN_SK_BACKUP_KEY"   # healthy: the FIDO2 key and its backup, nothing else

# sshd and PAM as the openssh-server package installs them (Ubuntu 24.04), under the test prefix: the Include line
# names the prefix's drop-in folder, and a host key lets a real sshd load the configuration. 50-cloud-init.conf turns
# password logins on, as on some providers' images; 00-velexis.conf must win over it.
install -d -m 0755 "$ROOT/etc/ssh/sshd_config.d" "$ROOT/etc/pam.d"
openssl ecparam -name prime256v1 -genkey -noout -out "$ROOT/etc/ssh/ssh_host_ecdsa_key" 2>/dev/null
chmod 0600 "$ROOT/etc/ssh/ssh_host_ecdsa_key"
cat >"$ROOT/etc/ssh/sshd_config" <<EOF
# The test copy of Ubuntu 24.04's /etc/ssh/sshd_config (deploy/scripts/test/check-vm.test.sh): its active lines,
# with the Include folder under the test prefix and a host key.
Include $ROOT/etc/ssh/sshd_config.d/*.conf
HostKey $ROOT/etc/ssh/ssh_host_ecdsa_key
KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding yes
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
EOF
echo 'PasswordAuthentication yes' >"$ROOT/etc/ssh/sshd_config.d/50-cloud-init.conf"
cat >"$ROOT/etc/pam.d/sshd" <<'EOF'
# PAM configuration for the Secure Shell service (the test copy of Ubuntu 24.04's, its active lines)

# Standard Un*x authentication.
@include common-auth
account    required     pam_nologin.so
@include common-account
session    required     pam_loginuid.so
session    optional     pam_keyinit.so force revoke
@include common-session
session    required     pam_limits.so
@include common-password
EOF
chmod 0644 "$ROOT/etc/ssh/sshd_config" "$ROOT/etc/ssh/sshd_config.d/50-cloud-init.conf" "$ROOT/etc/pam.d/sshd"
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
quiet=0
if [ "${2:-}" = --quiet ]; then quiet=1; set -- "$1" "${3:-}"; fi
case "${1:-}" in
  is-active | is-enabled) ;;
  reload)
    # Only provision-vm.sh's step ssh may reload, and only ssh: recorded, so the test counts the reloads.
    [ "${CHECKVM_PROVISION:-}" = 1 ] && [ "$*" = "reload ssh" ] || refuse "$@"
    echo "reload ssh" >>"$F/reloads"
    exit 0 ;;
  *) refuse "$@" ;;
esac
u="${2%.service}"
read -r _ active enabled < <(awk -v u="$u" '$1 == u' "$F/units") || true
if [ "$1" = is-active ]; then
  [ "$quiet" = 1 ] || echo "${active:-inactive}"
  [ "${active:-}" = active ]
else
  [ "$quiet" = 1 ] || echo "${enabled:-not-found}"
  [ "${enabled:-}" = enabled ]
fi
EOF
fake ufw <<'EOF'
[ "$*" = "status verbose" ] || refuse "$@"
cat "$F/ufw"
EOF
fake sshd <<'EOF'
# -T [-f config] [-C user=<u>]: the fixture sshd, or sshd-user-<u> for one user's logins (the Match blocks applied).
# -t -f config: the configuration is valid, unless the fixture sshd-t-fails exists or sshd-t-fails-on names that config
# file. Both only read, as sshd does.
mode=""
spec=""
cfg=""
while [ $# -gt 0 ]; do
  case "$1" in
    -T | -t) mode="$1"; shift ;;
    -f | -C) [ $# -ge 2 ] || refuse "$@"; if [ "$1" = -f ]; then cfg="$2"; else spec="$2"; fi; shift 2 ;;
    *) refuse "$@" ;;
  esac
done
case "$mode" in
  -t)
    if [ -e "$F/sshd-t-fails" ]; then echo "sshd_config.d/01-velexis-mfa.conf line 9: Bad configuration option: Bogus" >&2; exit 255; fi
    if [ -f "$F/sshd-t-fails-on" ] && [ "$cfg" = "$(cat "$F/sshd-t-fails-on")" ]; then
      echo "sshd_config line 12: Unsupported option Bogus" >&2
      exit 255
    fi ;;
  -T)
    case "$spec" in
      "") cat "$F/sshd" ;;
      user=?*) if [ -f "$F/sshd-user-${spec#user=}" ]; then cat "$F/sshd-user-${spec#user=}"; else cat "$F/sshd"; fi ;;
      *) refuse "-C $spec" ;;
    esac ;;
  *) refuse "no -T or -t" ;;
esac
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

# The effective sshd settings of one user's login (X-037), as sshd -T -C user=<u> prints them for 01-velexis-mfa.conf.
ALL_PUBKEY_ALGS="ssh-ed25519-cert-v01@openssh.com,ecdsa-sha2-nistp256-cert-v01@openssh.com,sk-ssh-ed25519-cert-v01@openssh.com,rsa-sha2-512-cert-v01@openssh.com,ssh-ed25519,ecdsa-sha2-nistp256,sk-ssh-ed25519@openssh.com,sk-ecdsa-sha2-nistp256@openssh.com,rsa-sha2-512,rsa-sha2-256"
FIDO2_ADMIN=("authenticationmethods publickey" "pubkeyacceptedalgorithms sk-ssh-ed25519@openssh.com"
  "pubkeyauthoptions touch-required verify-required" "kbdinteractiveauthentication no" "passwordauthentication no"
  "authorizedkeysfile .ssh/authorized_keys")
TOTP_ADMIN=("authenticationmethods publickey,keyboard-interactive:pam" "kbdinteractiveauthentication yes" "usepam yes"
  "passwordauthentication no" "authorizedkeysfile .ssh/authorized_keys")
DEPLOY_LIMITS=("authenticationmethods publickey" "passwordauthentication no" "kbdinteractiveauthentication no"
  "authorizedkeysfile .ssh/authorized_keys" "permittty no" "disableforwarding yes" "allowtcpforwarding no"
  "allowagentforwarding no" "allowstreamlocalforwarding no" "x11forwarding no" "permittunnel no" "permituserrc no")
sshd_user() { # user "keyword value"... -> the fixture of sshd -T -C user=<user>: the global fixture with these values
  local user="$1" kv
  shift
  cp "$FAKE/sshd" "$FAKE/sshd-user-$user"
  for kv in "$@"; do
    awk -v k="${kv%% *}" -v line="$kv" '$1 == k { if (!done) print line; done = 1; next } { print } END { if (!done) print line }' \
      "$FAKE/sshd-user-$user" >"$FAKE/sshd-user-$user.new"
    mv "$FAKE/sshd-user-$user.new" "$FAKE/sshd-user-$user"
  done
}

healthy() { # writes the fixtures of a healthy, provisioned VM
  cat >"$FAKE/units" <<'EOF'
postgresql active enabled
postgresql@16-main active enabled-runtime
redis-server active enabled
caddy active enabled
velexis-backup.timer active enabled
velexis-healthcheck.timer active enabled
ssh active enabled
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
  # sshd -T as OpenSSH 9.6 prints it with 00-velexis.conf (the global settings), then each user's login with the
  # Match blocks of 01-velexis-mfa.conf (the admin's FIDO2 key, the deploy user's limits).
  printf '%s\n' 'port 22' 'permitrootlogin no' 'pubkeyauthentication yes' 'passwordauthentication no' \
    'kbdinteractiveauthentication no' 'usepam yes' 'maxauthtries 3' 'authenticationmethods any' \
    'authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2' "pubkeyacceptedalgorithms $ALL_PUBKEY_ALGS" \
    'pubkeyauthoptions none' 'permittty yes' 'disableforwarding no' 'allowtcpforwarding yes' 'allowagentforwarding no' \
    'allowstreamlocalforwarding yes' 'x11forwarding no' 'permittunnel no' 'permituserrc yes' \
    "allowusers $ADMIN_TEST_USER" "allowusers $DEPLOY_TEST_USER" >"$FAKE/sshd"
  sshd_user "$ADMIN_TEST_USER" "${FIDO2_ADMIN[@]}"
  sshd_user "$DEPLOY_TEST_USER" "${DEPLOY_LIMITS[@]}"
  rm -f "$FAKE/sshd-t-fails"
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
CHECK_PATH="$FAKEBIN" # section 6 puts a real sshd in front of the fakes for some runs
run_check() { # output-file args... -> check-vm.sh as root runs it on the VM, plus the test prefix and the fakes
  local out="$1"
  shift
  env PATH="$CHECK_PATH:$PATH" CHECKVM_FAKE="$FAKE" CHECKVM_SECRETS="$ETC/.provision-secrets" \
    CHECKVM_CADDYFILE="$ROOT/etc/caddy/Caddyfile" VELEXIS_ROOT="$ROOT" DEPLOY_USER="$DEPLOY_TEST_USER" \
    bash "$CHECK" "$@" >"$out" 2>&1
}

BEFORE="$(fingerprint_all "$ROOT" "$DEPLOY_HOME" "$ADMIN_HOME")"
if run_check "$OUT/healthy.out"; then rc=0; else rc=$?; fi
cat "$OUT/healthy.out"
AFTER="$(fingerprint_all "$ROOT" "$DEPLOY_HOME" "$ADMIN_HOME")"
if [ "$rc" = 0 ] && ! grep -q '^FAIL' "$OUT/healthy.out" && [ "$(grep -c '^PASS' "$OUT/healthy.out")" -ge 60 ]; then
  pass "check-vm.sh reports only PASS ($(grep -c '^PASS' "$OUT/healthy.out") items) and exits 0 on a healthy VM [X-020 AC2]"
else
  fail "check-vm.sh reports only PASS and exits 0 on a healthy VM (exit $rc) [X-020 AC2]"
fi
# Every item the task names (foundation-tasks.md, X-020 step 2; X-037 step 3 and decision 11j) has a PASS line.
covered=1
while IFS= read -r item; do
  grep -qF -- "$item" "$OUT/healthy.out" || { echo "     no PASS line for: $item"; covered=0; }
done <<EOF
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
PASS velexis-healthcheck.timer is active and enabled
PASS /usr/local/sbin/velexis-healthcheck is root:root 755
PASS sshd -T: AllowUsers $ADMIN_TEST_USER $DEPLOY_TEST_USER
PASS sshd -T -C user=$ADMIN_TEST_USER: second factor FIDO2 (publickey with sk-ssh-ed25519@openssh.com only, pubkeyauthoptions touch-required verify-required)
PASS sshd -T -C user=$ADMIN_TEST_USER: keys only from .ssh/authorized_keys
PASS every key of $ADMIN_TEST_USER is a FIDO2 key (sk-ssh-ed25519) with verify-required (2)
PASS sshd -T -C user=$DEPLOY_TEST_USER: public key only (authenticationmethods publickey)
PASS sshd -T -C user=$DEPLOY_TEST_USER: no TTY and no forwarding (permittty no, disableforwarding yes)
PASS sshd -T -C user=$DEPLOY_TEST_USER: keys only from .ssh/authorized_keys
EOF
if [ "$covered" = 1 ]; then
  pass "every item of the task has a PASS line, the SSH methods of both users included [X-020 AC2] [X-037 AC2]"
else
  fail "every item of the task has a PASS line, the SSH methods of both users included [X-020 AC2] [X-037 AC2]"
fi
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
broken() { # description group pattern [task] -> check-vm.sh --only group exits 1 with a FAIL line matching pattern
  local what="$1" group="$2" pattern="$3" tag="${4:-X-020}" out rc
  N=$((N + 1))
  out="$OUT/broken-$N-$group.out"
  if run_check "$out" --only "$group"; then rc=0; else rc=$?; fi
  if [ "$rc" = 1 ] && grep -qE -- "^FAIL .*$pattern" "$out"; then
    pass "$what: $(grep -m 1 -E -- "^FAIL .*$pattern" "$out" | cut -c 6-) [$tag]"
  else
    indent "$out"
    fail "$what (exit $rc, expected a FAIL line matching: $pattern) [$tag]"
  fi
}
edit() { sed -i -E "$2" "$FAKE/$1"; } # fixture sed-expression

edit units 's/^caddy active/caddy failed/'
broken "a stopped caddy" services 'caddy is active and enabled \(found: failed enabled\)'
healthy
edit units 's/^velexis-backup.timer active enabled/velexis-backup.timer inactive disabled/'
broken "a disabled backup timer" services 'velexis-backup.timer is active and enabled'
healthy
edit units 's/^velexis-healthcheck.timer active enabled/velexis-healthcheck.timer active disabled/'
broken "a health check timer that does not start at boot" services 'velexis-healthcheck.timer is active and enabled \(found: active disabled\)' X-037
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
# The SSH second factor (X-037): each weakened setting of the admin's or the deploy user's login is a FAIL.
sshd_user "$ADMIN_TEST_USER"
broken "an admin login without a second factor" ssh "sshd -T -C user=$ADMIN_TEST_USER: a second factor, FIDO2 or TOTP \\(found: authenticationmethods any," "X-037 AC2"
sshd_user "$ADMIN_TEST_USER" "${FIDO2_ADMIN[@]}" "pubkeyauthoptions touch-required"
broken "FIDO2 keys without user verification" ssh "user=$ADMIN_TEST_USER: a second factor, FIDO2 or TOTP \\(found: authenticationmethods publickey, pubkeyauthoptions touch-required," "X-037 AC2"
sshd_user "$ADMIN_TEST_USER" "${FIDO2_ADMIN[@]}" "pubkeyacceptedalgorithms $ALL_PUBKEY_ALGS"
broken "an admin login that accepts plain keys too" ssh "user=$ADMIN_TEST_USER: a second factor, FIDO2 or TOTP" "X-037 AC2"
sshd_user "$ADMIN_TEST_USER" "${FIDO2_ADMIN[@]}" "authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2"
broken "admin keys read from authorized_keys2 too" ssh "user=$ADMIN_TEST_USER: keys only from .ssh/authorized_keys \\(found: .ssh/authorized_keys .ssh/authorized_keys2\\)" "X-037 AC2"
healthy
admin_keys "$ADMIN_SK_KEY" "$ADMIN_PLAIN_KEY"
broken "a plain key left in the admin's authorized_keys" ssh "1 of 2 keys of $ADMIN_TEST_USER are not FIDO2 keys with verify-required" "X-037 AC2"
admin_keys "$(sk_ed25519_pub "$ADMIN_TEST_USER security key without the option")"
broken "a FIDO2 key without the option verify-required" ssh "$ADMIN_TEST_USER has a FIDO2 key \\(sk-ssh-ed25519\\) with verify-required" "X-037 AC2"
admin_keys "$ADMIN_SK_KEY" "$ADMIN_SK_BACKUP_KEY"
sshd_user "$DEPLOY_TEST_USER" "${DEPLOY_LIMITS[@]}" "permittty yes"
broken "a deploy login with a TTY" ssh "user=$DEPLOY_TEST_USER: no TTY and no forwarding \\(found: permittty yes\\)" "X-037 AC2"
sshd_user "$DEPLOY_TEST_USER" "${DEPLOY_LIMITS[@]}" "disableforwarding no" "allowtcpforwarding yes"
broken "a deploy login with forwarding" ssh "user=$DEPLOY_TEST_USER: no TTY and no forwarding \\(found: disableforwarding no, allowtcpforwarding yes\\)" "X-037 AC2"
sshd_user "$DEPLOY_TEST_USER" "${DEPLOY_LIMITS[@]}" "authenticationmethods any"
broken "a deploy login by more than a public key" ssh "user=$DEPLOY_TEST_USER: public key only \\(found: authenticationmethods any," "X-037 AC2"
healthy
echo 'allowusers root' >>"$FAKE/sshd"
broken "a second admin user without a second factor" ssh 'sshd -T -C user=root: a second factor, FIDO2 or TOTP' "X-037 AC2"
healthy
edit sshd "/^allowusers $DEPLOY_TEST_USER\$/d"
broken "a deploy user that AllowUsers leaves out" ssh "AllowUsers lets $DEPLOY_TEST_USER in" X-037
healthy
edit sshd '/^allowusers /d'
broken "no AllowUsers" ssh 'AllowUsers limits SSH logins \(found: none' X-037
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

# ---- 6. the SSH second factor (X-037): provision-vm.sh --steps ssh, check-vm.sh --only ssh ---------------------
step "the SSH second factor: provision-vm.sh --steps ssh without and with an enrolled factor"
SSH_PATH="$FAKEBIN"
provision_ssh() { # log mfa [VAR=value...]: the step ssh as an operator runs it, with the fake (or a real) sshd on PATH
  local log="$1" mfa="$2"
  shift 2
  env PATH="$SSH_PATH:$PATH" CHECKVM_FAKE="$FAKE" CHECKVM_PROVISION=1 VELEXIS_ROOT="$ROOT" ADMIN_USER="$ADMIN_TEST_USER" \
    ADMIN_MFA="$mfa" DEPLOY_USER="$DEPLOY_TEST_USER" "$@" bash "$PROVISION" --steps ssh >"$log" 2>&1
}
ssh_state() { fingerprint_all "$ROOT/etc/ssh" "$ROOT/etc/pam.d"; } # every file sshd and PAM read: inode, times, content
reloads() { if [ -f "$FAKE/reloads" ]; then grep -c . "$FAKE/reloads"; else echo 0; fi; }
BASE="$ROOT/etc/ssh/sshd_config.d/00-velexis.conf"
DROPIN="$ROOT/etc/ssh/sshd_config.d/01-velexis-mfa.conf"
PAM_FILE="$ROOT/etc/pam.d/sshd"
TOTP_MODULE="$ROOT/usr/lib/x86_64-linux-gnu/security/pam_google_authenticator.so"
TOTP_FILE="$ADMIN_HOME/.google_authenticator"
TOTP_SECRET="$(openssl rand 20 | base32 | tr -d '=\n')" # a random test secret; it must never reach an output
TOTP_SCRATCH=48213097 # an emergency code of the test file (fixed: eight digits could match a number in an output)
cp -p "$PAM_FILE" "$PREFIX/pam-sshd.orig"
totp_file() { # mode owner [kind] -> the admin's ~/.google_authenticator as google-authenticator -t writes it
  local mode="$1" owner="$2" kind="${3:-TOTP_AUTH}"
  { printf '%s\n' "$TOTP_SECRET" '" RATE_LIMIT 3 30' '" WINDOW_SIZE 3' '" DISALLOW_REUSE'
    if [ "$kind" = TOTP_AUTH ]; then echo '" TOTP_AUTH'; else echo '" HOTP_COUNTER 1'; fi
    printf '%s\n' "$TOTP_SCRATCH"; } >"$TOTP_FILE"
  chown "$owner:$owner" "$TOTP_FILE"
  chmod "$mode" "$TOTP_FILE"
}
dropin_has() { # mfa -> 01-velexis-mfa.conf has the Match blocks of that mode (root 0644)
  local line other
  [ "$(stat -c '%U:%G %a' "$DROPIN" 2>/dev/null)" = "root:root 644" ] || return 1
  while IFS= read -r line; do grep -qxF -- "$line" "$DROPIN" || { echo "     01-velexis-mfa.conf lacks: $line"; return 1; }; done <<EOF
Match User $ADMIN_TEST_USER
  PasswordAuthentication no
  AuthorizedKeysFile .ssh/authorized_keys
Match User $DEPLOY_TEST_USER
  AuthenticationMethods publickey
  PermitTTY no
  DisableForwarding yes
$(if [ "$1" = totp ]; then
  printf '%s\n' 'UsePAM yes' '  AuthenticationMethods publickey,keyboard-interactive:pam' '  KbdInteractiveAuthentication yes'
else
  printf '%s\n' '  PubkeyAcceptedAlgorithms sk-ssh-ed25519@openssh.com' '  PubkeyAuthOptions touch-required verify-required'
fi)
EOF
  # And nothing of the other mode.
  if [ "$1" = totp ]; then other=PubkeyAcceptedAlgorithms; else other=keyboard-interactive; fi
  if grep -q "$other" "$DROPIN"; then echo "     01-velexis-mfa.conf has $other"; return 1; fi
}

# The VM as X-020 left it: the admin logs in with a plain key, and no second factor is enrolled yet. The first run
# writes 00-velexis.conf (as harden always did) and no second factor.
admin_keys "$ADMIN_PLAIN_KEY"
if provision_ssh "$OUT/ssh-first.log" fido2 && [ -f "$BASE" ] && [ ! -e "$DROPIN" ] &&
  grep -qx "AllowUsers $ADMIN_TEST_USER $DEPLOY_TEST_USER" "$BASE" && grep -qx 'PasswordAuthentication no' "$BASE"; then
  pass "without an enrolled factor the step ssh writes only 00-velexis.conf (keys only, AllowUsers $ADMIN_TEST_USER $DEPLOY_TEST_USER) [X-037]"
else
  indent "$OUT/ssh-first.log"
  fail "without an enrolled factor the step ssh writes only 00-velexis.conf [X-037]"
fi

refused() { # description mfa reason-pattern -> the step ssh exits 0, changes no sshd or PAM file, reloads nothing, and
  local what="$1" mfa="$2" pattern="$3" log before rc enrol #  says why, with the enrolment steps of that factor
  N=$((N + 1))
  log="$OUT/ssh-refused-$N-$mfa.log"
  before="$(ssh_state)"
  rm -f "$FAKE/reloads"
  if [ "$mfa" = fido2 ]; then enrol="To enrol a FIDO2 key for $ADMIN_TEST_USER"; else enrol="To enrol a TOTP secret for $ADMIN_TEST_USER"; fi
  if provision_ssh "$log" "$mfa"; then rc=0; else rc=$?; fi
  if [ "$rc" = 0 ] && [ "$(ssh_state)" = "$before" ] && [ "$(reloads)" = 0 ] &&
    grep -qE -- "^WARNING: the SSH second factor of $ADMIN_TEST_USER is not applied: .*$pattern" "$log" &&
    grep -qF -- "$enrol" "$log" && grep -qF -- "--steps ssh" "$log"; then
    pass "$what: sshd and PAM unchanged, nothing reloaded, and it says why: $(grep -m 1 '^WARNING' "$log" | cut -c 10- | sed "s#$PREFIX#<prefix>#g") [X-037 AC3]"
  else
    indent "$log"
    fail "$what: sshd and PAM unchanged, nothing reloaded, and it says why (exit $rc, expected: $pattern) [X-037 AC3]"
  fi
}
refused "ADMIN_MFA=fido2 with a plain key only" fido2 'holds no FIDO2 key with user verification'
admin_keys "$ADMIN_PLAIN_KEY" "$(sk_ed25519_pub "$ADMIN_TEST_USER security key without the option")"
refused "ADMIN_MFA=fido2 with a FIDO2 key that lacks verify-required" fido2 'holds no FIDO2 key with user verification'
admin_keys "$ADMIN_PLAIN_KEY" "from=\"192.0.2.1, 192.0.2.2\",verify-required $(sk_ed25519_pub "$ADMIN_TEST_USER key behind a quoted blank")"
refused "ADMIN_MFA=fido2 with a FIDO2 key whose options it cannot read safely" fido2 'holds no FIDO2 key with user verification'
admin_keys "$ADMIN_PLAIN_KEY"
refused "ADMIN_MFA=totp without the PAM module" totp 'pam_google_authenticator.so is not installed'
install -D -m 0644 /dev/null "$TOTP_MODULE"
refused "ADMIN_MFA=totp without a TOTP secret" totp '/.google_authenticator does not exist'
totp_file 0644 "$ADMIN_TEST_USER"
refused "ADMIN_MFA=totp with a TOTP secret others can read" totp "must belong to $ADMIN_TEST_USER with mode 0400 or 0600 \\(found: $ADMIN_TEST_USER 644\\)"
totp_file 0400 root
refused "ADMIN_MFA=totp with a TOTP secret of another user" totp "must belong to $ADMIN_TEST_USER with mode 0400 or 0600 \\(found: root 400\\)"
totp_file 0400 "$ADMIN_TEST_USER" HOTP_COUNTER
refused "ADMIN_MFA=totp with a counter-based secret" totp 'is not time-based'
totp_file 0400 "$ADMIN_TEST_USER"
sed -i '/^@include common-auth$/d' "$PAM_FILE"
refused "ADMIN_MFA=totp with an /etc/pam.d/sshd it does not recognise" totp "has no '@include common-auth' line"
cp -p "$PREFIX/pam-sshd.orig" "$PAM_FILE"
sed -i '1a auth required pam_google_authenticator.so nullok' "$PAM_FILE"
refused "ADMIN_MFA=totp with a nullok TOTP line in /etc/pam.d/sshd" totp 'has another pam_google_authenticator line'
cp -p "$PREFIX/pam-sshd.orig" "$PAM_FILE"
rm -f "$TOTP_FILE"

# Enrolled, but the new configuration does not pass: nothing is written, nothing reloaded, and the run fails.
guard() { # description mfa pattern -> the step ssh exits 1 with that message and changes nothing
  local what="$1" mfa="$2" pattern="$3" log before rc
  N=$((N + 1))
  log="$OUT/ssh-guard-$N.log"
  before="$(ssh_state)"
  rm -f "$FAKE/reloads"
  if provision_ssh "$log" "$mfa"; then rc=0; else rc=$?; fi
  if [ "$rc" = 1 ] && [ "$(ssh_state)" = "$before" ] && [ "$(reloads)" = 0 ] && grep -qE -- "^ERROR: .*$pattern" "$log"; then
    pass "$what: nothing written or reloaded: $(grep -m 1 '^ERROR' "$log" | cut -c 8- | sed "s#$PREFIX#<prefix>#g") [X-037]"
  else
    indent "$log"
    fail "$what: nothing written or reloaded (exit $rc, expected: $pattern) [X-037]"
  fi
}
admin_keys "$ADMIN_SK_KEY" "$ADMIN_PLAIN_KEY" # enrolled; the plain key still there until the FIDO2 login works
touch "$FAKE/sshd-t-fails"
guard "sshd -t refuses the new configuration" fido2 'sshd -t refuses the new SSH settings, so nothing changed'
rm -f "$FAKE/sshd-t-fails"
sshd_user "$ADMIN_TEST_USER" # as if another drop-in won for the admin: sshd -T shows no second factor
guard "sshd -T would not show the second factor" fido2 "the new SSH settings would not be in force: for $ADMIN_TEST_USER, sshd -T shows authenticationmethods any, not publickey"
sshd_user "$ADMIN_TEST_USER" "${FIDO2_ADMIN[@]}"
sshd_user "$DEPLOY_TEST_USER" "${DEPLOY_LIMITS[@]}" "permittty yes"
guard "sshd -T would not show the deploy limits" fido2 "for $DEPLOY_TEST_USER, sshd -T shows permittty yes, not no"
healthy

# Enrolled: the drop-in once, one reload, then nothing on a second run.
rm -f "$FAKE/reloads"
if provision_ssh "$OUT/ssh-fido2.log" fido2 && dropin_has fido2 && [ "$(reloads)" = 1 ] &&
  cmp -s "$PAM_FILE" "$PREFIX/pam-sshd.orig" && grep -q 'Keep this session open' "$OUT/ssh-fido2.log"; then
  pass "ADMIN_MFA=fido2 with an enrolled key writes 01-velexis-mfa.conf (FIDO2 for the admin, limits for deploy), leaves PAM alone and reloads ssh once [X-037]"
else
  indent "$OUT/ssh-fido2.log"
  fail "ADMIN_MFA=fido2 with an enrolled key writes 01-velexis-mfa.conf and reloads ssh once (reloads: $(reloads)) [X-037]"
fi
rm -f "$FAKE/reloads"
before="$(ssh_state)"
if provision_ssh "$OUT/ssh-fido2-again.log" fido2 && [ "$(ssh_state)" = "$before" ] && [ "$(reloads)" = 0 ]; then
  pass "a second run with ADMIN_MFA=fido2 changes nothing and reloads nothing [X-037]"
else
  indent "$OUT/ssh-fido2-again.log"
  fail "a second run with ADMIN_MFA=fido2 changes nothing and reloads nothing (reloads: $(reloads)) [X-037]"
fi
admin_keys "$ADMIN_SK_KEY" "$ADMIN_SK_BACKUP_KEY" # the runbook: the plain key goes once the FIDO2 logins work
if run_check "$OUT/ssh-fido2-check.out" --only ssh && grep -q "^PASS sshd -T -C user=$ADMIN_TEST_USER: second factor FIDO2" "$OUT/ssh-fido2-check.out" &&
  grep -q "^PASS sshd -T -C user=$DEPLOY_TEST_USER: public key only" "$OUT/ssh-fido2-check.out"; then
  pass "check-vm.sh --only ssh: PASS for the admin's FIDO2 key and the deploy user's public key only [X-037 AC2]"
else
  indent "$OUT/ssh-fido2-check.out"
  fail "check-vm.sh --only ssh: PASS for the admin's FIDO2 key and the deploy user's public key only [X-037 AC2]"
fi

# TOTP: the drop-in, /etc/pam.d/sshd with the module instead of the password, one reload; check-vm.sh's TOTP items.
totp_file 0400 "$ADMIN_TEST_USER"
sshd_user "$ADMIN_TEST_USER" "${TOTP_ADMIN[@]}" # sshd -T as it shows the TOTP drop-in
rm -f "$FAKE/reloads"
if provision_ssh "$OUT/ssh-totp.log" totp && dropin_has totp && [ "$(reloads)" = 1 ] &&
  [ "$(grep -cxF 'auth required pam_google_authenticator.so' "$PAM_FILE")" = 1 ] && grep -qx '#@include common-auth' "$PAM_FILE" &&
  ! grep -qx '@include common-auth' "$PAM_FILE" && grep -qx '@include common-account' "$PAM_FILE" &&
  [ "$(stat -c '%U:%G %a' "$PAM_FILE")" = "root:root 644" ]; then
  pass "ADMIN_MFA=totp with an enrolled secret writes the TOTP drop-in and puts pam_google_authenticator in place of the password in /etc/pam.d/sshd, one reload [X-037]"
else
  indent "$OUT/ssh-totp.log"
  fail "ADMIN_MFA=totp with an enrolled secret writes the TOTP drop-in and /etc/pam.d/sshd, one reload (reloads: $(reloads)) [X-037]"
fi
rm -f "$FAKE/reloads"
before="$(ssh_state)"
if provision_ssh "$OUT/ssh-totp-again.log" totp && [ "$(ssh_state)" = "$before" ] && [ "$(reloads)" = 0 ]; then
  pass "a second run with ADMIN_MFA=totp changes nothing and reloads nothing [X-037]"
else
  indent "$OUT/ssh-totp-again.log"
  fail "a second run with ADMIN_MFA=totp changes nothing and reloads nothing (reloads: $(reloads)) [X-037]"
fi
if run_check "$OUT/ssh-totp-check.out" --only ssh && grep -q "^PASS sshd -T -C user=$ADMIN_TEST_USER: second factor TOTP" "$OUT/ssh-totp-check.out" &&
  grep -q "^PASS $TOTP_FILE is a time-based TOTP secret file, $ADMIN_TEST_USER 400" "$OUT/ssh-totp-check.out" &&
  grep -q '^PASS /etc/pam.d/sshd asks for the TOTP code' "$OUT/ssh-totp-check.out"; then
  pass "check-vm.sh --only ssh: PASS for the admin's key and TOTP code (sshd, secret file, PAM) [X-037 AC2]"
else
  indent "$OUT/ssh-totp-check.out"
  fail "check-vm.sh --only ssh: PASS for the admin's key and TOTP code (sshd, secret file, PAM) [X-037 AC2]"
fi
cp -p "$PAM_FILE" "$PREFIX/pam-sshd.totp"
sed -i 's/^auth required pam_google_authenticator.so$/& nullok/' "$PAM_FILE"
broken "a TOTP line with nullok" ssh '/etc/pam.d/sshd asks for the TOTP code only \(found: nullok' "X-037 AC2"
cp -p "$PREFIX/pam-sshd.totp" "$PAM_FILE"
sed -i 's/^#@include common-auth$/@include common-auth/' "$PAM_FILE"
broken "a password asked before the TOTP code" ssh '/etc/pam.d/sshd asks for the TOTP code only \(found: @include common-auth\)' "X-037 AC2"
cp -p "$PREFIX/pam-sshd.totp" "$PAM_FILE"
chmod 0644 "$TOTP_FILE"
broken "a TOTP secret others can read" ssh "$TOTP_FILE is a time-based TOTP secret file of $ADMIN_TEST_USER, 0400 or 0600 \\(found: $ADMIN_TEST_USER 644\\)" "X-037 AC2"
chmod 0400 "$TOTP_FILE"

# Back to FIDO2, the healthy state of the other sections.
healthy
if provision_ssh "$OUT/ssh-back-to-fido2.log" fido2 && dropin_has fido2; then
  pass "ADMIN_MFA=fido2 replaces the TOTP drop-in [X-037]"
else
  indent "$OUT/ssh-back-to-fido2.log"
  fail "ADMIN_MFA=fido2 replaces the TOTP drop-in [X-037]"
fi

# The copy passes, but sshd -t refuses the real configuration once the new files are in place (say, because of a line
# outside sshd_config.d that the copy does not hold): every previous file comes back, nothing is reloaded, the run fails.
ssh_content() { # the files sshd and PAM read: path, mode, owner, type and SHA-256 (a restored file is a rewrite, so
  find "$ROOT/etc/ssh" "$ROOT/etc/pam.d" -printf '%p %m %u:%g %y\n' | sort # its times and inode may differ)
  find "$ROOT/etc/ssh" "$ROOT/etc/pam.d" -type f -exec sha256sum {} + | sort -k 2
}
restored() { # description mfa -> the step ssh exits 1, says the previous files are back, they are, and nothing reloaded
  local what="$1" mfa="$2" log before rc
  N=$((N + 1))
  log="$OUT/ssh-restored-$N.log"
  before="$(ssh_content)"
  rm -f "$FAKE/reloads"
  printf '%s\n' "$ROOT/etc/ssh/sshd_config" >"$FAKE/sshd-t-fails-on"
  if provision_ssh "$log" "$mfa"; then rc=0; else rc=$?; fi
  rm -f "$FAKE/sshd-t-fails-on"
  if [ "$rc" = 1 ] && [ "$(ssh_content)" = "$before" ] && [ "$(reloads)" = 0 ] &&
    grep -qF -- "with the new files; the previous files are back: sshd_config line 12" "$log"; then
    pass "$what: the previous files are back, nothing reloaded: $(grep -m 1 '^ERROR' "$log" | cut -c 8- | sed "s#$PREFIX#<prefix>#g") [X-037]"
  else
    indent "$log"
    fail "$what: the previous files are back and nothing reloaded (exit $rc, reloads: $(reloads)) [X-037]"
  fi
}
OLD_NAME="$ROOT/etc/ssh/sshd_config.d/90-velexis.conf" # the name of 00-velexis.conf before X-020's fix
mv "$DROPIN" "$PREFIX/01-velexis-mfa.conf.saved"
restored "sshd -t refuses the real configuration with a new 01-velexis-mfa.conf" fido2
mv "$PREFIX/01-velexis-mfa.conf.saved" "$DROPIN"
cp -p "$PREFIX/pam-sshd.orig" "$PAM_FILE"
printf 'PasswordAuthentication yes\n' >"$OLD_NAME"
sshd_user "$ADMIN_TEST_USER" "${TOTP_ADMIN[@]}"
restored "sshd -t refuses the real configuration with the TOTP drop-in, /etc/pam.d/sshd and 90-velexis.conf removed" totp
healthy
# The old name goes on the next run, with one reload; nothing else changes.
rm -f "$FAKE/reloads"
if provision_ssh "$OUT/ssh-old-name.log" fido2 && [ ! -e "$OLD_NAME" ] && dropin_has fido2 && [ "$(reloads)" = 1 ] &&
  cmp -s "$PAM_FILE" "$PREFIX/pam-sshd.orig" && grep -q 'SSH settings changed: 90-velexis.conf$' "$OUT/ssh-old-name.log"; then
  pass "the step ssh removes the old 90-velexis.conf and reloads ssh once [X-037]"
else
  indent "$OUT/ssh-old-name.log"
  fail "the step ssh removes the old 90-velexis.conf and reloads ssh once (reloads: $(reloads)) [X-037]"
fi

step "the SSH drop-ins with a real sshd (sshd -t, sshd -T -C)"
REAL_SSHD="${CHECKVM_SSHD:-/usr/sbin/sshd}"
REAL_SSHD_RAN=0
printf 'HostKey %s\n' "$ROOT/etc/ssh/ssh_host_ecdsa_key" >"$PREFIX/sshd-probe.conf"
if [ -x "$REAL_SSHD" ] && "$REAL_SSHD" -t -f "$PREFIX/sshd-probe.conf" >"$OUT/sshd-probe.out" 2>&1; then
  REAL_SSHD_RAN=1
  install -d -m 0755 "$PREFIX/realbin"
  ln -s "$REAL_SSHD" "$PREFIX/realbin/sshd"
  CHECK_PATH="$PREFIX/realbin:$FAKEBIN"
  SSH_PATH="$PREFIX/realbin:$FAKEBIN"
  # The drop-ins the step ssh wrote (with 50-cloud-init.conf's PasswordAuthentication yes beside them).
  if run_check "$OUT/real-fido2.out" --only ssh && grep -q "^PASS sshd -T -C user=$ADMIN_TEST_USER: second factor FIDO2" "$OUT/real-fido2.out" &&
    grep -q '^PASS sshd -T: passwordauthentication no' "$OUT/real-fido2.out"; then
    pass "real sshd -T: check-vm.sh --only ssh passes on the FIDO2 drop-in, and 00-velexis.conf wins over 50-cloud-init.conf [X-037 AC2]"
  else
    indent "$OUT/real-fido2.out"
    fail "real sshd -T: check-vm.sh --only ssh passes on the FIDO2 drop-in [X-037 AC2]"
  fi
  mv "$DROPIN" "$PREFIX/01-velexis-mfa.conf.fido2"
  if run_check "$OUT/real-none.out" --only ssh; then rc=0; else rc=$?; fi
  if [ "$rc" = 1 ] && grep -q "^FAIL sshd -T -C user=$ADMIN_TEST_USER: a second factor, FIDO2 or TOTP (found: authenticationmethods any" "$OUT/real-none.out" &&
    grep -q "^FAIL sshd -T -C user=$DEPLOY_TEST_USER: public key only (found: authenticationmethods any" "$OUT/real-none.out"; then
    pass "real sshd -T: without 01-velexis-mfa.conf check-vm.sh reports FAIL for both users' methods [X-037 AC2]"
  else
    indent "$OUT/real-none.out"
    fail "real sshd -T: without 01-velexis-mfa.conf check-vm.sh reports FAIL for both users' methods (exit $rc) [X-037 AC2]"
  fi
  for mfa in totp fido2; do
    if provision_ssh "$OUT/real-provision-$mfa.log" "$mfa" && dropin_has "$mfa" && run_check "$OUT/real-$mfa-check.out" --only ssh &&
      grep -q "^PASS sshd -T -C user=$ADMIN_TEST_USER: second factor ${mfa^^}" "$OUT/real-$mfa-check.out"; then
      pass "real sshd: the step ssh validates and writes the $mfa drop-in, and check-vm.sh --only ssh passes on it [X-037 AC2]"
    else
      indent "$OUT/real-provision-$mfa.log"
      [ ! -f "$OUT/real-$mfa-check.out" ] || indent "$OUT/real-$mfa-check.out"
      fail "real sshd: the step ssh validates and writes the $mfa drop-in, and check-vm.sh --only ssh passes on it [X-037 AC2]"
    fi
  done
  if cmp -s "$DROPIN" "$PREFIX/01-velexis-mfa.conf.fido2"; then
    pass "the step ssh writes the same FIDO2 drop-in with the real sshd as with the fake [X-037]"
  else
    fail "the step ssh writes the same FIDO2 drop-in with the real sshd as with the fake [X-037]"
  fi
  # An earlier drop-in with its own Match block for the admin wins: the real sshd -T of the copy shows it, so the step
  # refuses TOTP and changes nothing.
  printf 'Match User %s\n  AuthenticationMethods any\n' "$ADMIN_TEST_USER" >"$ROOT/etc/ssh/sshd_config.d/00-aaa-other.conf"
  guard "real sshd -T: an earlier Match block that would win over the second factor" totp \
    "the new SSH settings would not be in force: for $ADMIN_TEST_USER, sshd -T shows authenticationmethods any"
  rm -f "$ROOT/etc/ssh/sshd_config.d/00-aaa-other.conf"
  CHECK_PATH="$FAKEBIN"
  SSH_PATH="$FAKEBIN"
else
  echo "NOTE the real-sshd checks did not run: no working sshd at $REAL_SSHD ($(head -n 1 "$OUT/sshd-probe.out" 2>/dev/null || echo 'not installed')); install openssh-server or set CHECKVM_SSHD=<sshd command>"
fi
rm -f "$TOTP_MODULE" "$TOTP_FILE"
cp -p "$PREFIX/pam-sshd.orig" "$PAM_FILE"

# ---- 7. no secret in any output ------------------------------------------------------------------------------
step "no generated secret, key or env value in any output, command line or log"
PATTERNS="$PREFIX/secret-patterns" # root-only, removed with the prefix
(
  umask 077
  # The generated values (they are also inside every DSN of the env files).
  sed -n 's/^[A-Z_]*=//p' "$ETC/.provision-secrets"
  # Key files (also the master key removed in step 5) and the deploy private key: every line except PEM armour.
  cat "$ETC"/keys/platform/* "$ETC"/keys/ota/* "$PREFIX/removed-master-v1.key" "$PREFIX/deploy-key.pem" | grep -v -- '-----'
  # The admin's TOTP secret of step 6 and the test host key.
  printf '%s\n' "$TOTP_SECRET"
  grep -v -- '-----' "$ROOT/etc/ssh/ssh_host_ecdsa_key"
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
if [ "$FAILED" != 0 ]; then
  echo "check-vm.test: FAILED"
elif [ "$REAL_SSHD_RAN" = 1 ]; then
  echo "check-vm.test: all checks passed"
else
  echo "check-vm.test: all checks passed (the real-sshd checks of step 6 did not run: see the NOTE above)"
fi
[ "$FAILED" = 0 ]
