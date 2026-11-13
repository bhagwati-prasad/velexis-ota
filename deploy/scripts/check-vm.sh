#!/usr/bin/env bash
# =====================================================================================================
# check-vm.sh — read-only check of a Velexis VM that provision-vm.sh provisioned (task X-020).
#
#   sudo bash deploy/scripts/check-vm.sh                          # every group, templates of this deploy/ folder
#   sudo bash deploy/scripts/check-vm.sh --only envfiles,files    # selected groups
#   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh     # against the templates of the active release
#
# It prints one PASS or FAIL line per item and a total, and exits 0 when every item passes, 1 when one fails and 2
# on a usage error. It changes nothing and writes no file: it reads files and asks systemctl, ufw, nft (list only), sshd,
# swapon, sysctl, timedatectl, ss, psql (as postgres), redis-cli and caddy (as caddy). It never prints a value of an env
# file, a key file or .provision-secrets: env files are compared with their templates by variable name only, key
# copies with cmp, the Redis password reaches redis-cli through its environment, and caddy's messages are shown only
# with every value of caddy.env replaced by <redacted> (bash's own errors about a malformed caddy.env line are dropped).
# Of an admin's TOTP secret file it reads only the owner, the mode and the line " TOTP_AUTH", never the secret.
#
# Groups and their items (docs/mvp/deployment-single-vm.md §2 to §7):
#   system    Ubuntu 24.04; time zone UTC; no swap (swapon --show is empty, no swap line in /etc/fstab); no core
#             dumps (kernel.core_pattern |/bin/false, fs.suid_dumpable 0, apport.service masked); unattended
#             upgrades on; an AIDE database exists, and dailyaidecheck.timer (package aide-common), which runs AIDE's
#             daily check, is active and enabled (PCI DSS 11.5.2; lead decision (13j) of 2026-11-10); AIDE's
#             /etc/aide/aide.conf.d/90_velexis holds the lines report_level=added_removed_entries and
#             /var/lib/apt/lists/[^/]+$ f VarFile as provision-vm.sh's step harden writes them (lead decision (21l) of
#             2026-11-13)
#   services  postgresql, redis-server, caddy, velexis-backup.timer and velexis-healthcheck.timer active and enabled,
#             the cluster postgresql@16-main active; fail2ban, auditd and chrony active and enabled; Node.js 22; the
#             security logs of task X-038 (lead decision (20p) of 2026-11-13): velexis-ship-logs.timer and
#             velexis-log-review.timer active and enabled, and auditd's syslog plugin on as provision-vm.sh writes it
#             (/etc/audit/plugins.d/syslog.conf: active = yes, direction = out, path = an executable audisp-syslog), so
#             that auditd's records reach the journal and leave the VM
#   firewall  ufw active, incoming denied by default, and only 22, 80 and 443 allowed (each of them allowed); the
#             outbound allow-list of task X-041 (nft list table inet velexis_egress, read through egress.sh parse):
#             outgoing denied by default (chain output, policy drop), the chain's rules exactly those of egress.sh,
#             refusals logged (prefix VELEXIS-EGRESS-DENY), every address of the sets allow4 and allow6 on a line of
#             /etc/velexis/egress/allowed-hosts.conf, kept by the last refresh (an extra one named), each line with an
#             address, every env: line's URL on its line's port, each DNS_RESOLVERS item of platform-backend.env on a
#             udp and a tcp line, both backends' AMADEUS_BASE_URL_TEST and _LIVE, when set, on a line (values compared,
#             never printed), no emergency opening, the installed list and /usr/local/sbin/velexis-egress the release's,
#             every apt source of the VM (egress.sh apt-hosts) on the list, the last refresh not failing,
#             velexis-egress-refresh.timer active and enabled and its service enabled for boot
#   ssh       sshd -T: no password and no keyboard-interactive authentication, no root login, public keys allowed,
#             AllowUsers set. Every AllowUsers user but DEPLOY_USER is an admin, and sshd -T -C user=<admin> shows a
#             second factor (task X-037): a FIDO2 key (publickey with sk-ssh-ed25519@openssh.com only, verify-required)
#             with only such keys in ~/.ssh/authorized_keys, or the key and a TOTP code (publickey,keyboard-interactive:
#             pam, pam_google_authenticator in /etc/pam.d/sshd without nullok and without the password, the admin's
#             ~/.google_authenticator 0400 or 0600). sshd -T -C user=<deploy> shows public key only, no TTY, no
#             forwarding. Both read keys only from .ssh/authorized_keys.
#   database  PostgreSQL 16 with conf.d/velexis.conf in effect, listening on loopback only; the database belongs to
#             velexis_migrator; the four roles exist (login, not superuser); velexis_ota_app's search_path is pg_catalog
#   redis     Redis 7.4 on loopback only; clients without the password refused; maxmemory 512mb with
#             maxmemory-policy noeviction; AOF on
#   caddy     Caddy 2.8; caddy validate passes with caddy.env, run as the caddy user; the admin API is not on TCP
#             (ss -ltn shows no :2019); /run/caddy is 0700 caddy and holds the socket admin.sock
#   users     the five zone users of ADR-0026 (no shell, locked); the group velexis has exactly them as members and is
#             nobody's primary group; the deploy user is locked and each of its SSH keys carries restrict
#   files     owners and modes of §4: /etc/velexis, the key folders (0500) and key files (0400) of each zone (with the
#             master key named by MASTER_KEY_CURRENT in the zone's backend env file, master-v1.key when unset),
#             identical master-key and pepper copies and no zone-only key in the other zone, env files and
#             .provision-secrets root:root 0600, /srv/velexis with incoming, releases (root:velexis, read-only),
#             current and maintenance, /var/lib/velexis and its storage, the backup and log folders, the root-owned
#             scripts (velexis-deploy, -backup, -restore, -alert, -run and -healthcheck), the sudoers rule
#   envfiles  every /etc/velexis/<app>.env has every variable of its deploy/env/<app>.env.example template (an empty
#             value is fine; missing ones are listed by name); caddy.env and ota-backend.env hold the same edge
#             secret, ota-backend.env and ota-admin.env the same service key (compared, never printed)
#
# Options: --only <group,...>; --templates <folder> (the env templates; default: env/ of this script's deploy/ folder).
# Environment: DEPLOY_USER (deploy), DB_NAME (velexis), PG_MAJOR (16), the same values as for provision-vm.sh. The
# admin users need no setting: they are the users of sshd's AllowUsers other than DEPLOY_USER.
# Tests only: VELEXIS_ROOT=<absolute folder> reads every file under that folder instead of / (the switch of
# provision-vm.sh); deploy/scripts/test/check-vm.test.sh also puts fake system tools first on PATH.
# =====================================================================================================
set -uo pipefail
umask 077

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATES="$DEPLOY_DIR/env"
: "${DEPLOY_USER:=deploy}"
: "${DB_NAME:=velexis}"
: "${PG_MAJOR:=16}"
: "${VELEXIS_ROOT:=}"
ALL_GROUPS="system services firewall ssh database redis caddy users files envfiles"
SELECTED="$ALL_GROUPS"

R="$VELEXIS_ROOT"
ETC="$R/etc/velexis"
SRV="$R/srv/velexis"
LIB="$R/var/lib/velexis"
LOGS="$R/var/log/velexis"
BACKUPS="$R/var/backups/velexis"
SBIN="$R/usr/local/sbin"
SUDOERS_FILE="$R/etc/sudoers.d/velexis-deploy"
SECRETS_FILE="$ETC/.provision-secrets"
CADDY_RUN="$R/run/caddy"
CADDYFILE="$R/etc/caddy/Caddyfile"
ZONE_USERS=(velexis-platform velexis-ota velexis-portal velexis-platform-admin velexis-ota-admin)
RELEASE_GROUP=velexis
ROLES=(velexis_migrator velexis_ota_app velexis_platform_app velexis_provisioner)
ROOT_SCRIPTS=(velexis-deploy velexis-backup velexis-restore velexis-alert velexis-run velexis-healthcheck)
SSHD_CONFIG="$R/etc/ssh/sshd_config"
PAM_SSHD="$R/etc/pam.d/sshd"

