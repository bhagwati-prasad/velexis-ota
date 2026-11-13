#!/usr/bin/env bash
# =====================================================================================================
# check-vm.test.sh — tests deploy/scripts/check-vm.sh and the env file checks of provision-vm.sh (task X-020), the
# master-key rotation of provision-vm.sh's step keys (task X-040), the SSH second factor of its step ssh (X-037) and
# its lockout guard, and check-vm.sh's check of AIDE's daily timer (lead decisions (13k) and (13j) of 2026-11-10), and
# the guard's check of the SSH source address against SSH_ALLOW_FROM (lead decision (15d) of 2026-11-11).
#
#   sudo bash deploy/scripts/test/check-vm.test.sh
#
# Needs root and Ubuntu 24.04 (provision-vm.sh refuses anything else), openssl, visudo and python3 (for one unix
# socket). It needs no systemd, PostgreSQL, Redis or Caddy, and it never touches a service:
#   - provision-vm.sh runs only its steps users, keys, envfiles, ssh and egress, under a temporary VELEXIS_ROOT (the
#     five zone users, the group velexis, a test deploy user and a test admin user are real, as in
#     deploy/systemd/test/units-smoke.sh; /etc/ssh, /etc/pam.d/sshd, /etc/apt, /etc/systemd/system and
#     /run/systemd/resolve are test copies under VELEXIS_ROOT);
#   - check-vm.sh runs with that VELEXIS_ROOT and fake system tools first on PATH (systemctl, ufw, nft, sshd, swapon,
#     ss, sysctl, timedatectl, runuser, psql, redis-cli, caddy, node; getent and chronyc for velexis-egress). Each fake
#     answers from a fixture file that the test edits, logs its command line, and records as a violation any call that
#     could change something. The step ssh uses the fakes sshd and systemctl too; the fake systemctl records its reloads
#     of ssh instead of refusing them, and the step egress's daemon-reload and enable of its two units; the fake nft
#     keeps the table velexis-egress loads (nft -f) and lists it as nft 1.0.9 does.
#   - A real nft checks the outbound allow-list in a private network namespace (unshare -n): CHECKVM_NFT=<command>,
#     else /usr/sbin/nft (package nftables). It never touches the host's own rules. Without one that works here the
#     test fails (lead decision (17a) of 2026-11-11, owner-approved): a FAIL line and the last line name the real-nft
#     checks that did not run, so no run can pass on the fake alone.
#   - A real sshd validates the SSH drop-ins when one works here: CHECKVM_SSHD=<command>, else /usr/sbin/sshd
#     (package openssh-server). sshd -t and sshd -T only read files; without a working sshd the test says so and
#     checks the drop-ins with the fake alone.
# Users, groups and folders the test created are removed at the end (CHECKVM_KEEP=1 keeps them for inspection). It
# refuses to run on a provisioned Velexis VM. It prints one PASS or FAIL line per check; a check that proves an
# acceptance criterion of X-020, X-040 or X-037 ends in [X-020 AC<n>], [X-040 AC<n>] or [X-037 AC<n>]; a check of
# the lead's fix of 2026-11-10 (the AIDE timer, the lockout guard) in [FIX-W47-SHARED AC4] or [FIX-W47-SHARED AC5], of
# the fix of 2026-11-11 (the SSH source address) in [FIX-W48-SHARED AC5], the real-nft part that must run (lead
# decision (17a) of 2026-11-11) in [FIX-W49-SHARED AC4], and the security logs' timers and auditd's syslog plugin (lead
# decision (20p) of 2026-11-13) in [FIX-W51-SHARED 20p], and AIDE's settings in 90_velexis (lead decision (21l) of
# 2026-11-13) in [FIX-W52-SHARED 21l].
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
#      AIDE's daily check (lead decision (13j) of 2026-11-10, [FIX-W47-SHARED AC4]): PASS for an active and enabled
#      dailyaidecheck.timer, FAIL for one stopped, not enabled or missing. The security logs of X-038 (lead decision
#      (20p) of 2026-11-13, [FIX-W51-SHARED 20p]): PASS for active and enabled velexis-ship-logs.timer and
#      velexis-log-review.timer and for auditd's syslog plugin as provision-vm.sh writes it (its text read from
#      provision-vm.sh), FAIL for a timer stopped, not enabled or missing, and for the plugin's file missing, switched
#      off, sending the other way or naming no executable audisp-syslog. AIDE's settings (lead decision (21l) of
#      2026-11-13, [FIX-W52-SHARED 21l]): PASS for /etc/aide/aide.conf.d/90_velexis as provision-vm.sh's step harden
#      writes it (its text read from provision-vm.sh), FAIL for report_level=added_removed_entries or the apt lists'
#      rule missing, changed or commented out, for both missing and for the file missing.
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
#      The lockout guard (lead decision (13k) of 2026-11-10, [FIX-W47-SHARED AC5]): run through sudo by a user the new
#      AllowUsers leaves out, the step ssh (also after the steps users and keys) refuses before any step, exits 1 and
#      changes and reloads nothing; run by the admin through sudo with a second factor that sshd -T would ask of them
#      and they have not enrolled (a TOTP code, or a FIDO2 key; also on a real sshd), it refuses before writing; a root
#      session without sudo, root's own sudo, the deploy user and the admin with the factor enrolled are let through.
#      harden, which cannot run under VELEXIS_ROOT, gets the same guard: read from provision-vm.sh.
#      The SSH source (lead decision (15d) of 2026-11-11, [FIX-W48-SHARED AC5]): with SSH_ALLOW_FROM an IPv4 or IPv6
#      range, a run whose SSH login comes from outside it (SSH_CONNECTION, or who -m when sudo dropped it; through sudo
#      or as root; an IPv6 login and an IPv4 range) refuses before any step, exits 1 and changes and reloads nothing,
#      and so does a run through sudo that cannot tell its source (no terminal, no SSH_CONNECTION; a remote host that is
#      no address) and a malformed SSH_ALLOW_FROM; a login inside the range (IPv4, IPv6 also with a prefix that ends
#      inside a hex digit, an IPv4-mapped IPv6 address, from who -m too), a session without an SSH login (a console terminal, a root session without one) and
#      SSH_ALLOW_FROM=any (who is never asked) are let through.
#   7. No output of either script, no command line of a fake and no line of provision.log holds a generated
#      secret, a key, a TOTP secret or a value of an env file, even when caddy validate fails with a message that
#      quotes the edge secret or caddy.env has a malformed line; provision-vm.sh substitutes no placeholder through
#      sed (AC4).
#   8. The outbound allow-list (task X-041, PCI DSS 11.5.1.1; [X-041 AC1] for its first acceptance criterion): the step
#      egress installs deploy/egress/allowed-hosts.conf, velexis-egress and its two units, loads the table inet
#      velexis_egress once (policy drop, loopback and replies accepted first, the list's hosts resolved through fake
#      lookups, the tokens read from the VM's resolv.conf, chronyc, env files and rclone.conf, refusals logged) and
#      enables the service and the timer; a second run changes no file, loads nothing and calls no systemctl; harden
#      runs the step too, after the step node (read from provision-vm.sh). It refuses, changing nothing, a malformed list
#      and an apt source the list leaves out. check-vm.sh --only firewall reports PASS for it (step 2) and FAIL, naming
#      the item, for outgoing connections allowed by default, no table, a destination missing from allowed-hosts.conf
#      (an unknown host, a listed host on another port, an address without a comment, an address added by hand under a
#      listed host's comment that the refresh did not keep for it), refusals not logged, an extra or a
#      missing rule, a stopped refresh timer, a service not enabled for boot, an emergency opening, a line without an
#      address, an SMTP URL on another port than its line's (the one it names, or its scheme's when it names none),
#      a resolver of DNS_RESOLVERS without its lines (named by its place, never its value), an Amadeus base URL
#      whose host has no line (named by its variable, the official hosts and the loopback stub pass), an installed list or
#      velexis-egress that is not the release's, a failing refresh and an apt source outside the list. velexis-egress
#      keeps a host's last good addresses while its lookup fails, adds a new answer and keeps the earlier ones for 24
#      hours, repairs a table changed by hand without touching an emergency opening, and alerts once for a run of
#      failures. The list names every host of the step packages and the official Amadeus hosts, and no VM-side script
#      or unit names GitHub. With a real nft, the same table loads, a second run changes nothing, and check-vm.sh
#      passes on it and names changes made by hand; without a working nft the test fails ([FIX-W49-SHARED AC4]).
#      Neither the SMTP password nor the bucket key that velexis-egress reads hosts beside reaches an output (step 7).
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
# auditd's syslog plugin as provision-vm.sh's step scripts writes it (X-038): the text of its function
# audit_records_to_journal, read from provision-vm.sh, and the plugin's program, which the auditd package installs.
sed -n "/<<'PLUGIN'\$/,/^PLUGIN\$/{/PLUGIN/d;p}" "$PROVISION" >"$PREFIX/audit-syslog.conf"
if ! grep -qx 'active = yes' "$PREFIX/audit-syslog.conf" || ! grep -qx 'path = /sbin/audisp-syslog' "$PREFIX/audit-syslog.conf"; then
  die "provision-vm.sh's syslog plugin settings (heredoc PLUGIN of audit_records_to_journal) were not found"
fi
install -d -m 0750 "$ROOT/etc/audit/plugins.d"
audit_plugin_healthy() { # the plugin's file and program as provision-vm.sh and the auditd package leave them
  cmp -s "$PREFIX/audit-syslog.conf" "$ROOT/etc/audit/plugins.d/syslog.conf" \
    || install -m 0640 "$PREFIX/audit-syslog.conf" "$ROOT/etc/audit/plugins.d/syslog.conf"
  [ -x "$ROOT/sbin/audisp-syslog" ] || install -D -m 0755 /dev/null "$ROOT/sbin/audisp-syslog"
}
audit_plugin_healthy
# AIDE's 90_velexis as provision-vm.sh's step harden writes it (lead decision (21l) of 2026-11-13): the text of its
# heredoc AIDE, read from provision-vm.sh.
sed -n "/90_velexis <<'AIDE'\$/,/^AIDE\$/p" "$PROVISION" | sed '1d;$d' >"$PREFIX/aide-90_velexis"
if ! grep -qxF 'report_level=added_removed_entries' "$PREFIX/aide-90_velexis" ||
  ! grep -qxF '/var/lib/apt/lists/[^/]+$ f VarFile' "$PREFIX/aide-90_velexis" || grep -q '<<' "$PREFIX/aide-90_velexis"; then
  die "provision-vm.sh's AIDE settings (heredoc AIDE of the step harden, /etc/aide/aide.conf.d/90_velexis) were not found"