usage() { sed -n '2,/^# =====/p' "$0"; exit "$1"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --only) [ $# -ge 2 ] || usage 2; SELECTED="${2//,/ }"; shift 2 ;;
    --templates) [ $# -ge 2 ] || usage 2; TEMPLATES="$2"; shift 2 ;;
    -h | --help) usage 0 ;;
    *) printf 'check-vm.sh: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
for g in $SELECTED; do
  case " $ALL_GROUPS " in *" $g "*) ;; *) printf 'check-vm.sh: unknown group %s (groups: %s)\n' "$g" "$ALL_GROUPS" >&2; exit 2 ;; esac
done
[ "$(id -u)" -eq 0 ] || { printf 'check-vm.sh: run as root (sudo)\n' >&2; exit 2; }
if [ -n "$R" ]; then
  case "$R" in /?*) ;; *) printf 'check-vm.sh: VELEXIS_ROOT must be an absolute path other than /\n' >&2; exit 2 ;; esac
fi

PASSED=0
FAILED=0
pass() { printf 'PASS %s\n' "$*"; PASSED=$((PASSED + 1)); }
fail() { printf 'FAIL %s\n' "$*"; FAILED=$((FAILED + 1)); }
detail() { printf '     %s\n' "$@"; } # extra lines under a FAIL; never a value
have() { command -v "$1" >/dev/null 2>&1; }
show() { printf '%s' "${1#"$R"}"; }   # a path as it is on the VM (without the test prefix)
mode_of() { stat -c '%U:%G %a' "$1" 2>/dev/null; }
first_line() { printf '%s\n' "$1" | head -n 1; }

expect_mode() { # path "user:group mode"
  local got
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then fail "$(show "$1") exists ($2)"; return; fi
  got="$(mode_of "$1")"
  if [ "$got" = "$2" ]; then pass "$(show "$1") is $2"; else fail "$(show "$1") is $got, expected $2"; fi
}

unit_state() { # unit -> "<active state> <enabled state>"
  local a e
  a="$(systemctl is-active "$1" 2>/dev/null)"
  e="$(systemctl is-enabled "$1" 2>/dev/null)"
  printf '%s %s' "${a:-unknown}" "${e:-unknown}"
}

listening_on() { # port -> the local addresses with a TCP listener on that port, one per line
  ss -Hltn 2>/dev/null | awk -v p=":$1" '{
    a = $4
    if (length(a) > length(p) && substr(a, length(a) - length(p) + 1) == p) print substr(a, 1, length(a) - length(p))
  }'
}

loopback_only() { # port label
  local addrs a bad=""
  if ! have ss; then fail "ss is installed (package iproute2)"; return; fi
  addrs="$(listening_on "$1")"
  if [ -z "$addrs" ]; then fail "$2 listens on 127.0.0.1:$1"; return; fi
  for a in $addrs; do
    case "$a" in 127.0.0.1 | '[::1]' | ::1) ;; *) bad="$bad $a" ;; esac
  done
  if [ -z "$bad" ]; then pass "$2 listens on loopback only (:$1)"; else fail "$2 listens beyond loopback on :$1:$bad"; fi
}

env_value() { # file key -> sets ENV_VALUE to the value of the last KEY= line, quotes removed. Never printed.
  local line v=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$2="*) v="${line#"$2="}" ;; esac
  done <"$1"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  ENV_VALUE="$v"
}

# ---- system -----------------------------------------------------------------------------------------------
# AIDE's two settings of provision-vm.sh's 90_velexis (lead decision (21l) of 2026-11-13): AIDE details added entries,
# so a second change to a file that was new at aideinit raises velexis-logreview's aide-change, and apt's package lists
# get aide-common's relaxed rule, since 31_aide_apt does not read Ubuntu 24.04's deb822 sources (deployment §12).
AIDE_SETTINGS=('report_level=added_removed_entries' '/var/lib/apt/lists/[^/]+$ f VarFile')
aide_settings() {
  local f="$R/etc/aide/aide.conf.d/90_velexis" line missing=""
  local fix="sudo bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps harden"
  if [ ! -f "$f" ]; then
    fail "AIDE's 90_velexis details added entries and relaxes apt's lists (/etc/aide/aide.conf.d/90_velexis is missing; $fix)"
    return
  fi
  for line in "${AIDE_SETTINGS[@]}"; do
    grep -qxF -- "$line" "$f" || missing="${missing:+$missing, }$line"
  done
  if [ -z "$missing" ]; then
    pass "AIDE's 90_velexis details added entries and relaxes apt's lists (${AIDE_SETTINGS[0]}; ${AIDE_SETTINGS[1]})"
  else
    fail "AIDE's 90_velexis details added entries and relaxes apt's lists (missing the line: $missing; $fix)"
  fi
}

group_system() {
  local os tz swaps fstab state v
  # shellcheck disable=SC1091
  os="$(. /etc/os-release 2>/dev/null && printf '%s %s' "${ID:-}" "${VERSION_ID:-}")"
  if [ "$os" = "ubuntu 24.04" ]; then pass "Ubuntu 24.04 LTS"; else fail "Ubuntu 24.04 LTS (found: ${os:-unknown})"; fi

  tz="$(timedatectl show -p Timezone --value 2>/dev/null)"
  case "$tz" in UTC | Etc/UTC) pass "time zone is UTC" ;; *) fail "time zone is UTC (found: ${tz:-unknown})" ;; esac

  if have swapon; then
    swaps="$(swapon --show --noheadings 2>&1 | awk '{ print $1 }' | paste -sd' ' -)"
    if [ -z "$swaps" ]; then pass "swapon --show is empty (no swap)"; else fail "swap is on: $swaps"; fi
  else
    fail "swapon is installed"
  fi
  fstab="$(awk '$0 !~ /^[[:space:]]*#/ && $3 == "swap" { print $1 }' "$R/etc/fstab" 2>/dev/null | paste -sd' ' -)"
  if [ -z "$fstab" ]; then pass "/etc/fstab activates no swap"; else fail "/etc/fstab activates swap at boot: $fstab"; fi

  v="$(sysctl -n kernel.core_pattern 2>/dev/null)"
  if [ "$v" = "|/bin/false" ]; then pass "kernel.core_pattern is |/bin/false (no core dumps)"; else fail "kernel.core_pattern is |/bin/false (found: ${v:-unknown})"; fi
  v="$(sysctl -n fs.suid_dumpable 2>/dev/null)"
  if [ "$v" = 0 ]; then pass "fs.suid_dumpable is 0"; else fail "fs.suid_dumpable is 0 (found: ${v:-unknown})"; fi
  state="$(systemctl is-enabled apport.service 2>/dev/null)"
  case "$state" in
    masked | masked-runtime) pass "apport.service is masked (it would replace kernel.core_pattern at boot)" ;;
    '' | not-found) pass "apport.service is not installed" ;;
    *) fail "apport.service is $state: it replaces kernel.core_pattern at every boot (mask it)" ;;
  esac

  if grep -qE '^APT::Periodic::Unattended-Upgrade "1";' "$R/etc/apt/apt.conf.d/20auto-upgrades" 2>/dev/null; then
    pass "unattended-upgrades runs daily"
  else
    fail "unattended-upgrades runs daily (/etc/apt/apt.conf.d/20auto-upgrades)"
  fi
  if [ -s "$R/var/lib/aide/aide.db" ]; then pass "the AIDE database exists"; else fail "the AIDE database exists (/var/lib/aide/aide.db; run aideinit)"; fi
  aide_settings
  # AIDE's daily check (PCI DSS 11.5.2) runs from the timer of the package aide-common, which provision-vm.sh enables.
  state="$(unit_state dailyaidecheck.timer)"
  if [ "$state" = "active enabled" ]; then
    pass "dailyaidecheck.timer is active and enabled (AIDE's daily check)"
  else
    fail "dailyaidecheck.timer is active and enabled (found: $state; systemctl enable --now dailyaidecheck.timer)"
  fi
}

# ---- services ---------------------------------------------------------------------------------------------
group_services() {
  local u s v
  if ! have systemctl; then fail "systemctl is installed"; return; fi
  for u in postgresql redis-server caddy velexis-backup.timer velexis-healthcheck.timer fail2ban auditd chrony; do
    s="$(unit_state "$u")"
    if [ "$s" = "active enabled" ]; then pass "$u is active and enabled"; else fail "$u is active and enabled (found: $s)"; fi
  done
  # The security logs (X-038; lead decision (20p) of 2026-11-13): the hourly shipment off the VM and its review.
  for u in velexis-ship-logs.timer velexis-log-review.timer; do
    s="$(unit_state "$u")"
    if [ "$s" = "active enabled" ]; then
      pass "$u is active and enabled (security logs, X-038)"
    else
      fail "$u is active and enabled (found: $s; sudo bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps scripts)"
    fi
  done
  audit_syslog_plugin
  # postgresql.service only groups the clusters; this is the server (started through postgresql.service).
  s="$(systemctl is-active "postgresql@${PG_MAJOR}-main" 2>/dev/null)"
  if [ "$s" = active ]; then pass "postgresql@${PG_MAJOR}-main is active"; else fail "postgresql@${PG_MAJOR}-main is active (found: ${s:-unknown})"; fi
  v="$(node --version 2>/dev/null)"
  case "$v" in v22.*) pass "Node.js $v" ;; *) fail "Node.js 22 (found: ${v:-none})" ;; esac
}

# auditd's syslog plugin (X-038): the settings provision-vm.sh writes (audit_records_to_journal). The package ships the
# plugin off; without it auditd's records never reach the journal, so neither velexis-shiplogs nor velexis-logreview
# sees them.
AUDIT_SYSLOG_PLUGIN="$R/etc/audit/plugins.d/syslog.conf"
plugin_setting() { # key -> its value in the plugin's file (the last line that sets it, as auditd reads it)
  awk -v k="$1" '/^[[:space:]]*#/ { next } index($0, "=") {
      key = substr($0, 1, index($0, "=") - 1); gsub(/[[:space:]]/, "", key)
      if (key == k) { v = substr($0, index($0, "=") + 1); sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v); last = v }
    } END { printf "%s", last }' "$AUDIT_SYSLOG_PLUGIN"
}
audit_syslog_plugin() {
  local active direction path what
  what="auditd's syslog plugin is on ($(show "$AUDIT_SYSLOG_PLUGIN"): active = yes, direction = out, path = audisp-syslog)"
  if [ ! -f "$AUDIT_SYSLOG_PLUGIN" ]; then
    fail "$what: the file is missing (sudo bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps scripts)"
    return
  fi
  active="$(plugin_setting active)"
  direction="$(plugin_setting direction)"
  path="$(plugin_setting path)"
  if [ "$active" != yes ]; then
    fail "$what (found: active = ${active:-unset}; provision-vm.sh --steps scripts turns it on)"
  elif [ "$direction" != out ]; then
    fail "$what (found: direction = ${direction:-unset})"
  elif [ "${path##*/}" != audisp-syslog ] || [ ! -x "$R$path" ]; then
    fail "$what (found: path = ${path:-unset}, not an executable audisp-syslog)"
  else
    pass "$what"
  fi
}

# ---- firewall ---------------------------------------------------------------------------------------------
group_firewall() {
  local out rules to port p seen="" extra="" missing=""
  if ! have ufw; then fail "ufw is installed"; return; fi
  out="$(ufw status verbose 2>&1)"
  if grep -q '^Status: active' <<<"$out"; then pass "ufw is active"; else fail "ufw is active (found: $(first_line "$out"))"; fi
  if grep -q '^Default: deny (incoming)' <<<"$out"; then
    pass "ufw denies incoming connections by default"
  else
    fail "ufw denies incoming connections by default"
  fi
  # Rules below the "--" line: To, Action, From, separated by two or more spaces. Only ALLOW and LIMIT rules for
  # incoming traffic open a port; "Anywhere" (all ports), app profiles and ranges count as more than allowed.
  rules="$(printf '%s\n' "$out" | awk '
    /^--/ { body = 1; next }
    body && NF {
      split($0, col, /  +/)
      if (col[2] ~ /OUT/ || col[2] !~ /^(ALLOW|LIMIT)/) next
      to = col[1]
      sub(/ \(v6\)$/, "", to)
      sub(/ on [^ ]+$/, "", to)
      gsub(/ /, "_", to)
      print to
    }' | sort -u)"
  for to in $rules; do
    port="${to%%/*}"
    [ "$port" != OpenSSH ] || port=22   # the ufw application profile of openssh-server
    for p in ${port//,/ }; do
      case "$p" in
        22 | 80 | 443) case " $seen " in *" $p "*) ;; *) seen="$seen $p" ;; esac ;;
        *) case " $extra " in *" $to "*) ;; *) extra="$extra $to" ;; esac ;;
      esac
    done
  done
  if [ -z "$extra" ]; then
    pass "ufw allows only 22, 80 and 443 (rules: $(printf '%s' "$rules" | paste -sd' ' -))"
  else
    fail "ufw allows more than 22, 80 and 443:$extra"
  fi
  for p in 22 80 443; do case " $seen " in *" $p "*) ;; *) missing="$missing $p" ;; esac; done
  if [ -z "$missing" ]; then pass "ufw allows 22, 80 and 443"; else fail "ufw does not allow:$missing"; fi
  firewall_egress   # the outbound allow-list (X-041), below
}

# ---- ssh --------------------------------------------------------------------------------------------------
sshd_t() { sshd -T -f "$SSHD_CONFIG" "$@" 2>&1; } # the effective settings; with -C user=<u>, those of u's logins
setting() { # sshd -T output, keyword -> the value of its first line
  printf '%s\n' "$1" | awk -v k="$2" '$1 == k && !done { sub(/^[^ ]+ /, ""); print; done = 1 }'
}
# A FIDO2 key line of authorized_keys: the option verify-required, then an sk-ssh-ed25519 key (its blob names the type).
SK_LINE="^[[:space:]]*([^[:space:]#]+,)?verify-required(,[^[:space:]]+)?[[:space:]]+sk-ssh-ed25519@openssh\\.com[[:space:]]+AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t[A-Za-z0-9+/]*=*([[:space:]]|\$)"

keys_file_only() { # user sshd-output: sshd reads that user's keys from .ssh/authorized_keys only (what check-vm.sh reads)
  local got
  got="$(setting "$2" authorizedkeysfile)"
  if [ "$got" = .ssh/authorized_keys ]; then pass "sshd -T -C user=$1: keys only from .ssh/authorized_keys"; else fail "sshd -T -C user=$1: keys only from .ssh/authorized_keys (found: ${got:-unset})"; fi
}