fi
install -d -m 0755 "$ROOT/etc/aide/aide.conf.d"
aide_conf_healthy() { # 90_velexis as provision-vm.sh leaves it
  cmp -s "$PREFIX/aide-90_velexis" "$ROOT/etc/aide/aide.conf.d/90_velexis" \
    || install -m 0644 "$PREFIX/aide-90_velexis" "$ROOT/etc/aide/aide.conf.d/90_velexis"
}
aide_conf_healthy
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
  daemon-reload | enable)
    # Only the step egress (X-041) may, and only for its two units: recorded, and the unit's state updated.
    [ "${CHECKVM_PROVISION:-}" = 1 ] || refuse "$@"
    case "$*" in
      daemon-reload) ;;
      "enable velexis-egress-refresh.service")
        awk '$1 != "velexis-egress-refresh"' "$F/units" >"$F/units.new"
        echo "velexis-egress-refresh inactive enabled" >>"$F/units.new"
        mv "$F/units.new" "$F/units" ;;
      "enable --now velexis-egress-refresh.timer")
        awk '$1 != "velexis-egress-refresh.timer"' "$F/units" >"$F/units.new"
        echo "velexis-egress-refresh.timer active enabled" >>"$F/units.new"
        mv "$F/units.new" "$F/units" ;;
      *) refuse "$@" ;;
    esac
    echo "$*" >>"$F/egress-systemctl"
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
# The outbound allow-list (X-041). nft keeps one table in $F/nft (exists, policy, rules, sets, set.<name>) and prints it
# as nft 1.0.9 does; it loads (-f) only the statements velexis-egress writes, only for provision-vm.sh and velexis-egress
# (CHECKVM_PROVISION=1), counts each load in $F/nft-applies and fails while $F/nft-fails exists. check-vm.sh may only list.
fake nft <<'EOF'
N="$F/nft"
render() {
  local s first=1 t
  printf 'table inet velexis_egress {\n'
  while read -r s; do
    [ "$first" = 1 ] || printf '\n'
    first=0
    case "$s" in *4) t=ipv4_addr ;; *) t=ipv6_addr ;; esac
    printf '\tset %s {\n\t\ttype %s . inet_proto . inet_service\n' "$s" "$t"
    case "$s" in emergency*) printf '\t\tflags timeout\n' ;; esac
    if [ -s "$N/set.$s" ]; then
      awk 'NR == 1 { line = "\t\telements = { " $0; next } { print line ","; line = "\t\t\t     " $0 } END { print line " }" }' "$N/set.$s"
    fi
    printf '\t}\n'
  done <"$N/sets"
  printf '\n\tchain output {\n\t\ttype filter hook output priority filter; policy %s;\n' "$(cat "$N/policy")"
  sed 's/^/\t\t/' "$N/rules"
  printf '\t}\n}\n'
}
case "$*" in
  "list table inet velexis_egress")
    if [ -f "$N/exists" ]; then render; else echo "Error: No such file or directory; did you mean table 'velexis_egress' in family inet?" >&2; exit 1; fi ;;
  "-f "*)
    [ "${CHECKVM_PROVISION:-}" = 1 ] && [ $# = 2 ] || refuse "$@"
    if [ -e "$F/nft-fails" ]; then echo "Error: Could not process rule: Operation not supported" >&2; exit 1; fi
    echo applied >>"$F/nft-applies"
    mkdir -p "$N"
    [ -f "$N/sets" ] || : >"$N/sets"
    while IFS= read -r l; do
      case "$l" in
        "add table inet velexis_egress") touch "$N/exists" ;;
        "add set inet velexis_egress "*)
          s="${l#add set inet velexis_egress }"
          s="${s%% *}"
          grep -qx "$s" "$N/sets" || echo "$s" >>"$N/sets"
          [ -f "$N/set.$s" ] || : >"$N/set.$s" ;;
        "add chain inet velexis_egress output "*) p="${l##*policy }"; echo "${p%%;*}" >"$N/policy" ;;
        "flush chain inet velexis_egress output") : >"$N/rules" ;;
        "add rule inet velexis_egress output "*) echo "${l#add rule inet velexis_egress output }" >>"$N/rules" ;;
        "flush set inet velexis_egress "*) : >"$N/set.${l##* }" ;;
        "add element inet velexis_egress "*)
          r="${l#add element inet velexis_egress }"
          e="${r#* \{ }"
          echo "${e% \}}" >>"$N/set.${r%% *}" ;;
        *) echo "fake nft: unknown statement: $l" >&2; exit 1 ;;
      esac
    done <"$2" ;;
  --version) echo "nftables v1.0.9 (fake)" ;;
  *) refuse "$@" ;;
esac
EOF
# getent ahosts answers from $F/getent-hosts ("<name> <address>..."; an address is its own answer); every other
# database is the real getent's (the users and groups of the test are real).
fake getent <<'EOF'
case "${1:-}" in
  ahosts)
    [ $# = 2 ] || refuse "$@"
    if [[ "$2" =~ ^[0-9.]+$ ]] || [[ "$2" == *:* ]]; then printf '%s      STREAM %s\n%s      DGRAM\n' "$2" "$2" "$2"; exit 0; fi
    a="$(awk -v n="$2" '$1 == n { $1 = ""; print }' "$F/getent-hosts")"
    [ -n "$a" ] || exit 2
    for x in $a; do printf '%s      STREAM %s\n%s      DGRAM\n%s      RAW\n' "$x" "$2" "$x" "$x"; done ;;
  *) for g in /usr/bin/getent /bin/getent; do [ ! -x "$g" ] || exec "$g" "$@"; done; exit 2 ;;
esac
EOF
fake chronyc <<'EOF'
[ "$*" = "-n -c sources" ] || refuse "$@"
cat "$F/chronyc-sources"
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
dailyaidecheck.timer active enabled
ssh active enabled
fail2ban active enabled
auditd active enabled
chrony active enabled
apport inactive masked
velexis-egress-refresh.timer active enabled
velexis-egress-refresh inactive enabled
velexis-ship-logs.timer active enabled
velexis-log-review.timer active enabled
EOF
  audit_plugin_healthy
  aide_conf_healthy
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
  rm -f "$FAKE/redis-open" "$FAKE/caddy-invalid" "$FAKE/nft-fails"
  # The table the step egress loaded (X-041), once it has run below.
  rm -rf "$FAKE/nft"
  [ ! -d "$FAKE/nft.healthy" ] || cp -a "$FAKE/nft.healthy" "$FAKE/nft"
}
healthy

# ---- the outbound allow-list (X-041): the step egress, once, as harden runs it on a new VM -------------------------
# What the VM gives the step: its resolvers, chrony's sources, the apt sources the step packages wrote, the mail relay
# in the env files and the bucket's endpoint in rclone.conf. Hosts answer with documentation addresses.
EGRESS_SECRETS="$PREFIX/egress-secrets" # the SMTP password and the bucket key of the test; step 7 searches for them
SMTP_SECRET="$(openssl rand -hex 16)"
BUCKET_SECRET="$(openssl rand -hex 20)"
( umask 077; printf '%s\n' "$SMTP_SECRET" "$BUCKET_SECRET" >"$EGRESS_SECRETS" )
install -d -m 0755 "$ROOT/run/systemd/resolve" "$ROOT/etc/apt/sources.list.d"
printf 'nameserver 192.0.2.53\nnameserver 2001:db8::53\nsearch .\n' >"$ROOT/run/systemd/resolve/resolv.conf"
printf '^,*,192.0.2.124,2,6,377,32,0.000012,0.000010,0.001\n^,+,2001:db8::124,2,6,377,30,0.000020,0.000018,0.002\n#,-,PPS0,0,4,0,-,0,0,0\n' >"$FAKE/chronyc-sources"
cat >"$ROOT/etc/apt/sources.list.d/ubuntu.sources" <<'EOF'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb-src
URIs: http://mirror.example.net/ubuntu/
Suites: noble
Components: main
Enabled: no
EOF
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' >"$ROOT/etc/apt/sources.list.d/nodesource.list"
echo 'deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' >"$ROOT/etc/apt/sources.list.d/pgdg.list"
echo 'deb [signed-by=/etc/apt/keyrings/redis.gpg] https://packages.redis.io/deb noble main' >"$ROOT/etc/apt/sources.list.d/redis.list"
echo 'deb [signed-by=/etc/apt/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main' >"$ROOT/etc/apt/sources.list.d/caddy.list"
for f in platform-backend.env ota-backend.env; do
  sed -i -E "s#^SMTP_URL=.*#SMTP_URL=smtps://vxmail:${SMTP_SECRET}@smtp.mail.example.net:465#" "$ETC/$f"