ssh_admin() { # admin user -> its second factor as sshd -T -C shows it, and the keys, secret and PAM file it relies on
  local u="$1" out am alg opts kbd pw pam home keys n f got
  if ! out="$(sshd_t -C "user=$u")"; then fail "sshd -T -C user=$u runs ($(first_line "$out"))"; return; fi
  am="$(setting "$out" authenticationmethods)"
  alg="$(setting "$out" pubkeyacceptedalgorithms)"
  opts="$(setting "$out" pubkeyauthoptions)"
  kbd="$(setting "$out" kbdinteractiveauthentication)"
  pw="$(setting "$out" passwordauthentication)"
  pam="$(setting "$out" usepam)"
  if ! home="$(getent passwd "$u" | cut -d: -f6)" || [ -z "$home" ]; then fail "admin user $u exists"; return; fi
  if [ "$am" = publickey ] && [ "$alg" = sk-ssh-ed25519@openssh.com ] && [[ " $opts " == *" verify-required "* ]] &&
    [ "$pw" = no ] && [ "$kbd" = no ]; then
    pass "sshd -T -C user=$u: second factor FIDO2 (publickey with sk-ssh-ed25519@openssh.com only, pubkeyauthoptions $opts)"
    keys_file_only "$u" "$out"
    keys="$(grep -cvE '^[[:space:]]*(#|$)' "$home/.ssh/authorized_keys" 2>/dev/null)"
    n="$(grep -cE "$SK_LINE" "$home/.ssh/authorized_keys" 2>/dev/null)"
    if [ "${n:-0}" -gt 0 ] && [ "$n" = "${keys:-0}" ]; then
      pass "every key of $u is a FIDO2 key (sk-ssh-ed25519) with verify-required ($n)"
    elif [ "${n:-0}" = 0 ]; then
      fail "$u has a FIDO2 key (sk-ssh-ed25519) with verify-required in $home/.ssh/authorized_keys"
    else
      fail "$((keys - n)) of $keys keys of $u are not FIDO2 keys with verify-required: sshd refuses them; remove them (docs/mvp/runbooks/ssh-access.md §4)"
    fi
  elif [ "$am" = publickey,keyboard-interactive:pam ] && [ "$kbd" = yes ] && [ "$pam" = yes ] && [ "$pw" = no ]; then
    pass "sshd -T -C user=$u: second factor TOTP (authenticationmethods publickey,keyboard-interactive:pam)"
    keys_file_only "$u" "$out"
    f="$home/.google_authenticator"
    got="$(stat -c '%U %a' "$f" 2>/dev/null)"
    if [ -f "$f" ] && [ ! -L "$f" ] && { [ "$got" = "$u 400" ] || [ "$got" = "$u 600" ]; } && grep -qx '" TOTP_AUTH' "$f"; then
      pass "$f is a time-based TOTP secret file, $got"
    else
      fail "$f is a time-based TOTP secret file of $u, 0400 or 0600 (found: ${got:-no file})"
    fi
    # The auth lines of /etc/pam.d/sshd: the TOTP module, never nullok (a login without a code), never the password.
    got="$(awk '/^[[:space:]]*#/ { next }
      /pam_google_authenticator/ { if (/nullok/) bad = bad ", nullok"; else if ($1 == "auth" && ($2 == "required" || $2 == "requisite")) ok = 1 }
      /^[[:space:]]*@include[[:space:]]+common-auth[[:space:]]*$/ { bad = bad ", @include common-auth" }
      END { if (!ok) bad = bad ", no required pam_google_authenticator line"; print substr(bad, 3) }' "$PAM_SSHD" 2>/dev/null || echo "no file")"
    if [ -z "$got" ]; then
      pass "$(show "$PAM_SSHD") asks for the TOTP code (pam_google_authenticator, no nullok, no password)"
    else
      fail "$(show "$PAM_SSHD") asks for the TOTP code only (found: $got)"
    fi
  else
    fail "sshd -T -C user=$u: a second factor, FIDO2 or TOTP (found: authenticationmethods ${am:-unset}, pubkeyauthoptions ${opts:-unset}, kbdinteractiveauthentication ${kbd:-unset}; docs/mvp/runbooks/ssh-access.md)"
  fi
}

ssh_deploy() { # the deploy user: public key only, no TTY, no forwarding (a system account, PCI 8.6)
  local u="$DEPLOY_USER" out am pw kbd kv got bad=""
  if ! out="$(sshd_t -C "user=$u")"; then fail "sshd -T -C user=$u runs ($(first_line "$out"))"; return; fi
  am="$(setting "$out" authenticationmethods)"
  pw="$(setting "$out" passwordauthentication)"
  kbd="$(setting "$out" kbdinteractiveauthentication)"
  if [ "$am" = publickey ] && [ "$pw" = no ] && [ "$kbd" = no ]; then
    pass "sshd -T -C user=$u: public key only (authenticationmethods publickey)"
  else
    fail "sshd -T -C user=$u: public key only (found: authenticationmethods ${am:-unset}, passwordauthentication ${pw:-unset}, kbdinteractiveauthentication ${kbd:-unset})"
  fi
  for kv in "permittty no" "disableforwarding yes" "allowtcpforwarding no" "allowagentforwarding no" \
    "allowstreamlocalforwarding no" "x11forwarding no" "permittunnel no"; do
    got="$(setting "$out" "${kv%% *}")"
    [ "$got" = "${kv#* }" ] || bad="$bad ${kv%% *} ${got:-unset},"
  done
  if [ -z "$bad" ]; then pass "sshd -T -C user=$u: no TTY and no forwarding (permittty no, disableforwarding yes)"; else fail "sshd -T -C user=$u: no TTY and no forwarding (found:${bad%,})"; fi
  keys_file_only "$u" "$out"
}

group_ssh() {
  local out key want got users u admins=""
  if ! have sshd; then fail "sshd is installed"; return; fi
  if ! out="$(sshd_t)"; then fail "sshd -T runs ($(first_line "$out"))"; return; fi
  for key in passwordauthentication:no kbdinteractiveauthentication:no permitrootlogin:no pubkeyauthentication:yes; do
    want="${key#*:}"
    key="${key%%:*}"
    got="$(setting "$out" "$key")"
    if [ "$got" = "$want" ]; then pass "sshd -T: $key $want"; else fail "sshd -T: $key $want (found: ${got:-unset})"; fi
  done
  # Every user AllowUsers lets in, but the deploy user, is a person who administers the VM: each needs a second factor.
  users="$(printf '%s\n' "$out" | awk '$1 == "allowusers" { print $2 }' | paste -sd' ' -)"
  if [ -z "$users" ]; then fail "sshd -T: AllowUsers limits SSH logins (found: none, every account may log in)"; return; fi
  pass "sshd -T: AllowUsers $users"
  for u in $users; do
    u="${u%%@*}"
    case "$u" in
      "$DEPLOY_USER") continue ;;
      '' | *[!a-z0-9_-]*) fail "AllowUsers entry $u is a plain user name (its second factor cannot be checked)"; continue ;;
    esac
    case " $admins " in *" $u "*) ;; *) admins="$admins $u" ;; esac
  done
  if [ -z "$admins" ]; then fail "sshd -T: AllowUsers lets an admin user in besides $DEPLOY_USER"; fi
  for u in $admins; do ssh_admin "$u"; done
  case " $users " in
    *" $DEPLOY_USER "* | *" $DEPLOY_USER@"*) ssh_deploy ;;
    *) fail "sshd -T: AllowUsers lets $DEPLOY_USER in (the Deploy workflow logs in as $DEPLOY_USER)" ;;
  esac
}

# ---- database ---------------------------------------------------------------------------------------------
pg() { # sql -> rows; psql as postgres over the local socket (peer authentication), read-only queries only
  (cd / && runuser -u postgres -- psql -X -A -t -q -v ON_ERROR_STOP=1 -d postgres -c "$1") 2>&1
}

group_database() {
  local out row r settings bad=""
  if ! have psql || ! have runuser; then fail "psql and runuser are installed"; return; fi
  case "$DB_NAME" in '' | [0-9]* | *[!a-z0-9_]*) fail "DB_NAME is a plain identifier (found: $DB_NAME)"; return ;; esac
  if ! settings="$(pg "/* check:settings */ SELECT name || '=' || setting FROM pg_settings WHERE name IN
      ('server_version_num', 'listen_addresses', 'shared_preload_libraries', 'max_locks_per_transaction',
       'log_parameter_max_length') ORDER BY 1")"; then
    fail "PostgreSQL answers psql as postgres ($(first_line "$settings"))"
    return
  fi
  for row in $settings; do
    case "$row" in
      server_version_num=*) [ "$(( ${row#*=} / 10000 ))" = "$PG_MAJOR" ] || bad="$bad $row" ;;
      listen_addresses=*) [ "$row" = listen_addresses=localhost ] || bad="$bad $row" ;;
      shared_preload_libraries=*) case "$row" in *pg_stat_statements*) ;; *) bad="$bad $row" ;; esac ;;
      max_locks_per_transaction=*) [ "$row" = max_locks_per_transaction=256 ] || bad="$bad $row" ;;
      log_parameter_max_length=*) [ "$row" = log_parameter_max_length=0 ] || bad="$bad $row" ;;
    esac
  done
  if [ -z "$bad" ] && [ "$(printf '%s\n' "$settings" | grep -c .)" = 5 ]; then
    pass "PostgreSQL $PG_MAJOR runs with conf.d/velexis.conf (listen_addresses, max_locks_per_transaction, pg_stat_statements, log_parameter_max_length)"
  else
    fail "PostgreSQL $PG_MAJOR runs with conf.d/velexis.conf (found:$bad)"
  fi
  loopback_only 5432 PostgreSQL

  out="$(pg "/* check:database */ SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DB_NAME'")"
  if [ "$out" = velexis_migrator ]; then pass "database $DB_NAME belongs to velexis_migrator"; else fail "database $DB_NAME belongs to velexis_migrator (found: ${out:-no such database})"; fi

  out="$(pg "/* check:roles */ SELECT rolname || ' ' || CASE WHEN rolcanlogin THEN 'login' ELSE 'nologin' END || ' ' ||
      CASE WHEN rolsuper THEN 'superuser' ELSE 'nosuperuser' END FROM pg_roles
      WHERE rolname IN ('velexis_migrator', 'velexis_provisioner', 'velexis_platform_app', 'velexis_ota_app') ORDER BY 1")"
  for r in "${ROLES[@]}"; do
    row="$(printf '%s\n' "$out" | awk -v r="$r" '$1 == r { print $2, $3 }')"
    case "$row" in
      "login nosuperuser") pass "role $r exists (login, not superuser)" ;;
      '') fail "role $r exists" ;;
      *) fail "role $r is login and not superuser (found: $row)" ;;
    esac
  done

  # The effective setting: a per-database ALTER ROLE ... IN DATABASE wins over the role-wide one (ADR-0004 leak guard).
  out="$(pg "/* check:search_path */ SELECT coalesce(
      (SELECT c FROM pg_db_role_setting s CROSS JOIN unnest(s.setconfig) c
        WHERE s.setrole = r.oid AND s.setdatabase = d.oid AND c LIKE 'search_path=%'),
      (SELECT c FROM pg_db_role_setting s CROSS JOIN unnest(s.setconfig) c
        WHERE s.setrole = r.oid AND s.setdatabase = 0 AND c LIKE 'search_path=%'), 'search_path unset')
    FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname = 'velexis_ota_app' AND d.datname = '$DB_NAME'")"
  if [ "$out" = "search_path=pg_catalog" ]; then
    pass "velexis_ota_app's search_path is pg_catalog"
  else
    fail "velexis_ota_app's search_path is pg_catalog (found: ${out:-no role or database})"
  fi
}

# ---- redis ------------------------------------------------------------------------------------------------
REDIS_PW=""
rcli() { REDISCLI_AUTH="$REDIS_PW" redis-cli -h 127.0.0.1 -p 6379 --no-auth-warning "$@" 2>&1 | tr -d '\r'; }

group_redis() {
  local out k v
  if ! have redis-cli; then fail "redis-cli is installed"; return; fi
  loopback_only 6379 Redis
  out="$(env -u REDISCLI_AUTH redis-cli -h 127.0.0.1 -p 6379 PING 2>&1)"
  case "$out" in *NOAUTH*) pass "Redis refuses clients without the password" ;; *) fail "Redis refuses clients without the password (found: $(first_line "$out"))" ;; esac
  REDIS_PW=""
  if [ -r "$SECRETS_FILE" ]; then
    while IFS='=' read -r k v; do [ "$k" != REDIS_PASSWORD ] || REDIS_PW="$v"; done <"$SECRETS_FILE"
  fi
  if [ -z "$REDIS_PW" ]; then fail "REDIS_PASSWORD is in $(show "$SECRETS_FILE")"; return; fi
  out="$(rcli INFO server | sed -n 's/^redis_version://p')"
  case "$out" in 7.4.*) pass "Redis $out" ;; *) fail "Redis 7.4 (found: ${out:-no answer})" ;; esac
  out="$(rcli CONFIG GET maxmemory-policy | sed -n 2p)"
  if [ "$out" = noeviction ]; then pass "maxmemory-policy is noeviction"; else fail "maxmemory-policy is noeviction (found: ${out:-no answer})"; fi
  out="$(rcli CONFIG GET maxmemory | sed -n 2p)"
  if [ "$out" = 536870912 ]; then pass "maxmemory is 512mb"; else fail "maxmemory is 512mb (found: ${out:-no answer})"; fi
  out="$(rcli CONFIG GET appendonly | sed -n 2p)"
  if [ "$out" = yes ]; then pass "AOF persistence is on"; else fail "AOF persistence is on (found: ${out:-no answer})"; fi
  REDIS_PW=""
}

# ---- caddy ------------------------------------------------------------------------------------------------
redact() { # text file -> the text with every value of the env file (6 characters or more) replaced
  local text="$1" line v
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
    v="${line#*=}"
    case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
    [ "${#v}" -lt 6 ] || text="${text//"$v"/"<redacted>"}"
  done <"$2"
  printf '%s' "$text"
}

group_caddy() {
  local out rc bin v addrs
  if ! have caddy; then fail "caddy is installed"; return; fi
  bin="$(command -v caddy)"
  v="$(caddy version 2>/dev/null | awk '{ print $1; exit }')"
  case "$v" in v2.8.*) pass "Caddy $v" ;; *) fail "Caddy 2.8 (found: ${v:-unknown})" ;; esac

  if [ ! -r "$ETC/caddy.env" ]; then
    fail "caddy validate passes with $(show "$ETC/caddy.env") (the file is missing)"
  elif ! id -u caddy >/dev/null 2>&1; then
    fail "caddy validate passes with caddy.env (there is no caddy user)"
  else
    # As the caddy service runs it: the caddy user, with caddy.env in its environment (never on a command line).
    # Errors of the file itself are dropped: for a malformed line bash would print part of a value ("<value>: command
    # not found"), which the redaction below cannot recognise. caddy validate then names what is missing.
    out="$(
      set -a
      # shellcheck disable=SC1090,SC1091
      . "$ETC/caddy.env" 2>/dev/null
      set +a
      cd / && runuser -u caddy -- "$bin" validate --config "$CADDYFILE" --adapter caddyfile 2>&1
    )"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      pass "caddy validate passes for $(show "$CADDYFILE") with caddy.env (as the caddy user)"
    else
      fail "caddy validate passes for $(show "$CADDYFILE") with caddy.env (as the caddy user)"
      out="$(redact "$out" "$ETC/caddy.env")"
      printf '%s\n' "$out" | tail -n 5 | while IFS= read -r v; do detail "$v"; done
    fi
  fi

  if have ss; then
    addrs="$(listening_on 2019 | paste -sd' ' -)"
    if [ -z "$addrs" ]; then pass "Caddy's admin API is not on TCP (ss -ltn shows no :2019)"; else fail "something listens on TCP :2019: $addrs"; fi
  else
    fail "ss is installed (package iproute2)"
  fi
  expect_mode "$CADDY_RUN" "caddy:caddy 700"
  if [ -S "$CADDY_RUN/admin.sock" ]; then pass "$(show "$CADDY_RUN")/admin.sock is a unix socket"; else fail "$(show "$CADDY_RUN")/admin.sock is a unix socket (is Caddy running with the Velexis Caddyfile?)"; fi
}

# ---- users ------------------------------------------------------------------------------------------------
locked() { case "$(getent shadow "$1" | cut -d: -f2)" in '!'* | '*'*) return 0 ;; *) return 1 ;; esac; }

group_users() {
  local u shell members want gid others home keys bad
  for u in "${ZONE_USERS[@]}"; do
    if ! id -u "$u" >/dev/null 2>&1; then fail "user $u exists"; continue; fi
    shell="$(getent passwd "$u" | cut -d: -f7)"
    if [ "$shell" = /usr/sbin/nologin ] && locked "$u"; then
      pass "user $u: no shell, password locked"
    else
      fail "user $u: no shell, password locked (shell $shell)"
    fi
  done
  if getent group "$RELEASE_GROUP" >/dev/null; then
    members="$(getent group "$RELEASE_GROUP" | cut -d: -f4 | tr ',' '\n' | sort | paste -sd, -)"
    want="$(printf '%s\n' "${ZONE_USERS[@]}" | sort | paste -sd, -)"
    if [ "$members" = "$want" ]; then pass "group $RELEASE_GROUP has exactly the five zone users"; else fail "group $RELEASE_GROUP has exactly the five zone users (found: ${members:-none})"; fi
    gid="$(getent group "$RELEASE_GROUP" | cut -d: -f3)"
    others="$(getent passwd | awk -F: -v gid="$gid" '$4 == gid { printf "%s ", $1 }')"
    if [ -z "$others" ]; then pass "group $RELEASE_GROUP is nobody's primary group"; else fail "group $RELEASE_GROUP is the primary group of: $others"; fi
  else
    fail "group $RELEASE_GROUP exists"
  fi

  if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then fail "deploy user $DEPLOY_USER exists"; return; fi
  if locked "$DEPLOY_USER"; then pass "deploy user $DEPLOY_USER: password locked"; else fail "deploy user $DEPLOY_USER: password locked"; fi
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  if [ ! -s "$home/.ssh/authorized_keys" ]; then
    fail "$home/.ssh/authorized_keys holds the deploy key (set DEPLOY_SSH_PUBKEY_FILE and run provision-vm.sh --steps users)"
    return
  fi
  expect_mode "$home/.ssh/authorized_keys" "$DEPLOY_USER:$DEPLOY_USER 600"
  keys="$(grep -cvE '^[[:space:]]*(#|$)' "$home/.ssh/authorized_keys")"
  bad="$(grep -vE '^[[:space:]]*(#|$)' "$home/.ssh/authorized_keys" | grep -cvE '^restrict[ ,]')"
  if [ "$bad" = 0 ]; then pass "every key of $DEPLOY_USER carries restrict ($keys)"; else fail "$bad of $keys keys of $DEPLOY_USER lack restrict"; fi
}