done
sed -i -E 's#^ALERT_SMTP_URL=.*#ALERT_SMTP_URL=smtps://smtp.mail.example.net:465#' "$ETC/alert.env"
( umask 077; printf '[offsite]\ntype = s3\nprovider = Other\naccess_key_id = vxbackup\nsecret_access_key = %s\nendpoint = https://s3.backup.example.net\nregion = eu-1\nno_check_bucket = true\n' "$BUCKET_SECRET" >"$ETC/backup/rclone.conf" )
cat >"$FAKE/getent-hosts" <<'EOF'
ntp.ubuntu.com 192.0.2.123
api.stripe.com 192.0.2.10 192.0.2.11 2001:db8::10
connect.stripe.com 192.0.2.12
test.travel.api.amadeus.com 198.51.100.20 2001:db8::20
travel.api.amadeus.com 198.51.100.21
smtp.mail.example.net 192.0.2.25 2001:db8::25
s3.backup.example.net 203.0.113.30
acme-v02.api.letsencrypt.org 198.51.100.40 2001:db8::40
acme.zerossl.com 198.51.100.41
api.zerossl.com 198.51.100.41
zerossl.ocsp.sectigo.com 198.51.100.42
archive.ubuntu.com 203.0.113.50 2001:db8::50
security.ubuntu.com 203.0.113.51
deb.nodesource.com 203.0.113.52
apt.postgresql.org 203.0.113.53
www.postgresql.org 203.0.113.54
packages.redis.io 203.0.113.55
dl.cloudsmith.io 203.0.113.52
EOF
provision_egress() { # log [VAR=value...]: provision-vm.sh --steps egress with the fakes, as root on the VM runs it
  local log="$1"
  shift
  env -u SUDO_USER PATH="$FAKEBIN:$PATH" CHECKVM_FAKE="$FAKE" CHECKVM_PROVISION=1 VELEXIS_ROOT="$ROOT" "$@" \
    bash "$PROVISION" --steps egress >"$log" 2>&1
}
egress_refresh() { # log [args]: the installed velexis-egress, as its unit runs it
  local log="$1"
  shift
  env PATH="$FAKEBIN:$PATH" CHECKVM_FAKE="$FAKE" CHECKVM_PROVISION=1 VELEXIS_ROOT="$ROOT" \
    bash "$ROOT/usr/local/sbin/velexis-egress" refresh "$@" >"$log" 2>&1
}
applies() { if [ -f "$FAKE/nft-applies" ]; then grep -c . "$FAKE/nft-applies"; else echo 0; fi; }
egress_files() { fingerprint "$ETC/egress" "$ROOT/usr/local/sbin/velexis-egress" "$ROOT/etc/systemd/system"; }
nft_set() { sort "$FAKE/nft/set.$1" 2>/dev/null; } # the elements of a set of the fake's table
sed -i '/^velexis-egress-refresh/d' "$FAKE/units" # a new VM: neither unit is enabled yet
if provision_egress "$OUT/egress-first.log"; then rc=0; else rc=$?; fi
# The rules are pinned here too, not only compared between egress.sh and check-vm.sh (which hold the same list):
# loopback and replies come first, so the open SSH session and the inbound rules of X-020 keep working, and the sets
# of both address families are used.
if [ "$rc" = 0 ] && cmp -s "$ETC/egress/allowed-hosts.conf" "$DEPLOY/egress/allowed-hosts.conf" &&
  [ "$(stat -c '%U:%G %a' "$ETC/egress/allowed-hosts.conf")" = "root:root 644" ] &&
  cmp -s "$ROOT/usr/local/sbin/velexis-egress" "$DEPLOY/scripts/egress.sh" &&
  [ "$(stat -c '%U:%G %a' "$ROOT/usr/local/sbin/velexis-egress")" = "root:root 755" ] &&
  cmp -s "$ROOT/etc/systemd/system/velexis-egress-refresh.timer" "$DEPLOY/systemd/velexis-egress-refresh.timer" &&
  cmp -s "$ROOT/etc/systemd/system/velexis-egress-refresh.service" "$DEPLOY/systemd/velexis-egress-refresh.service" &&
  [ "$(applies)" = 1 ] && [ "$(cat "$FAKE/nft/policy")" = drop ] &&
  [ "$(paste -sd'|' "$FAKE/egress-systemctl")" = "daemon-reload|enable velexis-egress-refresh.service|enable --now velexis-egress-refresh.timer" ] &&
  grep -q '^created the table inet velexis_egress' "$OUT/egress-first.log" &&
  nft_set allow4 | grep -qxF '192.0.2.10 . tcp . 443 comment "api.stripe.com"' &&
  nft_set allow6 | grep -qxF '2001:db8::25 . tcp . 465 comment "env:platform-backend.env:SMTP_URL"' &&
  nft_set allow4 | grep -qxF '203.0.113.30 . tcp . 443 comment "rclone:backup.env"' &&
  nft_set allow4 | grep -qxF '192.0.2.53 . udp . 53 comment "@system-resolvers"' &&
  nft_set allow6 | grep -qxF '2001:db8::124 . udp . 123 comment "@chrony-sources"' &&
  [ "$(tail -n 1 "$FAKE/nft/rules")" = 'limit rate 10/minute burst 5 packets log prefix "VELEXIS-EGRESS-DENY " flags skuid' ] &&
  [ "$(head -n 2 "$FAKE/nft/rules" | paste -sd'|' -)" = 'oifname "lo" accept|ct state established,related accept' ] &&
  grep -qxF 'ip daddr . meta l4proto . th dport @allow4 accept' "$FAKE/nft/rules" &&
  grep -qxF 'ip6 daddr . meta l4proto . th dport @allow6 accept' "$FAKE/nft/rules"; then
  pass "the step egress installs the allow-list, velexis-egress and its units, loads the table once (policy drop, loopback and replies accepted first, $(nft_set allow4 | grep -c .) IPv4 and $(nft_set allow6 | grep -c .) IPv6 destinations, tokens resolved from the VM's files, refusals logged) and enables the service and the timer [X-041 AC1]"
else
  indent "$OUT/egress-first.log"
  fail "the step egress installs the allow-list and its units, loads the table once and enables both units (exit $rc, loads: $(applies)) [X-041 AC1]"