# ---- files ------------------------------------------------------------------------------------------------
key_folder() { # folder owner required-file... -> the required files exist, and every file is 0400 owner:owner
  local dir="$1" owner="$2" f missing="" bad=""
  shift 2
  expect_mode "$dir" "$owner:$owner 500"
  [ -d "$dir" ] || return 0
  for f in "$@"; do [ -e "$dir/$f" ] || missing="$missing $f"; done
  for f in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    [ "$(mode_of "$f")" = "$owner:$owner 400" ] && [ -f "$f" ] && [ ! -L "$f" ] || bad="$bad $(basename "$f") ($(mode_of "$f"))"
  done
  if [ -n "$missing" ]; then fail "$(show "$dir") holds$missing"; else pass "$(show "$dir") holds $*"; fi
  if [ -z "$bad" ]; then pass "every file in $(show "$dir") is a plain file, 0400 $owner"; else fail "files in $(show "$dir") that are not 0400 $owner:$bad"; fi
}

# The master key a zone's backends use: the file of MASTER_KEY_CURRENT=local:v<N> in the zone's backend env file, or
# master-v1.key when that is unset. After a rotation the old key is gone (docs/mvp/runbooks/master-key-rotation.md).
current_master_key() { # env file name -> master-v<N>.key
  local name=master-v1.key
  if [ -f "$ETC/$1" ]; then
    env_value "$ETC/$1" MASTER_KEY_CURRENT
    [[ "$ENV_VALUE" =~ ^local:v[1-9][0-9]{0,8}$ ]] && name="master-${ENV_VALUE#local:}.key"
    ENV_VALUE=""
  fi
  printf '%s' "$name"
}

group_files() {
  local k="$ETC/keys" f name rel target bad
  expect_mode "$ETC" "root:root 711"
  expect_mode "$k" "root:root 711"
  key_folder "$k/platform" velexis-platform "$(current_master_key platform-backend.env)" api-key-pepper platform-jwt-ed25519.pem
  key_folder "$k/ota" velexis-ota "$(current_master_key ota-backend.env)" api-key-pepper ota-jwt-ed25519.pem document-url.key
  # Keys both backends need are identical copies (ADR-0026), including every master key of a rotation.
  for name in $( (cd "$k/platform" 2>/dev/null && ls -1 master-v*.key api-key-pepper 2>/dev/null
                  cd "$k/ota" 2>/dev/null && ls -1 master-v*.key api-key-pepper 2>/dev/null) | sort -u); do
    if [ -f "$k/platform/$name" ] && [ -f "$k/ota/$name" ] && cmp -s "$k/platform/$name" "$k/ota/$name"; then
      pass "$name: identical copies in keys/platform and keys/ota"
    else
      fail "$name: identical copies in keys/platform and keys/ota"
    fi
  done
  bad=""
  for f in ota-jwt-ed25519.pem document-url.key; do [ ! -e "$k/platform/$f" ] || bad="$bad platform/$f"; done
  [ ! -e "$k/ota/platform-jwt-ed25519.pem" ] || bad="$bad ota/platform-jwt-ed25519.pem"
  if [ -z "$bad" ]; then pass "no zone holds the other zone's own keys"; else fail "keys in the wrong zone:$bad"; fi
  expect_mode "$ETC/backup" "root:root 700"

  bad=""
  for f in "$ETC"/*.env "$SECRETS_FILE"; do
    [ -e "$f" ] || continue
    [ "$(mode_of "$f")" = "root:root 600" ] || bad="$bad $(basename "$f") ($(mode_of "$f"))"
  done
  if [ ! -e "$SECRETS_FILE" ]; then fail "$(show "$SECRETS_FILE") exists"; fi
  if [ -z "$bad" ]; then pass "every env file and .provision-secrets is root:root 600"; else fail "env files that are not root:root 600:$bad"; fi

  expect_mode "$SRV" "root:root 755"
  expect_mode "$SRV/incoming" "$DEPLOY_USER:$DEPLOY_USER 750"
  expect_mode "$SRV/releases" "root:$RELEASE_GROUP 751"
  for rel in "$SRV"/releases/*; do
    [ -e "$rel" ] || continue
    bad="$(find "$rel" \( ! -user root -o ! -group "$RELEASE_GROUP" -o -perm /222 \) -print -quit 2>/dev/null)"
    if [ -d "$rel" ] && [ -z "$bad" ]; then
      pass "$(show "$rel") is root:$RELEASE_GROUP and read-only"
    else
      fail "$(show "$rel") is root:$RELEASE_GROUP and read-only (first exception: $(show "${bad:-$rel}"))"
    fi
  done
  if [ -L "$SRV/current" ]; then
    target="$(readlink "$SRV/current")"
    case "$target" in
      "$SRV"/releases/?* | releases/?*) if [ -d "$SRV/current/" ]; then pass "$(show "$SRV/current") points at $(show "$target")"; else fail "$(show "$SRV/current") points at a missing release"; fi ;;
      *) fail "$(show "$SRV/current") points outside $(show "$SRV/releases")" ;;
    esac
  elif [ -e "$SRV/current" ]; then
    fail "$(show "$SRV/current") is a symlink"
  else
    pass "$(show "$SRV/current"): no release deployed yet"
  fi
  expect_mode "$SRV/maintenance" "root:root 755"
  expect_mode "$SRV/maintenance/index.html" "root:root 644"

  expect_mode "$LIB" "root:root 711"
  expect_mode "$LIB/storage" "velexis-ota:velexis-ota 700"
  expect_mode "$BACKUPS" "root:root 700"
  expect_mode "$LOGS" "root:adm 750"
  for f in "${ROOT_SCRIPTS[@]}"; do expect_mode "$SBIN/$f" "root:root 755"; done
  expect_mode "$SUDOERS_FILE" "root:root 440"
  if [ "$(cat "$SUDOERS_FILE" 2>/dev/null)" = "$DEPLOY_USER ALL=(root) NOPASSWD: $SBIN/velexis-deploy" ]; then
    pass "$DEPLOY_USER may run only $(show "$SBIN")/velexis-deploy with sudo"
  else
    fail "$(show "$SUDOERS_FILE") allows $DEPLOY_USER exactly $(show "$SBIN")/velexis-deploy"
  fi
}

# ---- envfiles ---------------------------------------------------------------------------------------------
same_value() { # key file-a file-b: compares the two values without printing them
  local a b
  if [ ! -f "$ETC/$2" ] || [ ! -f "$ETC/$3" ]; then fail "$1 is the same in $2 and $3 (a file is missing)"; return; fi
  env_value "$ETC/$2" "$1"
  a="$ENV_VALUE"
  env_value "$ETC/$3" "$1"
  b="$ENV_VALUE"
  ENV_VALUE=""
  if [ -n "$a" ] && [ "$a" = "$b" ]; then pass "$1 is the same in $2 and $3"; else fail "$1 is the same, and not empty, in $2 and $3"; fi
}

group_envfiles() {
  local tpl name dest keys key missing n=0
  for tpl in "$TEMPLATES"/*.env.example; do
    [ -f "$tpl" ] || continue
    n=$((n + 1))
    name="$(basename "$tpl" .example)"
    dest="$ETC/$name"
    keys="$(grep -oE '^[A-Z][A-Z0-9_]*=' "$tpl" | tr -d '=')"
    if [ ! -f "$dest" ]; then
      if [ -z "$keys" ]; then pass "$(show "$dest") is optional (its template names no variable)"; else fail "$(show "$dest") exists (template $name.example)"; fi
      continue
    fi
    missing=""
    for key in $keys; do grep -qE "^${key}=" "$dest" || missing="$missing $key"; done
    if [ -z "$missing" ]; then
      pass "$(show "$dest") has every variable of $name.example ($(printf '%s\n' "$keys" | grep -c .))"
    else
      fail "$(show "$dest") lacks variables of $name.example:$missing"
    fi
  done
  if [ "$n" = 0 ]; then fail "env templates found in $TEMPLATES"; return; fi
  same_value VELEXIS_EDGE_SECRET caddy.env ota-backend.env
  same_value OTA_ADMIN_SERVICE_KEY ota-backend.env ota-admin.env
}

# ---- firewall: the outbound allow-list (task X-041, PCI DSS 11.5.1.1; part of the group firewall) -------------------
EGRESS="$DEPLOY_DIR/scripts/egress.sh"   # its parse and apt-hosts commands only read
EGRESS_LIST="$ETC/egress/allowed-hosts.conf"
EGRESS_STATE="$LIB/egress"
EGRESS_LOG_RULE='limit rate 10/minute burst 5 packets log prefix "VELEXIS-EGRESS-DENY " flags skuid'
# The rules of the chain output as nft prints them: the same list as RULES of egress.sh, held here on its own.
EGRESS_RULES=(
  'oifname "lo" accept'
  'ct state established,related accept'
  'ct state invalid drop'
  'ip daddr . meta l4proto . th dport @allow4 accept'
  'ip6 daddr . meta l4proto . th dport @allow6 accept'
  'ip daddr . meta l4proto . th dport @emergency4 accept'
  'ip6 daddr . meta l4proto . th dport @emergency6 accept'
  'udp sport 68 udp dport 67 accept'
  'udp sport 546 udp dport 547 accept'
  'icmpv6 type { mld-listener-report, nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert, mld2-listener-report } accept'
  "$EGRESS_LOG_RULE"
)

url_port() { # URL env-file -> the port its client connects to (stdout): the one it names, else its scheme's (smtps 465;
  # smtp 25 for curl in alert.env, 587 for Nodemailer in the backends; https 443, http 80); nothing for another scheme.
  # The rest of the value is never printed.
  local u="${1#*://}" scheme=""
  case "$1" in *://*) scheme="${1%%://*}" ;; esac
  u="${u%%/*}"
  u="${u##*@}"
  case "$u" in \[*\]:*) u="${u##*\]:}" ;; \[* | *[!0-9]) u="" ;; *:*) u="${u##*:}" ;; *) u="" ;; esac
  if [ -z "$u" ]; then
    case "${scheme,,}" in
      smtps) u=465 ;;
      smtp) if [ "$2" = alert.env ]; then u=25; else u=587; fi ;;
      https) u=443 ;;
      http) u=80 ;;
    esac
  fi
  [[ "$u" =~ ^[0-9]+$ ]] && printf '%s' "$u"
  return 0
}

url_host() { # URL -> its host in lower case (stdout), without scheme, user info, port or path; compared, never printed
  local u="${1#*://}"
  u="${u%%/*}"
  u="${u##*@}"
  if [[ "$u" == \[*\]* ]]; then u="${u#\[}"; u="${u%%\]*}"; else u="${u%%:*}"; fi
  printf '%s' "${u,,}"
}

resolver_items() { # DNS_RESOLVERS value -> "<address> <port>" per item (stdout), read as the platform reads them
  # (an IPv4 address with an optional :port, an IPv6 address bare or as [address]:port; port 53 when none). Its output
  # is compared with the allow-list's lines, never printed.
  local item a p
  local -a items=()
  IFS=, read -ra items <<<"$1"
  for item in "${items[@]}"; do
    item="${item//[[:space:]]/}"
    [ -n "$item" ] || continue
    case "$item" in
      \[*\]:*) a="${item#\[}"; a="${a%%\]*}"; p="${item##*\]:}" ;;
      \[*\]) a="${item#\[}"; a="${a%\]}"; p=53 ;;
      *:*:*) a="$item"; p=53 ;;
      *:*) a="${item%%:*}"; p="${item#*:}" ;;
      *) a="$item"; p=53 ;;
    esac
    printf '%s %s\n' "${a,,}" "$p"
  done
}

firewall_egress() {
  local out parsed policy rules r want extra="" missing="" lines host port proto elems e addr tail comment
  local outside="" n=0 bare="" emergency="" key apt s ports state
  local -A kept=()
  lines="$(awk '!/^[[:space:]]*(#|$)/ { print $1, $2, $3 }' "$EGRESS_LIST" 2>/dev/null)"   # "host port proto"
  # velexis-egress loads the table and then writes the addresses it kept, both under an exclusive lock of
  # $EGRESS_STATE/.lock: holding that lock shared while reading both keeps a refresh from falling between the reads.
  if [ -f "$EGRESS_STATE/.lock" ] && exec 8<"$EGRESS_STATE/.lock"; then flock -s -w 30 8 || true; fi
  state="$(cat "$EGRESS_STATE/addresses" 2>/dev/null)"   # "<line's host> <address> <last seen>"
  while read -r key addr _; do [ -z "$addr" ] || kept["$key $addr"]=1; done <<<"$state"
  if ! have nft; then
    fail "nft is installed (package nftables): it holds the outbound allow-list"
  elif ! out="$(nft list table inet velexis_egress 2>&1)"; then
    fail "outgoing connections are denied by default (found: no nftables table inet velexis_egress, $(first_line "$out"); provision-vm.sh --steps egress)"
  else
    parsed="$(printf '%s\n' "$out" | bash "$EGRESS" parse)"
    policy="$(printf '%s\n' "$parsed" | awk '$1 == "policy" { print $2; exit }')"
    if [ "$policy" = drop ]; then
      pass "outgoing connections are denied by default (nftables table inet velexis_egress, chain output: policy drop)"
    else
      fail "outgoing connections are denied by default (found: chain output of inet velexis_egress with policy ${policy:-none})"
    fi
    rules="$(printf '%s\n' "$parsed" | sed -n 's/^rule //p')"
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      want=0
      for e in "${EGRESS_RULES[@]}"; do [ "$r" != "$e" ] || want=1; done
      [ "$want" = 1 ] || extra="$extra [$r]"
    done <<<"$rules"
    for e in "${EGRESS_RULES[@]}"; do
      [ "$e" != "$EGRESS_LOG_RULE" ] || continue
      grep -qxF -- "$e" <<<"$rules" || missing="$missing [$e]"
    done
    if [ -z "$extra" ] && [ -z "$missing" ]; then
      pass "the chain output holds only the allow-list's rules (loopback, replies, the address sets, DHCP, IPv6 neighbour discovery, the refusal log)"
    else
      [ -z "$extra" ] || fail "the chain output of inet velexis_egress allows more than the allow-list:$extra"
      [ -z "$missing" ] || fail "the chain output of inet velexis_egress lacks rules of the allow-list:$missing"
    fi
    if grep -qxF -- "$EGRESS_LOG_RULE" <<<"$rules"; then
      pass "refused outbound connections are logged (prefix VELEXIS-EGRESS-DENY, at most 10 a minute, with the user)"
    else
      fail "refused outbound connections are logged (no rule logs them with the prefix VELEXIS-EGRESS-DENY)"
    fi

    # Every address of the allow sets belongs to a line of the list: its comment names the line's host, the line has
    # its protocol and port, and the address is one the last refresh kept for that host. An address without a
    # comment, one the list does not have, or one added by hand under a listed host's comment, is named.
    elems="$(printf '%s\n' "$parsed" | awk '$1 == "elem" && ($2 == "allow4" || $2 == "allow6") { sub(/^elem [^ ]+ /, ""); print }')"
    while IFS= read -r e; do
      [ -n "$e" ] || continue
      n=$((n + 1))
      read -r addr _ proto _ port tail <<<"$e"
      comment=""
      case "$tail" in *'comment "'*) comment="${tail#*comment \"}"; comment="${comment%\"*}" ;; esac
      if [ -z "$comment" ]; then
        outside="$outside $addr $proto/$port (no comment),"
      elif ! grep -qxF -- "$comment $port $proto" <<<"$lines"; then
        outside="$outside $addr $proto/$port (comment \"$comment\"),"
      elif [ -z "${kept["$comment $addr"]+x}" ]; then
        outside="$outside $addr $proto/$port (comment \"$comment\", not an address the refresh kept for it),"
      fi
    done <<<"$elems"
    if [ -z "$outside" ]; then
      pass "every address of the sets allow4 and allow6 belongs to a line of $(show "$EGRESS_LIST") ($n addresses)"
    else
      fail "outbound destinations outside $(show "$EGRESS_LIST"):${outside%,}"
    fi
    # Every line has an address in the sets: one of those the last refresh kept for its host.
    while read -r host port proto; do
      [ -n "$host" ] || continue
      s=0
      while read -r key addr _; do
        [ "$key" = "$host" ] || continue
        if printf '%s\n' "$elems" | awk -v a="$addr" -v p="$proto" -v o="$port" '$1 == a && $3 == p && $5 == o { f = 1 } END { exit !f }'; then
          s=1
          break
        fi
      done <<<"$state"
      [ "$s" = 1 ] || bare="$bare $host $port/$proto,"
    done <<<"$lines"
    if [ -z "$bare" ]; then
      pass "every line of $(show "$EGRESS_LIST") has an address in the sets"
    else
      fail "lines of $(show "$EGRESS_LIST") without an address in the sets (lookups failing, or SMTP or the backup bucket not configured yet):${bare%,}"
    fi
    emergency="$(printf '%s\n' "$parsed" | awk '$1 == "elem" && ($2 == "emergency4" || $2 == "emergency6") { sub(/^elem [^ ]+ /, ""); printf " %s,", $0 }')"
    if [ -z "$emergency" ]; then
      pass "no emergency opening (the sets emergency4 and emergency6 are empty)"
    else
      fail "an emergency opening is in place (docs/mvp/runbooks/outbound-allow-list.md §4):${emergency%,}"
    fi
  fi
  exec 8<&-   # the shared lock of the refresh (above)

  # An env: line allows its URL's host on the line's port only: a URL with another port, named or its scheme's, would
  # be refused.
  ports=""
  while read -r host port proto; do
    case "$host" in env:*:*) ;; *) continue ;; esac
    key="${host#env:}"
    [ -f "$ETC/${key%%:*}" ] || continue
    env_value "$ETC/${key%%:*}" "${key#*:}"
    s="$(url_port "$ENV_VALUE" "${key%%:*}")"
    ENV_VALUE=""
    if [ -n "$s" ] && ! grep -qxF -- "$host $s $proto" <<<"$lines"; then ports="$ports $host (its line: $port/$proto),"; fi
  done <<<"$lines"
  if [ -z "$ports" ]; then
    pass "the URLs of the allow-list's env: lines use the ports their lines allow"
  else
    fail "URLs whose port no line of the allow-list allows (their connections would be refused; change the line by pull request):${ports%,}"
  fi
  # The resolvers of the platform's custom domain verification (DNS_RESOLVERS of platform-backend.env, PADR-0004 item
  # 3; its default when empty) are literal lines of the list: each item needs a udp and a tcp line on its port.
  ports=""
  if [ -f "$ETC/platform-backend.env" ]; then
    env_value "$ETC/platform-backend.env" DNS_RESOLVERS
    s=0
    while read -r addr port; do
      s=$((s + 1))
      for proto in udp tcp; do
        grep -qxF -- "$addr $port $proto" <<<"$lines" || ports="$ports item $s ($proto),"
      done
    done < <(resolver_items "${ENV_VALUE:-1.1.1.1,8.8.8.8}")
    ENV_VALUE=""
    if [ -z "$ports" ]; then
      pass "every resolver of DNS_RESOLVERS in platform-backend.env has its udp and tcp lines ($s resolvers)"
    else
      fail "resolvers of DNS_RESOLVERS in platform-backend.env without a line of the allow-list (custom domain checks would be refused; change the lines by pull request):${ports%,}"
    fi
  fi
  # AMADEUS_BASE_URL_TEST and _LIVE of both backends: empty is the official host, which has its line; another host
  # needs its own (loopback, the stub, is always allowed).
  ports=""
  for e in platform-backend.env ota-backend.env; do
    [ -f "$ETC/$e" ] || continue
    for key in AMADEUS_BASE_URL_TEST AMADEUS_BASE_URL_LIVE; do
      env_value "$ETC/$e" "$key"
      if [ -n "$ENV_VALUE" ]; then
        host="$(url_host "$ENV_VALUE")"
        port="$(url_port "$ENV_VALUE" "$e")"
        case "$host" in
          127.0.0.1 | localhost | ::1) ;;
          *) grep -qxF -- "$host ${port:-443} tcp" <<<"$lines" || ports="$ports $key of $e," ;;
        esac
      fi
      ENV_VALUE=""
    done
  done
  if [ -z "$ports" ]; then
    pass "the Amadeus base URLs of both backends are the official hosts or have their own lines"
  else
    fail "Amadeus base URLs whose host and port no line of the allow-list has (their calls would be refused; add the host by pull request):${ports%,}"
  fi
  if [ ! -f "$EGRESS_LIST" ]; then
    fail "$(show "$EGRESS_LIST") exists (provision-vm.sh --steps egress)"
  elif cmp -s "$EGRESS_LIST" "$DEPLOY_DIR/egress/allowed-hosts.conf"; then
    pass "$(show "$EGRESS_LIST") is this deploy folder's egress/allowed-hosts.conf"
  else
    fail "$(show "$EGRESS_LIST") is this deploy folder's egress/allowed-hosts.conf (it differs: provision-vm.sh --steps egress)"
  fi
  expect_mode "$SBIN/velexis-egress" "root:root 755"
  if [ -f "$SBIN/velexis-egress" ] && ! cmp -s "$SBIN/velexis-egress" "$EGRESS"; then
    fail "$(show "$SBIN")/velexis-egress is this deploy folder's scripts/egress.sh (it differs: provision-vm.sh --steps egress)"
  fi
  # unattended-upgrades and apt-get update reach every apt source of the VM only if the list allows it.
  missing=""
  apt="$(VELEXIS_ROOT="$R" bash "$EGRESS" apt-hosts 2>/dev/null)"
  while read -r host port; do
    [ -n "$host" ] || continue
    grep -qxF -- "$host $port tcp" <<<"$lines" || missing="$missing $host:$port"
  done <<<"$apt"
  apt="$(printf '%s\n' "$apt" | awk 'NF { printf "%s%s:%s", sep, $1, $2; sep = " " }')"
  if [ -z "$missing" ]; then
    pass "every apt source of the VM is on the allow-list (${apt:-none})"
  else
    fail "apt sources outside the allow-list (unattended-upgrades cannot reach them):$missing"
  fi
  if [ -e "$EGRESS_STATE/failing" ]; then
    fail "the refresh of the allow-list has been failing since $(head -c 20 "$EGRESS_STATE/failing") (journalctl -u velexis-egress-refresh)"
  else
    pass "the last refresh of the allow-list did not fail"
  fi
  s="$(unit_state velexis-egress-refresh.timer)"
  if [ "$s" = "active enabled" ]; then
    pass "velexis-egress-refresh.timer is active and enabled (the allow-list's addresses every 2 minutes)"
  else
    fail "velexis-egress-refresh.timer is active and enabled (found: $s; systemctl enable --now velexis-egress-refresh.timer)"
  fi
  s="$(systemctl is-enabled velexis-egress-refresh.service 2>/dev/null)"
  if [ "$s" = enabled ]; then
    pass "velexis-egress-refresh.service is enabled (loads the allow-list at boot)"
  else
    fail "velexis-egress-refresh.service is enabled (found: ${s:-unknown}; it loads the allow-list at boot)"
  fi
}

printf 'check-vm.sh on %s (%s)\n' "$(hostname 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for g in $SELECTED; do
  printf '\n== %s\n' "$g"
  "group_$g"
done
printf '\ncheck-vm: %d PASS, %d FAIL\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