fi
cp -a "$FAKE/nft" "$FAKE/nft.healthy"
cp -p "$ROOT/var/lib/velexis/egress/addresses" "$PREFIX/egress-addresses.healthy"

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
PASS the AIDE database exists
PASS dailyaidecheck.timer is active and enabled (AIDE's daily check)
PASS AIDE's 90_velexis details added entries and relaxes apt's lists (report_level=added_removed_entries; /var/lib/apt/lists/[^/]+$ f VarFile)
PASS sshd -T: AllowUsers $ADMIN_TEST_USER $DEPLOY_TEST_USER
PASS sshd -T -C user=$ADMIN_TEST_USER: second factor FIDO2 (publickey with sk-ssh-ed25519@openssh.com only, pubkeyauthoptions touch-required verify-required)
PASS sshd -T -C user=$ADMIN_TEST_USER: keys only from .ssh/authorized_keys
PASS every key of $ADMIN_TEST_USER is a FIDO2 key (sk-ssh-ed25519) with verify-required (2)
PASS sshd -T -C user=$DEPLOY_TEST_USER: public key only (authenticationmethods publickey)
PASS sshd -T -C user=$DEPLOY_TEST_USER: no TTY and no forwarding (permittty no, disableforwarding yes)
PASS sshd -T -C user=$DEPLOY_TEST_USER: keys only from .ssh/authorized_keys
PASS outgoing connections are denied by default (nftables table inet velexis_egress, chain output: policy drop)
PASS the chain output holds only the allow-list's rules
PASS refused outbound connections are logged (prefix VELEXIS-EGRESS-DENY, at most 10 a minute, with the user)
PASS every address of the sets allow4 and allow6 belongs to a line of /etc/velexis/egress/allowed-hosts.conf
PASS every line of /etc/velexis/egress/allowed-hosts.conf has an address in the sets
PASS no emergency opening
PASS the URLs of the allow-list's env: lines use the ports their lines allow
PASS every resolver of DNS_RESOLVERS in platform-backend.env has its udp and tcp lines (2 resolvers)
PASS the Amadeus base URLs of both backends are the official hosts or have their own lines
PASS /etc/velexis/egress/allowed-hosts.conf is this deploy folder's egress/allowed-hosts.conf
PASS /usr/local/sbin/velexis-egress is root:root 755
PASS every apt source of the VM is on the allow-list (apt.postgresql.org:443 archive.ubuntu.com:80 deb.nodesource.com:443 dl.cloudsmith.io:443 packages.redis.io:443 security.ubuntu.com:80)
PASS the last refresh of the allow-list did not fail
PASS velexis-egress-refresh.timer is active and enabled
PASS velexis-egress-refresh.service is enabled (loads the allow-list at boot)
PASS velexis-ship-logs.timer is active and enabled (security logs, X-038)
PASS velexis-log-review.timer is active and enabled (security logs, X-038)
PASS auditd's syslog plugin is on (/etc/audit/plugins.d/syslog.conf: active = yes, direction = out, path = audisp-syslog)
EOF
if [ "$covered" = 1 ]; then
  pass "every item of the task has a PASS line, the SSH methods of both users and the outbound allow-list included [X-020 AC2] [X-037 AC2] [X-041 AC1]"
else
  fail "every item of the task has a PASS line, the SSH methods of both users and the outbound allow-list included [X-020 AC2] [X-037 AC2] [X-041 AC1]"
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
# AIDE's daily check (lead decision (13j) of 2026-11-10): the timer of aide-common stopped, or not started at boot.
edit units 's/^dailyaidecheck.timer active enabled/dailyaidecheck.timer inactive disabled/'
broken "AIDE's daily check off" system "dailyaidecheck.timer is active and enabled \\(found: inactive disabled;" "FIX-W47-SHARED AC4"
healthy
edit units 's/^dailyaidecheck.timer active enabled/dailyaidecheck.timer active disabled/'
broken "AIDE's daily check that does not start at boot" system "dailyaidecheck.timer is active and enabled \\(found: active disabled;" "FIX-W47-SHARED AC4"
healthy
edit units '/^dailyaidecheck.timer /d'
broken "no AIDE timer (aide-common missing)" system "dailyaidecheck.timer is active and enabled \\(found: inactive not-found;" "FIX-W47-SHARED AC4"
healthy
if run_check "$OUT/aide-timer.out" --only system && grep -qx "PASS dailyaidecheck.timer is active and enabled (AIDE's daily check)" "$OUT/aide-timer.out"; then
  pass "check-vm.sh --only system reports PASS for an active and enabled dailyaidecheck.timer, beside the AIDE database [FIX-W47-SHARED AC4]"
else
  indent "$OUT/aide-timer.out"
  fail "check-vm.sh --only system reports PASS for an active and enabled dailyaidecheck.timer [FIX-W47-SHARED AC4]"
fi
# AIDE's two settings in 90_velexis (lead decision (21l) of 2026-11-13): each one missing, changed or commented out, and
# the file missing (a VM provisioned before the decision gets them from provision-vm.sh --steps harden).
AIDE_CONF="$ROOT/etc/aide/aide.conf.d/90_velexis"
AIDE_FIX='provision-vm.sh --steps harden\)'
sed -i '/^report_level=added_removed_entries$/d' "$AIDE_CONF"
broken "90_velexis without report_level" system \
  "AIDE's 90_velexis details added entries .*\\(missing the line: report_level=added_removed_entries; .*$AIDE_FIX" "FIX-W52-SHARED 21l"
healthy
sed -i 's/^report_level=added_removed_entries$/report_level=changed_attributes/' "$AIDE_CONF"
broken "90_velexis with AIDE's default report level" system \
  "AIDE's 90_velexis details added entries .*\\(missing the line: report_level=added_removed_entries; " "FIX-W52-SHARED 21l"
healthy
sed -i 's/^report_level=added_removed_entries$/# &/' "$AIDE_CONF"
broken "90_velexis with report_level commented out" system \
  "AIDE's 90_velexis details added entries .*\\(missing the line: report_level=added_removed_entries; " "FIX-W52-SHARED 21l"
healthy
sed -i '\#^/var/lib/apt/lists/#d' "$AIDE_CONF"
broken "90_velexis without the apt lists' rule" system \
  "AIDE's 90_velexis details added entries .*\\(missing the line: /var/lib/apt/lists/\\[\\^/\\]\\+\\\$ f VarFile; .*$AIDE_FIX" "FIX-W52-SHARED 21l"
healthy
sed -i 's#^\(/var/lib/apt/lists/\[^/\]+\$ f\) VarFile$#\1 Full#' "$AIDE_CONF"
broken "90_velexis with the apt lists under Full" system \
  "AIDE's 90_velexis details added entries .*\\(missing the line: /var/lib/apt/lists/\\[\\^/\\]\\+\\\$ f VarFile; " "FIX-W52-SHARED 21l"
healthy
sed -i 's#^/var/lib/apt/lists/\[^/\]+\$ f VarFile$#\# &#' "$AIDE_CONF"
broken "90_velexis with the apt lists' rule commented out" system \
  "AIDE's 90_velexis details added entries .*\\(missing the line: /var/lib/apt/lists/\\[\\^/\\]\\+\\\$ f VarFile; .*$AIDE_FIX" "FIX-W52-SHARED 21l"
healthy
sed -i -e '/^report_level=/d' -e '\#^/var/lib/apt/lists/#d' "$AIDE_CONF"
broken "90_velexis without either line (provisioned before the decision)" system \
  "AIDE's 90_velexis details added entries .*\\(missing the line: report_level=added_removed_entries, /var/lib/apt/lists/" "FIX-W52-SHARED 21l"
healthy
rm -f "$AIDE_CONF"
broken "no 90_velexis" system "AIDE's 90_velexis details added entries .*\\(/etc/aide/aide.conf.d/90_velexis is missing; .*$AIDE_FIX" \
  "FIX-W52-SHARED 21l"
healthy
if run_check "$OUT/aide-settings.out" --only system &&
  grep -qxF "PASS AIDE's 90_velexis details added entries and relaxes apt's lists (report_level=added_removed_entries; /var/lib/apt/lists/[^/]+\$ f VarFile)" "$OUT/aide-settings.out"; then
  pass "check-vm.sh --only system reports PASS for 90_velexis as provision-vm.sh writes it (its text read from provision-vm.sh) [FIX-W52-SHARED 21l]"
else
  indent "$OUT/aide-settings.out"
  fail "check-vm.sh --only system reports PASS for 90_velexis as provision-vm.sh writes it [FIX-W52-SHARED 21l]"
fi
# The security logs (X-038; lead decision (20p) of 2026-11-13): both timers, and auditd's syslog plugin.
for timer in velexis-ship-logs.timer velexis-log-review.timer; do
  edit units "s/^$timer active enabled/$timer inactive disabled/"
  broken "$timer stopped" services "$timer is active and enabled \\(found: inactive disabled;" "FIX-W51-SHARED 20p"
  healthy
  edit units "s/^$timer active enabled/$timer active disabled/"
  broken "$timer that does not start at boot" services "$timer is active and enabled \\(found: active disabled;" "FIX-W51-SHARED 20p"
  healthy
  edit units "/^$timer /d"
  broken "$timer missing (provision-vm.sh --steps scripts not run)" services \
    "$timer is active and enabled \\(found: inactive not-found;" "FIX-W51-SHARED 20p"
  healthy
done
PLUGIN_FILE="$ROOT/etc/audit/plugins.d/syslog.conf"
sed -i 's/^active = yes$/active = no/' "$PLUGIN_FILE"
broken "auditd's syslog plugin switched off (the package's default)" services \
  "auditd's syslog plugin is on .*\\(found: active = no;" "FIX-W51-SHARED 20p"
healthy
sed -i 's/^direction = out$/direction = in/' "$PLUGIN_FILE"
broken "auditd's syslog plugin sending the other way" services \
  "auditd's syslog plugin is on .*\\(found: direction = in\\)" "FIX-W51-SHARED 20p"
healthy
rm -f "$ROOT/sbin/audisp-syslog"
broken "auditd's syslog plugin without its program (audisp-syslog)" services \
  "auditd's syslog plugin is on .*not an executable audisp-syslog" "FIX-W51-SHARED 20p"
healthy
sed -i 's#^path = /sbin/audisp-syslog$#path = /sbin/audisp-af_unix#' "$PLUGIN_FILE"
install -m 0755 /dev/null "$ROOT/sbin/audisp-af_unix"
broken "auditd's syslog.conf naming another program" services \
  "auditd's syslog plugin is on .*found: path = /sbin/audisp-af_unix, not an executable audisp-syslog" "FIX-W51-SHARED 20p"
rm -f "$ROOT/sbin/audisp-af_unix"
healthy
rm -f "$PLUGIN_FILE"
broken "auditd's syslog plugin file missing (a VM provisioned before X-038)" services \
  "auditd's syslog plugin is on .*the file is missing" "FIX-W51-SHARED 20p"
healthy
if run_check "$OUT/security-logs.out" --only services &&
  grep -qx "PASS velexis-ship-logs.timer is active and enabled (security logs, X-038)" "$OUT/security-logs.out" &&
  grep -qx "PASS velexis-log-review.timer is active and enabled (security logs, X-038)" "$OUT/security-logs.out" &&
  grep -qx "PASS auditd's syslog plugin is on (/etc/audit/plugins.d/syslog.conf: active = yes, direction = out, path = audisp-syslog)" "$OUT/security-logs.out"; then
  pass "check-vm.sh --only services reports PASS for both security log timers and for the syslog plugin as provision-vm.sh writes it [FIX-W51-SHARED 20p]"
else
  indent "$OUT/security-logs.out"
  fail "check-vm.sh --only services reports PASS for both security log timers and the syslog plugin [FIX-W51-SHARED 20p]"
fi
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
SSH_RUNNER="$ADMIN_TEST_USER" # SUDO_USER of the step ssh: the admin runs it through sudo; empty: a root session (console)
SSH_STEPS=ssh                 # the --steps of provision_ssh
provision_ssh() { # log mfa [VAR=value...]: the step ssh as an operator runs it, with the fake (or a real) sshd on PATH
  local log="$1" mfa="$2" runner=(-u SUDO_USER -u SSH_CONNECTION) # no SSH_CONNECTION unless a test passes one
  shift 2
  [ -z "$SSH_RUNNER" ] || runner=(-u SSH_CONNECTION SUDO_USER="$SSH_RUNNER")
  env "${runner[@]}" PATH="$SSH_PATH:$PATH" CHECKVM_FAKE="$FAKE" CHECKVM_PROVISION=1 VELEXIS_ROOT="$ROOT" \
    ADMIN_USER="$ADMIN_TEST_USER" ADMIN_MFA="$mfa" DEPLOY_USER="$DEPLOY_TEST_USER" "$@" \
    bash "$PROVISION" --steps "$SSH_STEPS" >"$log" 2>&1
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
guard() { # description mfa pattern [tag] -> the step ssh exits 1 with that message and changes nothing
  local what="$1" mfa="$2" pattern="$3" tag="${4:-X-037}" log before rc
  N=$((N + 1))
  log="$OUT/ssh-guard-$N.log"
  before="$(ssh_state)"
  rm -f "$FAKE/reloads"
  if provision_ssh "$log" "$mfa"; then rc=0; else rc=$?; fi
  if [ "$rc" = 1 ] && [ "$(ssh_state)" = "$before" ] && [ "$(reloads)" = 0 ] && grep -qE -- "^ERROR: .*$pattern" "$log"; then
    pass "$what: nothing written or reloaded: $(grep -m 1 '^ERROR' "$log" | cut -c 8- | sed "s#$PREFIX#<prefix>#g") [$tag]"
  else
    indent "$log"
    fail "$what: nothing written or reloaded (exit $rc, expected: $pattern) [$tag]"
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

# The lockout guard (lead decision (13k) of 2026-11-10): the SSH changes never lock out whoever runs them through sudo
# (SUDO_USER). The admin's FIDO2 key is enrolled, so a run would now write 01-velexis-mfa.conf and reload ssh.
lockout() { # description pattern -> provision_ssh (fido2) exits 1 before any step with that message, and changes nothing
  local what="$1" pattern="$2" log before rc #  (sshd, PAM, the env and key files, the deploy key) and reloads nothing
  N=$((N + 1))
  log="$OUT/ssh-lockout-$N.log"
  before="$(ssh_state; fingerprint "$ETC" "$DEPLOY_HOME/.ssh")"
  rm -f "$FAKE/reloads"
  if provision_ssh "$log" fido2; then rc=0; else rc=$?; fi
  if [ "$rc" = 1 ] && [ "$(ssh_state; fingerprint "$ETC" "$DEPLOY_HOME/.ssh")" = "$before" ] && [ "$(reloads)" = 0 ] &&
    [ ! -e "$DROPIN" ] && grep -qE -- "^ERROR: refused, nothing changed: .*$pattern" "$log" && ! grep -q '^==> ' "$log"; then
    pass "$what: refused before any step, nothing changed or reloaded: $(grep -m 1 '^ERROR' "$log" | cut -c 8- | sed "s#$PREFIX#<prefix>#g") [FIX-W47-SHARED AC5]"
  else
    indent "$log"
    fail "$what: refused before any step, nothing changed or reloaded (exit $rc, expected: $pattern) [FIX-W47-SHARED AC5]"
  fi
}
OTHER_RUNNER="vxops-$RUN_ID" # a sudo user the new AllowUsers leaves out (the guard compares names; it need not exist)
SSH_RUNNER="$OTHER_RUNNER"
lockout "a sudo user outside the new AllowUsers runs the step ssh" \
  "you run this through sudo as $OTHER_RUNNER, but the new SSH settings let only $ADMIN_TEST_USER and $DEPLOY_TEST_USER log in \\(AllowUsers\\), so $OTHER_RUNNER would lose SSH access"
SSH_STEPS=users,keys,ssh
lockout "the same user runs the steps users, keys and ssh (the guard comes before the first step)" \
  "so $OTHER_RUNNER would lose SSH access. Run it as $ADMIN_TEST_USER, pass ADMIN_USER=$OTHER_RUNNER, or run it from the provider's console"
SSH_STEPS=ssh
# harden runs the step ssh too, but never under VELEXIS_ROOT: that the same guard covers it is read from the script.
# shellcheck disable=SC2016 # the script's own line, $STEPS unexpanded
if grep -qxF 'case " $STEPS " in *" harden "* | *" ssh "*) runner_in_allowusers; ssh_source_in_allow_from ;; esac' "$PROVISION" &&
  awk '/^step_harden\(\) \{$/, /^\}$/ { if ($0 == "  step_ssh") found = 1 } END { exit !found }' "$PROVISION"; then
  pass "a run with harden, which runs the step ssh, gets the same guard and SSH source check before any step (read from provision-vm.sh) [FIX-W47-SHARED AC5] [FIX-W48-SHARED AC5]"
else
  fail "a run with harden, which runs the step ssh, gets the same guard and SSH source check before any step (read from provision-vm.sh) [FIX-W47-SHARED AC5] [FIX-W48-SHARED AC5]"
fi
# Allowed: a root session without sudo (the provider's console), root's own sudo, and the deploy user (in AllowUsers).
# Each run writes the drop-in and reloads once; the drop-in is removed again for the next one.
for runner in "" root "$DEPLOY_TEST_USER"; do
  SSH_RUNNER="$runner"
  rm -f "$FAKE/reloads"
  if provision_ssh "$OUT/ssh-allowed-${runner:-console}.log" fido2 && dropin_has fido2 && [ "$(reloads)" = 1 ]; then
    pass "the step ssh run by ${runner:-a root session without sudo} applies the second factor: the lockout guard lets it through [FIX-W47-SHARED AC5]"
  else
    indent "$OUT/ssh-allowed-${runner:-console}.log"
    fail "the step ssh run by ${runner:-a root session without sudo} applies the second factor (reloads: $(reloads)) [FIX-W47-SHARED AC5]"
  fi
  rm -f "$DROPIN"
done

# The SSH source (lead decision (15d) of 2026-11-11): with SSH_ALLOW_FROM a range, a run whose SSH login comes from
# outside it refuses before any step and changes nothing; from inside it, or without an SSH login, it goes on (and,
# the admin's FIDO2 key being enrolled, writes the drop-in and reloads once, which is undone for the next run).
fake who <<'EOF'
# who -m: the login of this terminal, the line of the fixture who-m; nothing without it (no terminal).
[ "$*" = "-m" ] || refuse "$@"
[ ! -f "$F/who-m" ] || cat "$F/who-m"
EOF
who_m() { if [ $# -eq 0 ]; then rm -f "$FAKE/who-m"; else printf '%s\n' "$1" >"$FAKE/who-m"; fi; } # [line]
who_calls() { grep -c '^who ' "$FAKE/calls.log" || true; }
source_refused() { # description pattern [VAR=value...] -> provision_ssh (fido2) exits 1 before any step with that
  local what="$1" pattern="$2" log before rc #             message, and changes and reloads nothing
  shift 2
  N=$((N + 1))
  log="$OUT/ssh-source-$N.log"
  before="$(ssh_state; fingerprint "$ETC" "$DEPLOY_HOME/.ssh")"
  rm -f "$FAKE/reloads"
  if provision_ssh "$log" fido2 "$@"; then rc=0; else rc=$?; fi
  if [ "$rc" = 1 ] && [ "$(ssh_state; fingerprint "$ETC" "$DEPLOY_HOME/.ssh")" = "$before" ] && [ "$(reloads)" = 0 ] &&
    [ ! -e "$DROPIN" ] && grep -qE -- "^ERROR: refused, nothing changed: .*$pattern" "$log" && ! grep -q '^==> ' "$log"; then
    pass "$what: refused before any step, nothing changed or reloaded: $(grep -m 1 '^ERROR' "$log" | cut -c 8- | sed "s#$PREFIX#<prefix>#g") [FIX-W48-SHARED AC5]"
  else
    indent "$log"
    fail "$what: refused before any step, nothing changed or reloaded (exit $rc, expected: $pattern) [FIX-W48-SHARED AC5]"
  fi
}
source_allowed() { # description [VAR=value...] -> provision_ssh (fido2) goes on: the drop-in written, ssh reloaded once
  local what="$1" log
  shift
  N=$((N + 1))
  log="$OUT/ssh-source-$N.log"
  rm -f "$FAKE/reloads"
  if provision_ssh "$log" fido2 "$@" && dropin_has fido2 && [ "$(reloads)" = 1 ]; then
    pass "$what: the guard lets it through, and the step ssh applies the second factor [FIX-W48-SHARED AC5]"
  else
    indent "$log"
    fail "$what: the guard lets it through, and the step ssh applies the second factor (reloads: $(reloads)) [FIX-W48-SHARED AC5]"
  fi
  rm -f "$DROPIN"
}
V4=198.51.100.0/24
V6=2001:db8:1::/48
V4_RE='198\.51\.100\.0/24'
OUTSIDE_RE='you are logged in over SSH from 203\.0\.113\.7, which SSH_ALLOW_FROM=198\.51\.100\.0/24 does not include'
SSH_RUNNER="$ADMIN_TEST_USER" # the admin, through sudo: in AllowUsers, with the FIDO2 key enrolled
who_m
source_refused "IPv4: the admin logs in over SSH from outside SSH_ALLOW_FROM ($V4)" \
  "$OUTSIDE_RE, so its firewall rule \(the step harden\) would lock you out" \
  SSH_ALLOW_FROM="$V4" SSH_CONNECTION="203.0.113.7 50022 192.0.2.10 22"
source_allowed "IPv4: the admin logs in over SSH from inside SSH_ALLOW_FROM ($V4)" \
  SSH_ALLOW_FROM="$V4" SSH_CONNECTION="198.51.100.42 50022 192.0.2.10 22"
source_refused "IPv6: the admin logs in over SSH from outside SSH_ALLOW_FROM ($V6)" \
  "you are logged in over SSH from 2001:db8:2::5, which SSH_ALLOW_FROM=2001:db8:1::/48 does not include" \
  SSH_ALLOW_FROM="$V6" SSH_CONNECTION="2001:db8:2::5 50022 2001:db8:ffff::10 22"
source_allowed "IPv6: the admin logs in over SSH from inside SSH_ALLOW_FROM ($V6)" \
  SSH_ALLOW_FROM="$V6" SSH_CONNECTION="2001:db8:1:ffff::abcd 50022 2001:db8:ffff::10 22"
# A prefix that ends inside a hex digit (/47: the first 3 bits of the 12th digit): 2001:db8:1:: is in, 2001:db8:2:: out.
source_refused "IPv6: a login outside a range whose prefix ends inside a hex digit (2001:db8::/47)" \
  "you are logged in over SSH from 2001:db8:2::5, which SSH_ALLOW_FROM=2001:db8::/47 does not include" \
  SSH_ALLOW_FROM=2001:db8::/47 SSH_CONNECTION="2001:db8:2::5 50022 2001:db8:ffff::10 22"
source_allowed "IPv6: a login inside a range whose prefix ends inside a hex digit (2001:db8::/47)" \
  SSH_ALLOW_FROM=2001:db8::/47 SSH_CONNECTION="2001:db8:1::5 50022 2001:db8:ffff::10 22"
source_refused "an IPv6 login and an IPv4 SSH_ALLOW_FROM (the firewall keeps the two families apart)" \
  "you are logged in over SSH from 2001:db8:1::5, which SSH_ALLOW_FROM=$V4_RE does not include" \
  SSH_ALLOW_FROM="$V4" SSH_CONNECTION="2001:db8:1::5 50022 2001:db8:ffff::10 22"
source_allowed "an IPv4-mapped IPv6 login inside an IPv4 SSH_ALLOW_FROM" \
  SSH_ALLOW_FROM="$V4" SSH_CONNECTION="::ffff:198.51.100.42 50022 ::ffff:192.0.2.10 22"
# sudo dropped SSH_CONNECTION: who -m names the login of the terminal.
who_m "$ADMIN_TEST_USER pts/1        2026-11-11 10:00 (203.0.113.7)"
source_refused "who -m: the admin's terminal logs in from outside SSH_ALLOW_FROM" "$OUTSIDE_RE" SSH_ALLOW_FROM="$V4"
who_m "$ADMIN_TEST_USER pts/1        2026-11-11 10:00 (198.51.100.9)"
source_allowed "who -m: the admin's terminal logs in from inside SSH_ALLOW_FROM" SSH_ALLOW_FROM="$V4"
who_m "$ADMIN_TEST_USER pts/1        2026-11-11 10:00 (2001:db8:1::9)"
source_allowed "who -m: the admin's terminal logs in over IPv6 from inside SSH_ALLOW_FROM" SSH_ALLOW_FROM="$V6"
who_m "$ADMIN_TEST_USER pts/1        2026-11-11 10:00 (tmux(4321).%0)"
source_refused "who -m names a remote host that is no address" \
  'the SSH login behind this run comes from tmux\?4321\?\.%0, which is no IPv4 or IPv6 address to compare with it' \
  SSH_ALLOW_FROM="$V4"
who_m "$ADMIN_TEST_USER tty1         2026-11-11 10:00"
source_allowed "the admin on a console terminal (who -m names no remote host): no SSH login to keep" SSH_ALLOW_FROM="$V4"
who_m
source_refused "through sudo without a terminal and without SSH_CONNECTION: it cannot tell the source" \
  "this run, through sudo as $ADMIN_TEST_USER without a terminal, cannot tell from which address you log in" \
  SSH_ALLOW_FROM="$V4"
source_refused "a malformed SSH_ALLOW_FROM" "SSH_ALLOW_FROM must be any, or an IPv4 or IPv6 address or range" \
  SSH_ALLOW_FROM=198.51.100.0/33 SSH_CONNECTION="198.51.100.42 50022 192.0.2.10 22"
# SSH_ALLOW_FROM=any: nothing to check, so who is never asked, even for a terminal that logs in from anywhere.
who_m "$ADMIN_TEST_USER pts/1        2026-11-11 10:00 (203.0.113.7)"
calls="$(who_calls)"
source_allowed "SSH_ALLOW_FROM=any: no range, nothing to check" SSH_ALLOW_FROM=any
who_m
if [ "$(who_calls)" = "$calls" ]; then
  pass "with SSH_ALLOW_FROM=any the guard never asks who [FIX-W48-SHARED AC5]"
else
  fail "with SSH_ALLOW_FROM=any the guard never asks who [FIX-W48-SHARED AC5]"
fi
SSH_RUNNER="" # a root session without sudo
source_allowed "a root session without an SSH login (the provider's console)" SSH_ALLOW_FROM="$V4"
source_refused "a root session over SSH from outside SSH_ALLOW_FROM" "$OUTSIDE_RE" \
  SSH_ALLOW_FROM="$V4" SSH_CONNECTION="203.0.113.7 50022 192.0.2.10 22"
SSH_RUNNER="$ADMIN_TEST_USER"
# The second factor would ask the admin who runs it for a factor they have not enrolled (here because another drop-in
# wins for the admin in the fake sshd -T): refused before anything is written.
sshd_user "$ADMIN_TEST_USER" "${TOTP_ADMIN[@]}"
guard "the admin, through sudo, would be asked for a TOTP code without a TOTP secret" fido2 \
  "refused, nothing changed: with the new SSH settings $ADMIN_TEST_USER, who runs this, would need a TOTP code \\(sshd -T: authenticationmethods publickey,keyboard-interactive:pam\\), but .*/.google_authenticator does not exist, and would lose SSH access" \
  "FIX-W47-SHARED AC5"
admin_keys "$ADMIN_PLAIN_KEY"
totp_file 0400 "$ADMIN_TEST_USER"
sshd_user "$ADMIN_TEST_USER" "${FIDO2_ADMIN[@]}"
guard "the admin, through sudo, would be asked for a FIDO2 key with only a plain key" totp \
  "would need a FIDO2 key \\(sshd -T: pubkeyacceptedalgorithms sk-ssh-ed25519@openssh.com\\), but .*/.ssh/authorized_keys holds no FIDO2 key with user verification, and would lose SSH access" \
  "FIX-W47-SHARED AC5"
rm -f "$TOTP_FILE"
admin_keys "$ADMIN_SK_KEY" "$ADMIN_PLAIN_KEY"
healthy

# Enrolled: the drop-in once, one reload, then nothing on a second run.
rm -f "$FAKE/reloads"
if provision_ssh "$OUT/ssh-fido2.log" fido2 && dropin_has fido2 && [ "$(reloads)" = 1 ] &&
  cmp -s "$PAM_FILE" "$PREFIX/pam-sshd.orig" && grep -q 'Keep this session open' "$OUT/ssh-fido2.log"; then
  pass "ADMIN_MFA=fido2 with an enrolled key writes 01-velexis-mfa.conf (FIDO2 for the admin, limits for deploy), leaves PAM alone and reloads ssh once; run by the admin through sudo, whom the lockout guard lets through [X-037] [FIX-W47-SHARED AC5]"
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
  pass "ADMIN_MFA=totp with an enrolled secret writes the TOTP drop-in and puts pam_google_authenticator in place of the password in /etc/pam.d/sshd, one reload; run by the admin through sudo [X-037] [FIX-W47-SHARED AC5]"
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
  # The lockout guard on the real sshd -T: with the FIDO2 drop-in about to be written, an earlier Match block would ask
  # the admin, who runs the step through sudo with FIDO2 keys only, for a TOTP code too.
  printf 'Match User %s\n  AuthenticationMethods publickey,keyboard-interactive:pam\n  KbdInteractiveAuthentication yes\n' \
    "$ADMIN_TEST_USER" >"$ROOT/etc/ssh/sshd_config.d/00-aaa-other.conf"
  mv "$TOTP_FILE" "$PREFIX/google_authenticator.saved"
  mv "$DROPIN" "$PREFIX/01-velexis-mfa.conf.real"
  guard "real sshd -T: the admin, through sudo, would be asked for a TOTP code without a TOTP secret" fido2 \
    "refused, nothing changed: with the new SSH settings $ADMIN_TEST_USER, who runs this, would need a TOTP code \\(sshd -T: authenticationmethods publickey,keyboard-interactive:pam\\), but .*/.google_authenticator does not exist" \
    "FIX-W47-SHARED AC5"
  mv "$PREFIX/01-velexis-mfa.conf.real" "$DROPIN"
  mv "$PREFIX/google_authenticator.saved" "$TOTP_FILE"
  rm -f "$ROOT/etc/ssh/sshd_config.d/00-aaa-other.conf"
  CHECK_PATH="$FAKEBIN"
  SSH_PATH="$FAKEBIN"
else
  echo "NOTE the real-sshd checks did not run: no working sshd at $REAL_SSHD ($(head -n 1 "$OUT/sshd-probe.out" 2>/dev/null || echo 'not installed')); install openssh-server or set CHECKVM_SSHD=<sshd command>"
fi
rm -f "$TOTP_MODULE" "$TOTP_FILE"
cp -p "$PREFIX/pam-sshd.orig" "$PAM_FILE"

# ---- 6b. the outbound allow-list (X-041): the step egress, check-vm.sh --only firewall, velexis-egress -------------
step "the outbound allow-list: the step egress again, check-vm.sh's firewall items, velexis-egress's refreshes"
EG_STATE="$ROOT/var/lib/velexis/egress"
EG_LIST="$ETC/egress/allowed-hosts.conf"
egress_reset() { healthy; cp -p "$PREFIX/egress-addresses.healthy" "$EG_STATE/addresses"; rm -f "$EG_STATE/failing"; }
egress_reset
before="$(egress_files)"
loads="$(applies)"
rm -f "$FAKE/egress-systemctl"
if provision_egress "$OUT/egress-second.log" && [ "$(egress_files)" = "$before" ] && [ "$(applies)" = "$loads" ] &&
  [ ! -e "$FAKE/egress-systemctl" ] && grep -q '^unchanged: ' "$OUT/egress-second.log"; then
  pass "a second run of the step egress changes nothing: no file, no load of the table, no systemctl call [X-041 AC1]"
else
  indent "$OUT/egress-second.log"
  fail "a second run of the step egress changes nothing (loads: $loads, then $(applies)) [X-041 AC1]"
fi

# check-vm.sh: FAIL, naming the item, for each way the allow-list can be off.
echo accept >"$FAKE/nft/policy"
broken "outgoing connections allowed by default" firewall 'outgoing connections are denied by default \(found: chain output of inet velexis_egress with policy accept\)' "X-041 AC1"
egress_reset
rm -f "$FAKE/nft/exists"
broken "no table (a reboot without the service, or nft flush ruleset)" firewall 'outgoing connections are denied by default \(found: no nftables table inet velexis_egress' "X-041 AC1"
egress_reset
echo '203.0.113.99 . tcp . 25 comment "smtp.example.org"' >>"$FAKE/nft/set.allow4"
broken "a destination missing from allowed-hosts.conf" firewall 'outbound destinations outside /etc/velexis/egress/allowed-hosts.conf: 203\.0\.113\.99 tcp/25 \(comment "smtp\.example\.org"\)$' "X-041 AC1"
egress_reset
echo '192.0.2.10 . tcp . 25 comment "api.stripe.com"' >>"$FAKE/nft/set.allow4"
echo '2001:db8::99 . udp . 53' >>"$FAKE/nft/set.allow6"
broken "a listed host on a port its line does not have, and an address without a comment" firewall 'outside /etc/velexis/egress/allowed-hosts.conf: 192\.0\.2\.10 tcp/25 \(comment "api\.stripe\.com"\), 2001:db8::99 udp/53 \(no comment\)$' "X-041 AC1"
egress_reset
# An address added by hand under a listed host's comment, on that line's port, is not one the refresh kept for it.
# (Addresses that two lines share, such as ZeroSSL's, carry the first line's comment and pass: the healthy fixture.)
echo '203.0.113.66 . tcp . 443 comment "api.stripe.com"' >>"$FAKE/nft/set.allow4"
broken "an address added by hand under a listed host's comment" firewall 'outside /etc/velexis/egress/allowed-hosts.conf: 203\.0\.113\.66 tcp/443 \(comment "api\.stripe\.com", not an address the refresh kept for it\)$' "X-041 AC1"
egress_reset
sed -i '/VELEXIS-EGRESS-DENY/d' "$FAKE/nft/rules"
broken "refusals not logged" firewall 'refused outbound connections are logged \(no rule logs them with the prefix VELEXIS-EGRESS-DENY\)' "X-041 AC1"
egress_reset
sed -i '1i tcp dport 25 accept' "$FAKE/nft/rules"
broken "an extra accept rule in the chain" firewall 'the chain output of inet velexis_egress allows more than the allow-list: \[tcp dport 25 accept\]' "X-041 AC1"
egress_reset
sed -i '/^ct state established,related accept$/d' "$FAKE/nft/rules"
broken "a missing rule (replies)" firewall 'the chain output of inet velexis_egress lacks rules of the allow-list: \[ct state established,related accept\]' X-041
egress_reset
edit units 's/^velexis-egress-refresh.timer active enabled/velexis-egress-refresh.timer inactive enabled/'
broken "a stopped refresh timer" firewall 'velexis-egress-refresh.timer is active and enabled \(found: inactive enabled;' "X-041 AC1"
egress_reset
edit units 's/^velexis-egress-refresh inactive enabled/velexis-egress-refresh inactive disabled/'
broken "an allow-list not loaded at boot" firewall 'velexis-egress-refresh.service is enabled \(found: disabled;' X-041
egress_reset
echo '203.0.113.10 . tcp . 443 timeout 4h expires 3h59m comment "INC-0001 vendor X, opened by vxadmin"' >"$FAKE/nft/set.emergency4"
broken "an emergency opening" firewall 'an emergency opening is in place \(docs/mvp/runbooks/outbound-allow-list.md §4\): 203\.0\.113\.10 \. tcp \. 443 timeout 4h expires 3h59m comment "INC-0001 vendor X, opened by vxadmin"$' X-041
egress_reset
sed -i '/^env:alert.env:ALERT_SMTP_URL /d' "$EG_STATE/addresses"
broken "a line whose host has no address" firewall 'lines of /etc/velexis/egress/allowed-hosts.conf without an address in the sets .*: env:alert.env:ALERT_SMTP_URL 465/tcp$' X-041
egress_reset
cp -p "$EG_LIST" "$PREFIX/allowed-hosts.orig"
echo 'example.org 443 tcp curl an edit on the VM' >>"$EG_LIST"
broken "an installed allow-list that is not the release's" firewall "allowed-hosts.conf is this deploy folder's egress/allowed-hosts.conf \\(it differs" X-041
cp -p "$PREFIX/allowed-hosts.orig" "$EG_LIST"
cp -p "$ETC/alert.env" "$PREFIX/alert.env.orig"
sed -i -E 's#^ALERT_SMTP_URL=.*#ALERT_SMTP_URL=smtp://smtp.mail.example.net:587#' "$ETC/alert.env"
broken "an SMTP URL on a port its line does not allow" firewall 'URLs whose port no line of the allow-list allows .*: env:alert.env:ALERT_SMTP_URL \(its line: 465/tcp\)$' X-041
cp -p "$PREFIX/alert.env.orig" "$ETC/alert.env"
# A URL without a port connects to its scheme's: smtp:// is 587 for Nodemailer (the backends) and 25 for curl (alert.env).
cp -p "$ETC/ota-backend.env" "$PREFIX/ota-backend.env.orig"
sed -i -E "s#^SMTP_URL=.*#SMTP_URL=smtp://vxmail:${SMTP_SECRET}@smtp.mail.example.net#" "$ETC/ota-backend.env"
sed -i -E 's#^ALERT_SMTP_URL=.*#ALERT_SMTP_URL=smtp://smtp.mail.example.net#' "$ETC/alert.env"
broken "SMTP URLs without a port, whose scheme's port (587, 25) their lines do not allow" firewall 'URLs whose port no line of the allow-list allows .*: env:ota-backend.env:SMTP_URL \(its line: 465/tcp\), env:alert.env:ALERT_SMTP_URL \(its line: 465/tcp\)$' X-041
cp -p "$PREFIX/ota-backend.env.orig" "$ETC/ota-backend.env"
cp -p "$PREFIX/alert.env.orig" "$ETC/alert.env"
# DNS_RESOLVERS of platform-backend.env: every item needs its udp and tcp lines (the list holds the template's two
# literally); an empty value stands for the platform's defaults. Its values are compared, never printed.
cp -p "$ETC/platform-backend.env" "$PREFIX/platform-backend.env.orig"
sed -i -E 's#^DNS_RESOLVERS=.*#DNS_RESOLVERS=1.1.1.1:53,[2606:4700:4700::1111]:53,9.9.9.9#' "$ETC/platform-backend.env"
broken "resolvers of DNS_RESOLVERS that the allow-list lacks" firewall 'resolvers of DNS_RESOLVERS in platform-backend.env without a line of the allow-list .*: item 2 \(udp\), item 2 \(tcp\), item 3 \(udp\), item 3 \(tcp\)$' X-041
if grep -qE '2606:4700|9\.9\.9\.9' "$OUT/broken-$N-firewall.out"; then
  fail "check-vm.sh names the resolvers of DNS_RESOLVERS by their place, never by their value [X-041]"
else
  pass "check-vm.sh names the resolvers of DNS_RESOLVERS by their place, never by their value [X-041]"
fi
sed -i -E 's#^DNS_RESOLVERS=.*#DNS_RESOLVERS=#' "$ETC/platform-backend.env"
if run_check "$OUT/egress-dns-default.out" --only firewall &&
  grep -qxF 'PASS every resolver of DNS_RESOLVERS in platform-backend.env has its udp and tcp lines (2 resolvers)' "$OUT/egress-dns-default.out"; then
  pass "an empty DNS_RESOLVERS stands for the platform's two default resolvers, which the list has [X-041]"
else
  indent "$OUT/egress-dns-default.out"
  fail "an empty DNS_RESOLVERS stands for the platform's two default resolvers, which the list has [X-041]"
fi
# Amadeus base URLs: the official hosts (with or without a trailing slash) and the stub on loopback pass; another host
# is named by its variable and file, never by its value.
sed -i -E 's#^AMADEUS_BASE_URL_TEST=.*#AMADEUS_BASE_URL_TEST=http://127.0.0.1:4900#; s#^AMADEUS_BASE_URL_LIVE=.*#AMADEUS_BASE_URL_LIVE=https://travel.api.amadeus.com/#' "$ETC/platform-backend.env"
sed -i -E 's#^AMADEUS_BASE_URL_TEST=.*#AMADEUS_BASE_URL_TEST=https://amadeus-proxy.example.net:8443#' "$ETC/ota-backend.env"
broken "an Amadeus base URL whose host the allow-list lacks" firewall 'Amadeus base URLs whose host and port no line of the allow-list has .*: AMADEUS_BASE_URL_TEST of ota-backend.env$' X-041
if grep -qE 'amadeus-proxy|8443' "$OUT/broken-$N-firewall.out"; then
  fail "check-vm.sh names an Amadeus base URL by its variable, never by its value [X-041]"
else
  pass "check-vm.sh names an Amadeus base URL by its variable, never by its value [X-041]"
fi
cp -p "$PREFIX/ota-backend.env.orig" "$ETC/ota-backend.env"
cp -p "$PREFIX/platform-backend.env.orig" "$ETC/platform-backend.env"
cp -p "$ROOT/usr/local/sbin/velexis-egress" "$PREFIX/velexis-egress.orig"
echo '# changed on the VM' >>"$ROOT/usr/local/sbin/velexis-egress"
broken "an installed velexis-egress that is not the release's" firewall "velexis-egress is this deploy folder's scripts/egress.sh \\(it differs" X-041
cp -p "$PREFIX/velexis-egress.orig" "$ROOT/usr/local/sbin/velexis-egress"
echo '2026-01-01T00:00:00Z nft refused the table' >"$EG_STATE/failing"
broken "a refresh that keeps failing" firewall 'the refresh of the allow-list has been failing since 2026-01-01T00:00:00Z' X-041
egress_reset
echo 'deb http://mirror.example.net/ubuntu noble main' >"$ROOT/etc/apt/sources.list.d/mirror.list"
broken "an apt source the allow-list leaves out" firewall 'apt sources outside the allow-list \(unattended-upgrades cannot reach them\): mirror.example.net:80$' X-041
# ... and the step egress refuses it before anything changes: unattended-upgrades would stop finding updates.
before="$(egress_files; fingerprint "$EG_STATE")"
loads="$(applies)"
if provision_egress "$OUT/egress-apt-refused.log"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] && [ "$(egress_files; fingerprint "$EG_STATE")" = "$before" ] && [ "$(applies)" = "$loads" ] &&
  grep -qE '^ERROR: refused, nothing changed: apt sources without a line in .*: mirror\.example\.net:80\.' "$OUT/egress-apt-refused.log"; then
  pass "the step egress refuses an apt source the list leaves out, naming it, and changes nothing [X-041]"
else
  indent "$OUT/egress-apt-refused.log"
  fail "the step egress refuses an apt source the list leaves out and changes nothing (exit $rc) [X-041]"
fi
rm -f "$ROOT/etc/apt/sources.list.d/mirror.list"
# A malformed allow-list (in a copy of the deploy folder): refused before anything changes.
install -d -m 0755 "$PREFIX/deploy-copy"
cp -r "$DEPLOY/scripts" "$DEPLOY/egress" "$DEPLOY/systemd" "$PREFIX/deploy-copy/"
printf 'Example.org 443 tcp curl a host in capitals\nexample.org 0 tcp curl port zero\n' >>"$PREFIX/deploy-copy/egress/allowed-hosts.conf"
before="$(egress_files; fingerprint "$EG_STATE")"
loads="$(applies)"
if env -u SUDO_USER PATH="$FAKEBIN:$PATH" CHECKVM_FAKE="$FAKE" CHECKVM_PROVISION=1 VELEXIS_ROOT="$ROOT" \
  bash "$PREFIX/deploy-copy/scripts/provision-vm.sh" --steps egress >"$OUT/egress-invalid.log" 2>&1; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] && [ "$(egress_files; fingerprint "$EG_STATE")" = "$before" ] && [ "$(applies)" = "$loads" ] &&
  grep -qE '^ERROR: .*is not a valid allow-list, so nothing changed: line [0-9]+: Example.org is not a lower-case host name.*;line [0-9]+: the port 0 is not 1 to 65535' "$OUT/egress-invalid.log"; then
  pass "the step egress refuses a malformed allow-list, naming each line, and changes nothing [X-041]"
else
  indent "$OUT/egress-invalid.log"
  fail "the step egress refuses a malformed allow-list and changes nothing (exit $rc) [X-041]"
fi
rm -rf "$PREFIX/deploy-copy"

# velexis-egress: a lookup that fails keeps the last good addresses, a new answer is added while the earlier ones stay
# for 24 hours, an address older than that goes, a failed lookup keeps even old ones; each change is one load, logged.
egress_reset
cp -p "$FAKE/getent-hosts" "$PREFIX/getent-hosts.orig"
STRIPE_V4='192.0.2.10 . tcp . 443 comment "api.stripe.com"'
stripe_elements() { { nft_set allow4; nft_set allow6; } | grep -F 'comment "api.stripe.com"' | paste -sd'|' -; }
was="$(stripe_elements)"
loads="$(applies)"
sed -i '/^api.stripe.com /d' "$FAKE/getent-hosts"
if egress_refresh "$OUT/egress-lookup-fails.log" && [ "$(stripe_elements)" = "$was" ] && [ "$(applies)" = "$loads" ] &&
  grep -qF 'WARNING: api.stripe.com: no address for api.stripe.com; its last good addresses stay allowed (3)' "$OUT/egress-lookup-fails.log"; then
  pass "a lookup that fails keeps the host's last good addresses and loads nothing [X-041]"
else
  indent "$OUT/egress-lookup-fails.log"
  fail "a lookup that fails keeps the host's last good addresses and loads nothing [X-041]"
fi
echo 'api.stripe.com 192.0.2.13' >>"$FAKE/getent-hosts"
if egress_refresh "$OUT/egress-new-address.log" && [ "$(applies)" = "$((loads + 1))" ] &&
  nft_set allow4 | grep -qxF '192.0.2.13 . tcp . 443 comment "api.stripe.com"' && nft_set allow4 | grep -qxF "$STRIPE_V4" &&
  grep -qxF 'allowed: 192.0.2.13 . tcp . 443 comment "api.stripe.com"' "$OUT/egress-new-address.log" &&
  ! grep -q '^no longer allowed' "$OUT/egress-new-address.log"; then
  pass "a new address of a host is allowed and logged, and those of the last 24 hours stay (one load) [X-041]"
else
  indent "$OUT/egress-new-address.log"
  fail "a new address of a host is allowed and logged, and those of the last 24 hours stay [X-041]"
fi
# The addresses that answer no more, made older than 24 hours.
awk '$1 == "api.stripe.com" && $2 != "192.0.2.13" { $3 = 1 } { print }' "$EG_STATE/addresses" >"$PREFIX/addresses.old"
cp "$PREFIX/addresses.old" "$EG_STATE/addresses"
if egress_refresh "$OUT/egress-expired.log" && [ "$(stripe_elements)" = '192.0.2.13 . tcp . 443 comment "api.stripe.com"' ] &&
  grep -qxF "no longer allowed: $STRIPE_V4" "$OUT/egress-expired.log" &&
  grep -qxF 'no longer allowed: 2001:db8::10 . tcp . 443 comment "api.stripe.com"' "$OUT/egress-expired.log"; then
  pass "an address no lookup returned for more than 24 hours goes, logged [X-041]"
else
  indent "$OUT/egress-expired.log"
  fail "an address no lookup returned for more than 24 hours goes, logged [X-041]"
fi
awk '$1 == "api.stripe.com" { $3 = 1 } { print }' "$EG_STATE/addresses" >"$PREFIX/addresses.old"
cp "$PREFIX/addresses.old" "$EG_STATE/addresses"
sed -i '/^api.stripe.com /d' "$FAKE/getent-hosts"
loads="$(applies)"
if egress_refresh "$OUT/egress-old-kept.log" && [ "$(stripe_elements)" = '192.0.2.13 . tcp . 443 comment "api.stripe.com"' ] &&
  [ "$(applies)" = "$loads" ]; then
  pass "while a host's lookup fails, its last good addresses stay however old they are [X-041]"
else
  indent "$OUT/egress-old-kept.log"
  fail "while a host's lookup fails, its last good addresses stay however old they are [X-041]"
fi
cp -p "$PREFIX/getent-hosts.orig" "$FAKE/getent-hosts"

# The state file is root's own, but its values reach arithmetic: a line that is not "<listed host> <address> <time>" is
# ignored, and nothing in it runs.
egress_reset
loads="$(applies)"
printf '%s\n' "api.stripe.com 192.0.2.77 seen[\$(touch $PREFIX/egress-state-ran)]" "unlisted.example.net 192.0.2.78 $(date +%s)" \
  "api.stripe.com not-an-address $(date +%s)" >>"$EG_STATE/addresses"
if egress_refresh "$OUT/egress-bad-state.log" && [ ! -e "$PREFIX/egress-state-ran" ] && [ "$(applies)" = "$loads" ] &&
  ! { nft_set allow4; nft_set allow6; } | grep -qE '192\.0\.2\.7[78] |not-an-address' &&
  ! grep -qE '192\.0\.2\.7[78] |not-an-address' "$EG_STATE/addresses"; then
  pass "velexis-egress ignores a state line that is not a listed host, an address and a time, and runs nothing in it [X-041]"
else
  indent "$OUT/egress-bad-state.log"
  fail "velexis-egress ignores a state line that is not a listed host, an address and a time, and runs nothing in it (ran: $([ -e "$PREFIX/egress-state-ran" ] && echo yes || echo no)) [X-041]"
fi
egress_reset

# A table changed by hand is repaired on the next run; an emergency opening (runbook §4) is never touched.
egress_reset
echo accept >"$FAKE/nft/policy"
sed -i '1i tcp dport 25 accept' "$FAKE/nft/rules"
echo '203.0.113.99 . tcp . 25 comment "smtp.example.org"' >>"$FAKE/nft/set.allow4"
echo '203.0.113.10 . tcp . 443 timeout 4h expires 3h59m comment "INC-0001"' >"$FAKE/nft/set.emergency4"
if egress_refresh "$OUT/egress-repair.log" && [ "$(cat "$FAKE/nft/policy")" = drop ] &&
  cmp -s "$FAKE/nft/rules" "$FAKE/nft.healthy/rules" && [ "$(nft_set allow4)" = "$(sort "$FAKE/nft.healthy/set.allow4")" ] &&
  [ "$(cat "$FAKE/nft/set.emergency4")" = '203.0.113.10 . tcp . 443 timeout 4h expires 3h59m comment "INC-0001"' ] &&
  grep -qxF 'repaired: the policy of the chain output was not drop; the rules of the chain output differed' "$OUT/egress-repair.log" &&
  grep -qxF 'no longer allowed: 203.0.113.99 . tcp . 25 comment "smtp.example.org"' "$OUT/egress-repair.log"; then
  pass "a refresh repairs the policy, the rules and the allow sets changed by hand, logs it, and keeps the emergency opening [X-041]"
else
  indent "$OUT/egress-repair.log"
  fail "a refresh repairs the policy, the rules and the allow sets changed by hand, and keeps the emergency opening [X-041]"
fi

# A failing run leaves the table as it was; from the unit (--alert-once) only the first of a run of failures exits 1
# (one mail through OnFailure=), a manual run always does, and the next good run says it recovered.
egress_reset
echo accept >"$FAKE/nft/policy"
touch "$FAKE/nft-fails"
r1=0 r2=0 r3=0 r4=0
egress_refresh "$OUT/egress-fail-1.log" --alert-once || r1=$?
egress_refresh "$OUT/egress-fail-2.log" --alert-once || r2=$?
egress_refresh "$OUT/egress-fail-3.log" || r3=$?
was="$(cat "$FAKE/nft/policy")"
rm -f "$FAKE/nft-fails"
egress_refresh "$OUT/egress-recovered.log" --alert-once || r4=$?
if [ "$r1/$r2/$r3/$r4" = "1/0/1/0" ] && [ "$was" = accept ] && grep -q '^FAILED: nft refused the table, which stays as it was' "$OUT/egress-fail-1.log" &&
  grep -q '^still failing since ' "$OUT/egress-fail-2.log" && grep -q '^recovered (failing since ' "$OUT/egress-recovered.log" &&
  [ ! -e "$EG_STATE/failing" ] && [ "$(cat "$FAKE/nft/policy")" = drop ]; then
  pass "a failing refresh leaves the table as it was, exits 1 once from the unit (one alert) and on every manual run, and recovers [X-041]"
else
  for f in "$OUT"/egress-fail-?.log "$OUT/egress-recovered.log"; do indent "$f"; done
  fail "a failing refresh leaves the table as it was, exits 1 once from the unit, and recovers (exits $r1/$r2/$r3/$r4) [X-041]"
fi
egress_reset

# Step 1 of X-041 from the files: every host the step packages fetches from and the official Amadeus hosts of both
# backends have a line; no script or unit of the VM names GitHub (the Deploy workflow connects in over SSH).
missing=""
has_line() { awk -v h="$1" -v p="$2" '$1 == h && $2 == p && $3 == "tcp" { f = 1 } END { exit !f }' "$DEPLOY/egress/allowed-hosts.conf"; }
while read -r h; do
  has_line "$h" 443 || missing="$missing $h"
done < <(grep -vE '^[[:space:]]*#' "$PROVISION" | grep -oE 'https://[a-z0-9.-]+' | sed 's#^https://##' | sort -u)
for f in "$DEPLOY/../platform/backend/src/config.ts" "$DEPLOY/../ota/backend/src/amadeus/connection-resolver.ts"; do
  [ -f "$f" ] || continue
  while read -r h; do
    has_line "$h" 443 || missing="$missing $h"
  done < <(grep -oE 'https://[a-z0-9.-]+\.amadeus\.com' "$f" | sed 's#^https://##' | sort -u)
done
github="$(grep -lE 'github\.com|githubusercontent\.com' "$DEPLOY"/scripts/*.sh "$DEPLOY"/systemd/*.service "$DEPLOY"/systemd/*.timer \
  "$DEPLOY/caddy/Caddyfile" 2>/dev/null | grep -vE '/(pack-release|dev-setup)\.sh$' || true)"
if [ -z "$missing" ] && [ -z "$github" ] && bash "$DEPLOY/scripts/egress.sh" validate "$DEPLOY/egress/allowed-hosts.conf"; then
  pass "allowed-hosts.conf is valid, lists every host of the step packages and the official Amadeus hosts, and no VM-side script or unit names GitHub [X-041]"
else
  fail "allowed-hosts.conf lists every host of the step packages and Amadeus (missing:${missing:- none}), and no VM-side file names GitHub (${github:-none}) [X-041]"
fi
# harden runs the step egress too (step 2 of X-041), but never under VELEXIS_ROOT: read from provision-vm.sh, with the
# step node before harden, since corepack fetches pnpm from the npm registry that the list leaves out.
if awk '/^step_harden\(\) \{$/, /^\}$/ { if ($0 == "  step_egress") found = 1 } END { exit !found }' "$PROVISION" &&
  grep -qE '^ALL_STEPS="packages node harden ' "$PROVISION"; then
  pass "harden runs the step egress, and the step node runs before it (read from provision-vm.sh) [X-041]"
else
  fail "harden runs the step egress, and the step node runs before it (read from provision-vm.sh) [X-041]"
fi

step "the outbound allow-list with a real nft in a private network namespace (nft list, nft -f)"
REAL_NFT="${CHECKVM_NFT:-/usr/sbin/nft}"
REAL_NFT_RAN=0
if [ -x "$REAL_NFT" ] && command -v unshare >/dev/null && unshare -n "$REAL_NFT" list ruleset >"$OUT/nft-probe.out" 2>&1; then
  REAL_NFT_RAN=1
  install -d -m 0755 "$PREFIX/realnft"
  ln -sf "$REAL_NFT" "$PREFIX/realnft/nft"
  in_netns() { # script: runs in a new network namespace with the real nft first on PATH, the other fakes behind it
    unshare -n env PATH="$PREFIX/realnft:$FAKEBIN:$PATH" CHECKVM_FAKE="$FAKE" CHECKVM_PROVISION=1 VELEXIS_ROOT="$ROOT" \
      CHECKVM_SECRETS="$ETC/.provision-secrets" CHECKVM_CADDYFILE="$ROOT/etc/caddy/Caddyfile" DEPLOY_USER="$DEPLOY_TEST_USER" \
      EGRESS_BIN="$ROOT/usr/local/sbin/velexis-egress" CHECK="$CHECK" OUT="$OUT" bash -c "$1"
  }
  egress_reset
  # Loaded twice, then checked: the second run finds the table as nft lists it and changes nothing.
  # shellcheck disable=SC2016 # expanded in the namespace's shell
  in_netns 'bash "$EGRESS_BIN" refresh >"$OUT/real-nft-1.log" 2>&1; bash "$EGRESS_BIN" refresh >"$OUT/real-nft-2.log" 2>&1
    nft list table inet velexis_egress >"$OUT/real-nft-table.out" 2>&1; bash "$CHECK" --only firewall >"$OUT/real-nft-check.out" 2>&1
    echo "check exit $?" >>"$OUT/real-nft-check.out"' || true
  if grep -q '^created the table inet velexis_egress' "$OUT/real-nft-1.log" && grep -q '^unchanged: ' "$OUT/real-nft-2.log" &&
    grep -qx 'check exit 0' "$OUT/real-nft-check.out" && ! grep -q '^FAIL' "$OUT/real-nft-check.out" &&
    grep -q '^PASS refused outbound connections are logged' "$OUT/real-nft-check.out" &&
    grep -qF 'log prefix "VELEXIS-EGRESS-DENY " flags skuid' "$OUT/real-nft-table.out"; then
    pass "real nft: velexis-egress loads the table, a second run changes nothing, and check-vm.sh --only firewall passes on what nft lists [X-041 AC1]"
  else
    for f in real-nft-1.log real-nft-2.log real-nft-check.out; do indent "$OUT/$f"; done
    fail "real nft: velexis-egress loads the table, a second run changes nothing, and check-vm.sh --only firewall passes [X-041 AC1]"
  fi
  # Changed by hand: an extra destination, an extra rule, the policy accept and an emergency opening are each a FAIL;
  # the next refresh repairs all but the opening, which stays until its timeout.
  # shellcheck disable=SC2016 # expanded in the namespace's shell
  in_netns 'bash "$EGRESS_BIN" refresh >/dev/null 2>&1
    nft add element inet velexis_egress allow4 "{ 203.0.113.99 . tcp . 25 comment \"smtp.example.org\" }"
    nft add element inet velexis_egress emergency4 "{ 203.0.113.10 . tcp . 443 timeout 1h comment \"INC-0001 vendor X, opened by vxadmin\" }"
    nft insert rule inet velexis_egress output tcp dport 25 accept
    nft add chain inet velexis_egress output "{ policy accept; }"
    bash "$CHECK" --only firewall >"$OUT/real-nft-broken.out" 2>&1
    bash "$EGRESS_BIN" refresh >"$OUT/real-nft-repair.log" 2>&1
    bash "$CHECK" --only firewall >"$OUT/real-nft-repaired.out" 2>&1' || true
  if grep -q '^FAIL outgoing connections are denied by default (found: chain output of inet velexis_egress with policy accept)' "$OUT/real-nft-broken.out" &&
    grep -q '^FAIL outbound destinations outside /etc/velexis/egress/allowed-hosts.conf: 203.0.113.99 tcp/25 (comment "smtp.example.org")$' "$OUT/real-nft-broken.out" &&
    grep -q '^FAIL the chain output of inet velexis_egress allows more than the allow-list: \[tcp dport 25 accept\]$' "$OUT/real-nft-broken.out" &&
    grep -q '^FAIL an emergency opening is in place .*203.0.113.10 . tcp . 443 timeout 1h expires .* comment "INC-0001 vendor X, opened by vxadmin"$' "$OUT/real-nft-broken.out" &&
    grep -q '^repaired: the policy of the chain output was not drop; the rules of the chain output differed$' "$OUT/real-nft-repair.log" &&
    [ "$(grep -c '^FAIL' "$OUT/real-nft-repaired.out")" = 1 ] && grep -q '^FAIL an emergency opening is in place' "$OUT/real-nft-repaired.out"; then
    pass "real nft: check-vm.sh names an extra destination, an extra rule, policy accept and an emergency opening; a refresh repairs all but the opening [X-041 AC1]"
  else
    for f in real-nft-broken.out real-nft-repair.log real-nft-repaired.out; do indent "$OUT/$f"; done
    fail "real nft: check-vm.sh names each change made by hand, and a refresh repairs all but the emergency opening [X-041 AC1]"
  fi
  egress_reset
else
  # Lead decision (17a) of 2026-11-11 (owner-approved): without a working nft the allow-list's table is never loaded by
  # the kernel, so the test fails, and its last line says why (the real-sshd part only says so, below).
  fail "the real-nft checks of step 6b did not run: no nft that works in a private network namespace at $REAL_NFT ($(head -n 1 "$OUT/nft-probe.out" 2>/dev/null || echo 'not installed')); install nftables or set CHECKVM_NFT=<nft command> [FIX-W49-SHARED AC4]"
fi

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
  # The SMTP password and the bucket key that velexis-egress read the hosts beside (X-041).
  cat "$EGRESS_SECRETS"
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
if [ "$REAL_NFT_RAN" != 1 ]; then
  echo "check-vm.test: FAILED (the real-nft checks of step 6b did not run: see the FAIL line above; install nftables or set CHECKVM_NFT=<nft command>)"
elif [ "$FAILED" != 0 ]; then
  echo "check-vm.test: FAILED"
elif [ "$REAL_SSHD_RAN" = 1 ]; then
  echo "check-vm.test: all checks passed"
else
  echo "check-vm.test: all checks passed (the real-sshd checks of step 6 did not run: see the NOTE above)"
fi
[ "$FAILED" = 0 ]
