#!/usr/bin/env bash
# =====================================================================================================
# provision-vm.sh — turn a blank Ubuntu 24.04 LTS VM into the Velexis host (ADR-0007, no Docker).
#
# Finalised by task X-020 (docs/mvp/plans/foundation-tasks.md). Read docs/mvp/deployment-single-vm.md §3 first.
# Idempotent: a re-run never overwrites an existing secret, key file, env file or /etc/velexis/.provision-secrets;
# it re-applies packages, configuration, units and root-owned scripts, and restarts PostgreSQL, Redis, Caddy and
# journald only when their configuration changed (or they are not running); the packages step's apt-get upgrade
# restarts whatever it upgrades, so production re-runs name their --steps. Check the result with check-vm.sh.
#
# Usage (as root, on the VM, from a copy of the repository's deploy/ folder; later runs from the deploy/ folder of
# the active release or a newer one, never an older copy: it re-installs units and root-owned scripts):
#   scp -r deploy/ admin@vm:/tmp/velexis-deploy
#   sudo DEPLOY_SSH_PUBKEY_FILE=/tmp/deploy.pub ADMIN_USER=ubuntu bash /tmp/velexis-deploy/scripts/provision-vm.sh
#   sudo bash /tmp/velexis-deploy/scripts/provision-vm.sh --steps scripts,caddyconf  # re-run selected steps only
#   sudo bash /tmp/velexis-deploy/scripts/check-vm.sh                               # one PASS or FAIL per item
#   sudo NEW_MASTER_KEY=v2 bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps keys  # add a master key
#   sudo ADMIN_USER=ubuntu ADMIN_MFA=fido2 bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps ssh
#                                                         # the SSH second factor, once it is enrolled (task X-037)
#
# Steps: packages harden users node postgres redis caddy keys database envfiles scripts caddyconf summary, and by name
# only: ssh, the SSH part of harden alone (harden runs it too).
#
# SSH second factor (ADR-0027 rows 8.4.2 and 8.6, docs/mvp/runbooks/ssh-access.md): the step ssh writes
# /etc/ssh/sshd_config.d/01-velexis-mfa.conf with one Match block for ADMIN_USER and one for DEPLOY_USER. ADMIN_MFA=fido2
# (the default) accepts only FIDO2 keys (sk-ssh-ed25519) with user verification (verify-required: PIN and touch);
# ADMIN_MFA=totp asks for the key and then a TOTP code (libpam-google-authenticator). The deploy user gets public key
# only, no TTY and no forwarding. The file is written only while ADMIN_USER has that factor enrolled, and only after
# sshd -t and sshd -T -C accept a copy of the whole configuration with it; otherwise sshd stays as it is and the
# enrolment steps are printed. sshd is then reloaded, which keeps every open session.
#
# Lockout guard (lead decision (13k) of 2026-11-10, docs/mvp/runbooks/ssh-access.md §1): the SSH changes of the steps
# harden and ssh never lock out the person who runs them through sudo (SUDO_USER). A run with harden or ssh refuses
# before any step, changing nothing and exiting 1, when that user is not one of the two users the new AllowUsers lets in
# (ADMIN_USER, DEPLOY_USER). The step ssh also refuses, before it writes anything, when the second factor it applies
# would ask that user (sshd -T -C user=<them> of a copy of the new configuration) for a FIDO2 key or a TOTP code they
# have not enrolled. A root session without sudo, such as the provider's console, has no such user and is not checked.
# SSH source (lead decision (15d) of 2026-11-11): when SSH_ALLOW_FROM is a range (CIDR, or one address; IPv4 or IPv6),
# which the step harden writes into the firewall, the same run also refuses before any step, changing nothing and
# exiting 1, when the SSH login behind it comes from an address outside that range: SSH_CONNECTION of the session
# (root over SSH, or sudo --preserve-env=SSH_CONNECTION), else the remote host that `who -m` names for this terminal
# (sudo drops SSH_CONNECTION). A session without an SSH login (the provider's console, a local terminal, a root session
# without a terminal) is let through; a run through sudo without a terminal and without SSH_CONNECTION, or with a
# remote host that is no address, is refused, because it cannot tell. A malformed SSH_ALLOW_FROM is refused too.
#
# Master keys (ADR-0010): the first run creates master-v1.key (KEK local:v1). NEW_MASTER_KEY=v<N> with the step keys
# adds master-v<N>.key for a KEK rotation (docs/mvp/runbooks/master-key-rotation.md): 32 random bytes, generated
# once, installed as identical 0400 copies in both zone folders. It refuses a version below the highest master key
# already there (a version is never reused) and never replaces a key file, so a re-run with the same value changes
# nothing. A master key removed from both folders after a rotation is not created again.
#
# Secrets: generated once into /etc/velexis/.provision-secrets (root 0600) and written into the env files and the
# Redis configuration by bash itself, never through a command line (ps) or a log. The database passwords reach
# psql on stdin, in a session that logs no statement, so PostgreSQL's log and pg_stat_statements never hold them.
# The script prints names and paths only; its own messages are also appended to /var/log/velexis/provision.log.
#
# Users (ADR-0026, task X-033): one system user per trust zone (velexis-platform, velexis-ota, velexis-portal,
# velexis-platform-admin, velexis-ota-admin) and the group velexis, which only lets them read releases. Keys live in
# one folder per backend zone; env files are root:root 0600 and read by systemd only.
#
# Tests only: VELEXIS_ROOT=<absolute folder> moves every Velexis path (/etc/velexis, /srv/velexis, /var/lib/velexis,
# /var/log/velexis, /var/backups/velexis, /usr/local/sbin and the deploy sudoers file) and /etc/ssh and /etc/pam.d/sshd
# under that folder, and allows only the steps users, keys, envfiles and ssh (deploy/systemd/test/units-smoke.sh,
# deploy/scripts/test/check-vm.test.sh, which also puts fake sshd and systemctl first on PATH for the step ssh).
# The system users are real.
# =====================================================================================================
set -euo pipefail

# ---- Placeholders: override through the environment ---------------------------------------------------
: "${ADMIN_USER:=ubuntu}"                 # existing sudo user of the cloud image with your SSH key; keeps SSH access
: "${ADMIN_MFA:=fido2}"                   # the admin's SSH second factor: fido2 (security key) or totp (key and code)
: "${DEPLOY_USER:=deploy}"                # GitHub Actions uploads releases and runs velexis-deploy as this user
: "${DEPLOY_SSH_PUBKEY_FILE:=}"           # public half of the GitHub Actions deploy key (required on first run)
: "${SSH_ALLOW_FROM:=any}"                # CIDR (IPv4 or IPv6) for SSH; "any" because GitHub-hosted runners have changing IPs
: "${DB_NAME:=velexis}"
: "${NODE_MAJOR:=22}"
: "${PNPM_VERSION:=9.15.9}"
: "${PG_MAJOR:=16}"
: "${REDIS_PIN:=6:7.4*}"                  # packages.redis.io version string of Redis 7.4
: "${CADDY_PIN:=2.8*}"
: "${VELEXIS_ROOT:=}"                     # tests only, see the header; empty on the VM
: "${NEW_MASTER_KEY:=}"                   # v<N>: the step keys adds master-v<N>.key (KEK rotation, see the header)

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETC="$VELEXIS_ROOT/etc/velexis"
SRV="$VELEXIS_ROOT/srv/velexis"
LIB="$VELEXIS_ROOT/var/lib/velexis"
LOGS="$VELEXIS_ROOT/var/log/velexis"
BACKUPS="$VELEXIS_ROOT/var/backups/velexis"
SBIN="$VELEXIS_ROOT/usr/local/sbin"
SUDOERS_DIR="$VELEXIS_ROOT/etc/sudoers.d"
SECRETS_FILE="$ETC/.provision-secrets"   # generated passwords, root 0600, reused on every run
SSHD_CONFIG="$VELEXIS_ROOT/etc/ssh/sshd_config"
SSHD_DROPINS="$VELEXIS_ROOT/etc/ssh/sshd_config.d"
SSHD_MFA="$SSHD_DROPINS/01-velexis-mfa.conf"   # the admin's second factor and the deploy user's limits (X-037)
PAM_SSHD="$VELEXIS_ROOT/etc/pam.d/sshd"
SSH_TMP=""                               # the private folder of the step ssh, removed when it ends (and on exit)
MFA_PENDING=""                           # why the step ssh did not apply the second factor; repeated by the summary
RUNNER=""                                # who runs this through sudo (SUDO_USER); the lockout guard keeps their SSH access
RUNNER_REASON=""                         # the factor the new SSH settings would ask of RUNNER, and why they lack it
SSH_SOURCE=""                            # the client address of the SSH login behind this run (ssh_source_address)
LOG_FILE=""                              # $LOGS/provision.log once the folder exists
# The generated values: names in .provision-secrets and @@NAME@@ placeholders in deploy/env and deploy/redis.
SECRET_NAMES="MIGRATOR_DB_PASSWORD PROVISIONER_DB_PASSWORD PLATFORM_DB_PASSWORD OTA_DB_PASSWORD REDIS_PASSWORD EDGE_SECRET OTA_ADMIN_SERVICE_KEY PLATFORM_BFF_KEY"

# One system user per trust zone (ADR-0026). An API and its worker share their zone's user.
PLATFORM_USER=velexis-platform             # velexis-platform-api, velexis-platform-worker; keys/platform
OTA_USER=velexis-ota                       # velexis-ota-api, velexis-ota-worker; keys/ota and the storage folder
ZONE_USERS="$PLATFORM_USER $OTA_USER velexis-portal velexis-platform-admin velexis-ota-admin"
RELEASE_GROUP=velexis                      # its only members are the zone users; it only grants reading releases
ALL_STEPS="packages harden users node postgres redis caddy keys database envfiles scripts caddyconf summary"
NAMED_STEPS="ssh"                          # run only when named (--steps ssh); harden runs the SSH part itself
STEPS="$ALL_STEPS"

to_log() { [ -z "$LOG_FILE" ] || printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"; }
log() { printf '\n==> [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; to_log "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; to_log "WARNING: $*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; to_log "ERROR: $*"; exit 1; }
gen_secret() { openssl rand -hex 24; }   # hex: safe inside URLs and env files
# confold keeps files we changed that a package also ships (/etc/redis/redis.conf, /etc/caddy/Caddyfile) on upgrades.
APT_OPTS=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install "${APT_OPTS[@]}" --no-install-recommends "$@"; }
is_active() { systemctl is-active --quiet "$1"; }

# Installs src as dest (mode, owner:group) unless dest already has that content, owner and mode. Returns 0 when it
# changed dest and 1 when dest was up to date, so callers restart a service only after a change. Use it in `if`.
# A failed install stops the script: inside `if`, set -e would not, and the failure would read as "up to date".
install_changed() { # mode owner:group src dest
  local mode="$1" owner="$2" src="$3" dest="$4"
  if [ -f "$dest" ] && cmp -s "$src" "$dest" && [ "$(stat -c '%U:%G %a' "$dest")" = "$owner ${mode#0}" ]; then
    return 1
  fi
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dest" || die "could not install $dest"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --steps) [ $# -ge 2 ] || die "--steps needs a comma-separated list"; STEPS="${2//,/ }"; shift 2 ;;
    -h|--help) sed -n '2,/^# =====/p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
for step in $STEPS; do
  case " $ALL_STEPS $NAMED_STEPS " in *" $step "*) ;; *) die "unknown step: $step (steps: $ALL_STEPS $NAMED_STEPS)" ;; esac
done
if [ -n "$NEW_MASTER_KEY" ]; then
  [[ "$NEW_MASTER_KEY" =~ ^v[1-9][0-9]{0,8}$ ]] || die "NEW_MASTER_KEY must be v<N> (N >= 1, no leading zeros), for example v2"
  case " $STEPS " in *" keys "*) ;; *) die "NEW_MASTER_KEY needs the step keys (--steps keys)" ;; esac
fi
case "$ADMIN_MFA" in fido2 | totp) ;; *) die "ADMIN_MFA must be fido2 or totp (docs/mvp/runbooks/ssh-access.md)" ;; esac
# Plain user names only: they become sshd Match patterns and AllowUsers entries.
for u in "$ADMIN_USER" "$DEPLOY_USER"; do
  [[ "$u" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "ADMIN_USER and DEPLOY_USER must be plain user names (found: $u)"
done
[ "$ADMIN_USER" != "$DEPLOY_USER" ] || die "ADMIN_USER and DEPLOY_USER must be different users"

[ "$(id -u)" -eq 0 ] || die "run as root"
# The person behind sudo; nobody for a root session without sudo (the provider's console) or root's own sudo.
case "${SUDO_USER:-root}" in root) RUNNER="" ;; *) RUNNER="$SUDO_USER" ;; esac
if [ -n "$VELEXIS_ROOT" ]; then
  case "$VELEXIS_ROOT" in /?*) ;; *) die "VELEXIS_ROOT must be an absolute path other than /" ;; esac
  [ -d "$VELEXIS_ROOT" ] || die "VELEXIS_ROOT $VELEXIS_ROOT is not a folder"
  for step in $STEPS; do
    case "$step" in
      users | keys | envfiles | ssh) ;;
      *) die "with VELEXIS_ROOT only the steps users, keys, envfiles and ssh run, not $step" ;;
    esac
  done
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  die "Ubuntu 24.04 LTS expected, found ${PRETTY_NAME:-unknown}"
fi
CODENAME="$VERSION_CODENAME"

# The run log: the script's own messages (steps, warnings, errors), never a value. Rotated by deploy/logrotate.
install -d -m 0750 -o root -g adm "$LOGS"
[ -e "$LOGS/provision.log" ] || install -m 0640 -o root -g adm /dev/null "$LOGS/provision.log"
LOG_FILE="$LOGS/provision.log"
to_log "provision-vm.sh started by ${SUDO_USER:-root}: steps $STEPS, deploy folder $DEPLOY_DIR"
on_exit() {
  local rc=$?
  [ -z "$SSH_TMP" ] || rm -rf "$SSH_TMP"
  [ "$rc" -eq 0 ] || to_log "provision-vm.sh stopped with exit code $rc"
}
trap on_exit EXIT

# ---- packages: base tools and vendor apt repositories ------------------------------------------------
step_packages() {
  log "Base packages and vendor repositories"
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get upgrade "${APT_OPTS[@]}"
  # libpam-google-authenticator: the TOTP second factor of ADMIN_MFA=totp (its PAM module stays unused with fido2).
  apt_install ca-certificates curl gnupg lsb-release jq rsync zstd openssl age rclone \
    ufw fail2ban unattended-upgrades auditd aide aide-common acl logrotate chrony iproute2 libpam-google-authenticator
  install -d -m 0755 /etc/apt/keyrings

  # Node.js (NodeSource)
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  # PostgreSQL (PGDG)
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor --yes -o /etc/apt/keyrings/pgdg.gpg
  echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  # Redis (packages.redis.io), pinned to 7.4
  curl -fsSL https://packages.redis.io/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/redis.gpg
  echo "deb [signed-by=/etc/apt/keyrings/redis.gpg] https://packages.redis.io/deb ${CODENAME} main" \
    > /etc/apt/sources.list.d/redis.list
  printf 'Package: redis redis-server redis-tools\nPin: version %s\nPin-Priority: 1001\n' "$REDIS_PIN" \
    > /etc/apt/preferences.d/velexis-redis
  # Caddy (official repository), pinned to 2.8
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/caddy.gpg
  echo "deb [signed-by=/etc/apt/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy.list
  printf 'Package: caddy\nPin: version %s\nPin-Priority: 1001\n' "$CADDY_PIN" > /etc/apt/preferences.d/velexis-caddy
  apt-get update -y
}

# ---- harden: OS settings, SSH, firewall, patches, audit, file integrity --------------------------------
# The checklist is deployment-single-vm.md §2; check-vm.sh checks the result.
admin_keeps_access() { # the sshd rules below allow only ADMIN_USER and DEPLOY_USER, by key: refuse to lock everyone out
  local home
  [ "$ADMIN_USER" != root ] || die "ADMIN_USER must not be root: the SSH rules below forbid root logins"
  id -u "$ADMIN_USER" >/dev/null 2>&1 \
    || die "ADMIN_USER=$ADMIN_USER does not exist: create your sudo user with your SSH key first (deployment-single-vm.md §3)"
  home="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
  [ -s "$home/.ssh/authorized_keys" ] \
    || die "$home/.ssh/authorized_keys is empty: ADMIN_USER=$ADMIN_USER could not log in with a key after this step"
}

step_harden() {
  log "OS hardening"
  admin_keeps_access
  timedatectl set-timezone UTC
  systemctl enable --now chrony

  # No swap: card data held in memory must never be paged to disk (ADR-0011).
  swapoff -a
  sed -i -E '/^[^#].*\sswap\s/ s/^/#/' /etc/fstab

  # No core dumps (same reason). apport.service (package apport-core-dump-handler of the cloud image) writes its own
  # kernel.core_pattern at every boot, after systemd-sysctl, so it is stopped and masked before the sysctl file below.
  if [ -e /usr/lib/systemd/system/apport.service ] || [ -e /etc/systemd/system/apport.service ]; then
    systemctl stop apport.service >/dev/null 2>&1 || true
    systemctl mask apport.service >/dev/null
  fi
  [ ! -f /etc/default/apport ] || sed -i 's/^enabled=1/enabled=0/' /etc/default/apport

  cat > /etc/sysctl.d/90-velexis.conf <<'EOF'
# Velexis host settings (deploy/scripts/provision-vm.sh)
vm.overcommit_memory = 1
vm.swappiness = 1
fs.suid_dumpable = 0
kernel.core_pattern = |/bin/false
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
net.core.somaxconn = 4096
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
EOF
  sysctl --system >/dev/null
  # Redis recommends transparent huge pages off.
  echo 'w /sys/kernel/mm/transparent_hugepage/enabled - - - - never' > /etc/tmpfiles.d/velexis-thp.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/velexis-thp.conf || true

  # SSH: keys only, no root, only the admin and deploy users, and the admin's second factor (the step ssh below).
  step_ssh

  # Firewall: 22, 80, 443 (TCP) and 443/udp (HTTP/3). Everything else closed.
  ufw default deny incoming
  ufw default allow outgoing
  if [ "$SSH_ALLOW_FROM" = "any" ]; then ufw limit 22/tcp; else ufw allow from "$SSH_ALLOW_FROM" to any port 22 proto tcp; fi
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable

  cat > /etc/fail2ban/jail.d/velexis.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --now fail2ban
  systemctl restart fail2ban

  # Security patches daily; no automatic reboot (the developer reboots after reading the notice).
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

  # auditd: watch configuration, keys, units and privileged files (PCI controls, ADR-0011).
  cat > /etc/audit/rules.d/velexis.rules <<'EOF'
-w /etc/velexis/ -p wa -k velexis-config
-w /etc/velexis/keys/ -p wa -k velexis-keys
-w /etc/caddy/ -p wa -k caddy-config
-w /etc/systemd/system/ -p wa -k systemd-units
-w /usr/local/sbin/ -p wa -k velexis-scripts
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers
-w /etc/ssh/sshd_config.d/ -p wa -k sshd
EOF
  augenrules --load >/dev/null || warn "augenrules failed; check auditd"
  systemctl enable --now auditd

  # AIDE file integrity: exclude data and release folders that change by design.
  cat > /etc/aide/aide.conf.d/90_velexis <<'EOF'
!/srv/velexis/releases
!/srv/velexis/incoming
!/var/lib/velexis
!/var/backups/velexis
!/var/lib/postgresql
!/var/lib/redis
!/var/lib/caddy
!/var/log
!/var/cache/velexis
EOF
  if [ ! -f /var/lib/aide/aide.db ]; then
    log "Initialising the AIDE database (takes a few minutes)"
    aideinit -y -f >/dev/null || warn "aideinit failed; run it manually"
  fi
  # AIDE's daily check (PCI DSS 11.5.2): the package aide-common's timer, enabled by the package; a re-run repairs a
  # disabled one. check-vm.sh checks it (lead decision (13j) of 2026-11-10).
  systemctl enable --now dailyaidecheck.timer >/dev/null 2>&1 \
    || warn "could not enable dailyaidecheck.timer (package aide-common); AIDE's daily check does not run"

  if install_changed 0644 root:root "$DEPLOY_DIR/journald/velexis.conf" /etc/systemd/journald.conf.d/velexis.conf; then
    systemctl restart systemd-journald
  fi
  install -m 0644 -o root -g root "$DEPLOY_DIR/logrotate/velexis" /etc/logrotate.d/velexis
}

# ---- ssh: sshd drop-ins and the admin's second factor (inside harden; --steps ssh runs it alone) -----------------
# sshd keeps the FIRST value it reads for a keyword, and reads sshd_config.d/*.conf in name order before the rest of
# sshd_config: 00- sorts before cloud-init's 50-cloud-init.conf, which sets PasswordAuthentication yes on some
# providers' images. A Match block ends with its file, and a Match value wins over the global one; among Match
# blocks that apply, the first wins again, so 01-velexis-mfa.conf comes before any other file's Match block.
ssh_base_conf() { # -> 00-velexis.conf (X-020): keys only, no root, only the admin and deploy users
  cat <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers ${ADMIN_USER} ${DEPLOY_USER}
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
}

ssh_mfa_conf() { # -> 01-velexis-mfa.conf (X-037, ADR-0027 rows 8.4.2 and 8.6) for ADMIN_MFA
  cat <<EOF
# Velexis (deploy/scripts/provision-vm.sh, task X-037): how ${ADMIN_USER} and ${DEPLOY_USER} log in. ADMIN_MFA=${ADMIN_MFA}.
# Written only while ${ADMIN_USER} has that second factor enrolled: docs/mvp/runbooks/ssh-access.md.
EOF
  if [ "$ADMIN_MFA" = totp ]; then
    cat <<EOF
UsePAM yes

# The key, then a TOTP code through PAM (pam_google_authenticator in /etc/pam.d/sshd); never a password.
Match User ${ADMIN_USER}
  AuthenticationMethods publickey,keyboard-interactive:pam
  KbdInteractiveAuthentication yes
EOF
  else
    cat <<EOF

# Only FIDO2 keys (sk-ssh-ed25519), each signature with a touch and user verification (the key's PIN).
Match User ${ADMIN_USER}
  AuthenticationMethods publickey
  PubkeyAcceptedAlgorithms sk-ssh-ed25519@openssh.com
  PubkeyAuthOptions touch-required verify-required
  KbdInteractiveAuthentication no
EOF
  fi
  cat <<EOF
  PasswordAuthentication no
  AuthorizedKeysFile .ssh/authorized_keys

# A system account used only by the Deploy workflow (rsync and one sudo command): public key only, no TTY, no forwarding.
Match User ${DEPLOY_USER}
  AuthenticationMethods publickey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  AuthorizedKeysFile .ssh/authorized_keys
  PermitTTY no
  DisableForwarding yes
  AllowTcpForwarding no
  AllowAgentForwarding no
  AllowStreamLocalForwarding no
  X11Forwarding no
  PermitTunnel no
  PermitUserRC no
EOF
}

# The base64 start of every sk-ssh-ed25519 public key (the key type inside the key blob).
SK_ED25519_B64='AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t'
fido2_key_count() { # authorized_keys -> how many lines are sk-ssh-ed25519 keys with the option verify-required
  # Options are read up to the first blank, so an option with a quoted blank hides its key: refused, never accepted.
  grep -cE "^[[:space:]]*([^[:space:]#]+,)?verify-required(,[^[:space:]]+)?[[:space:]]+sk-ssh-ed25519@openssh\.com[[:space:]]+${SK_ED25519_B64}[A-Za-z0-9+/]*=*([[:space:]]|\$)" \
    "$1" 2>/dev/null || true
}

totp_secret_ok() { # home [user] -> 0 when ~/.google_authenticator is a time-based secret only the user (the admin) reads
  local f="$1/.google_authenticator" user="${2:-$ADMIN_USER}" first="" got #  else MFA_REASON says why
  if [ ! -f "$f" ] || [ -L "$f" ]; then MFA_REASON="$f does not exist"; return 1; fi
  got="$(stat -c '%U %a' "$f")"
  case "$got" in
    "$user 400" | "$user 600") ;;
    *) MFA_REASON="$f must belong to $user with mode 0400 or 0600 (found: $got)"; return 1 ;;
  esac
  # The secret is read into memory only to recognise it, and never printed.
  IFS= read -r first <"$f" || true
  if [[ ! "$first" =~ ^[A-Z2-7]{16,}$ ]]; then first=""; MFA_REASON="$f has no TOTP secret on its first line"; return 1; fi
  first=""
  grep -qx '" TOTP_AUTH' "$f" || { MFA_REASON="$f is not time-based (create it with google-authenticator -t)"; return 1; }
}

pam_totp_module() { # -> 0 when pam_google_authenticator.so is installed (package libpam-google-authenticator)
  local m
  for m in "$VELEXIS_ROOT"/usr/lib/*/security/pam_google_authenticator.so "$VELEXIS_ROOT"/lib/*/security/pam_google_authenticator.so; do
    [ -e "$m" ] && return 0
  done
  return 1
}

mfa_enrolled() { # admin home -> 0 when the factor of ADMIN_MFA is enrolled; else MFA_REASON says why
  local n
  if [ "$ADMIN_MFA" = fido2 ]; then
    n="$(fido2_key_count "$1/.ssh/authorized_keys")"
    [ "${n:-0}" -gt 0 ] && return 0
    MFA_REASON="$1/.ssh/authorized_keys holds no FIDO2 key with user verification (a line 'verify-required sk-ssh-ed25519@openssh.com AAAA...')"
    return 1
  fi
  if ! pam_totp_module; then
    MFA_REASON="the PAM module pam_google_authenticator.so is not installed (apt-get install libpam-google-authenticator; the step packages installs it)"
    return 1
  fi
  totp_secret_ok "$1"
}

PAM_TOTP_LINE='auth required pam_google_authenticator.so'
pam_totp_conf() { # -> /etc/pam.d/sshd with '@include common-auth' (the password) replaced by the TOTP module
  local have=0
  ! grep -qxF "$PAM_TOTP_LINE" "$PAM_SSHD" || have=1
  awk -v want="$PAM_TOTP_LINE" -v have="$have" '
    /^[[:space:]]*@include[[:space:]]+common-auth[[:space:]]*$/ {
      if (!have) {
        print "# Velexis (deploy/scripts/provision-vm.sh, X-037): after the key, the admin types a TOTP code, never a password."
        print want
        have = 1
      }
      print "#" $0
      next
    }
    { print }
    END { if (!have) exit 3 }' "$PAM_SSHD"
}

mfa_files() { # folder -> writes 01-velexis-mfa.conf there, and for totp pam.d-sshd; else MFA_REASON says why
  ssh_mfa_conf >"$1/01-velexis-mfa.conf"
  [ "$ADMIN_MFA" = totp ] || return 0
  if [ ! -f "$PAM_SSHD" ]; then MFA_REASON="$PAM_SSHD is missing"; return 1; fi
  if ! pam_totp_conf >"$1/pam.d-sshd"; then
    MFA_REASON="$PAM_SSHD has no '@include common-auth' line to replace with the TOTP module (docs/mvp/runbooks/ssh-access.md)"
    return 1
  fi
  # nullok, or a second module line, would let a login without a code through.
  if awk -v want="$PAM_TOTP_LINE" '/^[[:space:]]*#/ { next } /pam_google_authenticator/ && $0 != want { bad = 1 } END { exit !bad }' \
    "$1/pam.d-sshd"; then
    MFA_REASON="$PAM_SSHD has another pam_google_authenticator line (nullok would let a login without a code through): remove it"
    return 1
  fi
}

ssh_mirror() { # folder -> a copy of the whole sshd configuration with the candidate files, for sshd -t and sshd -T
  local dir="$1" text f
  install -d -m 0700 "$dir/sshd_config.d"
  text="$(cat "$SSHD_CONFIG"; printf x)"
  text="${text%x}"
  text="${text//"$SSHD_DROPINS/"/"$dir/sshd_config.d/"}"   # the Include line; HostKey and the rest stay as they are
  printf '%s' "$text" >"$dir/sshd_config"
  for f in "$SSHD_DROPINS"/*.conf; do
    if [ -f "$f" ] && [ "$(basename "$f")" != 90-velexis.conf ]; then cp "$f" "$dir/sshd_config.d/"; fi
  done
  cp "$SSH_TMP"/new/*.conf "$dir/sshd_config.d/"
}

expect_sshd() { # config user "keyword value"... -> 0 when sshd -T -C user=<user> shows each value; else MFA_REASON
  local cfg="$1" user="$2" out kv got
  shift 2
  if ! out="$(sshd -T -f "$cfg" -C "user=$user" 2>&1)"; then
    MFA_REASON="sshd -T -C user=$user fails: $(printf '%s\n' "$out" | head -n 1)"
    return 1
  fi
  for kv in "$@"; do
    got="$(printf '%s\n' "$out" | awk -v k="${kv%% *}" '$1 == k && !done { sub(/^[^ ]+ /, ""); print; done = 1 }')"
    if [ "$got" != "${kv#* }" ]; then
      MFA_REASON="for $user, sshd -T shows ${kv%% *} ${got:-(unset)}, not ${kv#* } (another file in $SSHD_DROPINS wins?)"
      return 1
    fi
  done
  if ! printf '%s\n' "$out" | grep -qx "allowusers $user"; then
    MFA_REASON="sshd -T does not allow $user (AllowUsers)"
    return 1
  fi
}

mfa_effective_ok() { # mirror config -> 0 when sshd -T shows the second factor and the deploy limits; else MFA_REASON
  local cfg="$1"
  if [ "$ADMIN_MFA" = totp ]; then
    expect_sshd "$cfg" "$ADMIN_USER" "authenticationmethods publickey,keyboard-interactive:pam" \
      "kbdinteractiveauthentication yes" "usepam yes" "passwordauthentication no" \
      "authorizedkeysfile .ssh/authorized_keys" || return 1
  else
    expect_sshd "$cfg" "$ADMIN_USER" "authenticationmethods publickey" \
      "pubkeyacceptedalgorithms sk-ssh-ed25519@openssh.com" "pubkeyauthoptions touch-required verify-required" \
      "kbdinteractiveauthentication no" "passwordauthentication no" "authorizedkeysfile .ssh/authorized_keys" || return 1
  fi
  expect_sshd "$cfg" "$DEPLOY_USER" "authenticationmethods publickey" "passwordauthentication no" \
    "kbdinteractiveauthentication no" "authorizedkeysfile .ssh/authorized_keys" "permittty no" "disableforwarding yes"
}

# ---- the lockout guard (lead decision (13k) of 2026-11-10; see the header) -----------------------------------------
runner_in_allowusers() { # -> dies, before any step, when RUNNER is not one of the users the new AllowUsers lets in
  if [ -z "$RUNNER" ]; then
    to_log "no sudo user (a root session, such as the provider's console): the lockout guard has nobody to keep"
    return 0
  fi
  case " $ADMIN_USER $DEPLOY_USER " in *" $RUNNER "*) return 0 ;; esac
  die "refused, nothing changed: you run this through sudo as $RUNNER, but the new SSH settings let only $ADMIN_USER and $DEPLOY_USER log in (AllowUsers), so $RUNNER would lose SSH access. Run it as $ADMIN_USER, pass ADMIN_USER=$RUNNER, or run it from the provider's console (docs/mvp/runbooks/ssh-access.md §1)."
}

# ---- the SSH source check (lead decision (15d) of 2026-11-11; see the header) -------------------------------------
ipv4_to_int() { # dotted quad -> its 32-bit value (stdout); 1 when it is no IPv4 address
  local a="$1" o v=0
  [[ "$a" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do
    o=$((10#$o))
    [ "$o" -le 255 ] || return 1
    v=$(((v << 8) | o))
  done
  echo "$v"
}

ipv6_to_hex() { # IPv6 address (a %zone is dropped) -> its 32 hex digits, lower case (stdout); 1 when it is no IPv6 address
  local a="${1%%\%*}" g n i v4 out=""
  local -a head=() tail=() groups=()
  a="${a,,}"
  [[ "$a" == *:* ]] || return 1
  # An IPv4 address in the last 32 bits (::ffff:192.0.2.1) becomes two groups.
  if [[ "$a" =~ ^(.*:)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    v4="$(ipv4_to_int "${BASH_REMATCH[2]}")" || return 1
    a="${BASH_REMATCH[1]}$(printf '%x:%x' $((v4 >> 16)) $((v4 & 0xffff)))"
  fi
  [[ "$a" =~ ^[0-9a-f:]+$ ]] || return 1
  case "$a" in *::*::* | :[!:]* | *[!:]:) return 1 ;; esac
  if [[ "$a" == *::* ]]; then
    [ "${a%%::*}" = "" ] || IFS=: read -r -a head <<<"${a%%::*}"
    [ "${a#*::}" = "" ] || IFS=: read -r -a tail <<<"${a#*::}"
    n=$((8 - ${#head[@]} - ${#tail[@]}))
    [ "$n" -ge 1 ] || return 1
    groups=("${head[@]}")
    for ((i = 0; i < n; i++)); do groups+=(0); done
    groups+=("${tail[@]}")
  else
    IFS=: read -r -a groups <<<"$a"
    [ "${#groups[@]}" -eq 8 ] || return 1
  fi
  for g in "${groups[@]}"; do
    [[ "$g" =~ ^[0-9a-f]{1,4}$ ]] || return 1
    out+="$(printf '%04x' "$((16#$g))")"
  done
  echo "$out"
}

cidr_bits() { # range -> the prefix length (stdout), 32 or 128 for one address; 1 when it is no IPv4 or IPv6 range
  local net="${1%/*}" bits="" max
  if ipv4_to_int "$net" >/dev/null; then max=32; elif ipv6_to_hex "$net" >/dev/null; then max=128; else return 1; fi
  if [[ "$1" == */* ]]; then bits="${1##*/}"; else bits="$max"; fi
  [[ "$bits" =~ ^[0-9]{1,3}$ ]] && [ "$((10#$bits))" -le "$max" ] || return 1
  echo "$((10#$bits))"
}

address_in_cidr() { # address range -> 0 inside, 1 outside, 2 when the address is no IPv4 or IPv6 address. An IPv4
  local addr="$1" net="${2%/*}" bits a n ha hn full rest # range holds an IPv4-mapped IPv6 address (::ffff:a.b.c.d) of
  bits="$(cidr_bits "$2")" || return 2                    # its addresses; an IPv6 range holds no IPv4 address (ufw keeps
  if n="$(ipv4_to_int "$net")"; then                      # the two families apart)
    if a="$(ipv4_to_int "$addr")"; then
      :
    elif ha="$(ipv6_to_hex "$addr")"; then
      [ "${ha:0:24}" = 00000000000000000000ffff ] || return 1
      a=$((16#${ha:24:8}))
    else
      return 2
    fi
    [ "$bits" -eq 0 ] || [ $((a >> (32 - bits))) -eq $((n >> (32 - bits))) ] || return 1
    return 0
  fi
  hn="$(ipv6_to_hex "$net")"
  if ! ha="$(ipv6_to_hex "$addr")"; then
    if ipv4_to_int "$addr" >/dev/null; then return 1; else return 2; fi
  fi
  full=$((bits / 4))
  rest=$((bits % 4))
  [ "${ha:0:full}" = "${hn:0:full}" ] || return 1
  [ "$rest" -eq 0 ] || [ $((16#${ha:full:1} >> (4 - rest))) -eq $((16#${hn:full:1} >> (4 - rest))) ] || return 1
  return 0
}

ssh_source_address() { # -> SSH_SOURCE: the client address of the SSH login behind this run, "" when there is none
  local line host #       (the provider's console, a local terminal); 1 when it cannot tell (through sudo, no terminal)
  SSH_SOURCE=""
  # "client-address client-port server-address server-port": a root session over SSH, or a sudo that kept it.
  if [ -n "${SSH_CONNECTION:-}" ]; then
    SSH_SOURCE="${SSH_CONNECTION%% *}"
    SSH_SOURCE="${SSH_SOURCE//[^[:alnum:].:%_-]/?}" # printed in the messages: nothing but address characters
    return 0
  fi
  # sudo drops SSH_CONNECTION; who -m names the login of this terminal, with its remote host in parentheses.
  line="$(who -m 2>/dev/null | head -n 1)" || line=""
  if [ -z "$line" ]; then
    [ -n "$RUNNER" ] || return 0 # a root session without a terminal and without SSH (the console, a timer)
    return 1
  fi
  case "$line" in
    *"("*")") host="${line#*(}" ;;
    *) return 0 ;; # a local login: no SSH source
  esac
  host="${host%)}"
  SSH_SOURCE="${host//[^[:alnum:].:%_-]/?}"
}

ssh_source_in_allow_from() { # -> dies, before any step, when SSH_ALLOW_FROM is a range and the SSH login behind this
  local rc=0 #                   run comes from outside it: the firewall rule of the step harden would lock it out
  [ "$SSH_ALLOW_FROM" != any ] || return 0
  cidr_bits "$SSH_ALLOW_FROM" >/dev/null ||
    die "refused, nothing changed: SSH_ALLOW_FROM must be any, or an IPv4 or IPv6 address or range (CIDR such as 198.51.100.0/24 or 2001:db8::/48), not ${SSH_ALLOW_FROM//[^[:alnum:].:\/_-]/?}"
  if ! ssh_source_address; then
    die "refused, nothing changed: SSH_ALLOW_FROM=$SSH_ALLOW_FROM limits SSH to that range, but this run, through sudo as $RUNNER without a terminal, cannot tell from which address you log in (sudo dropped SSH_CONNECTION, and who -m names no login). Run it in a terminal (ssh -t), keep the variable (sudo --preserve-env=SSH_CONNECTION), or run it from the provider's console (docs/mvp/runbooks/ssh-access.md §1)."
  fi
  if [ -z "$SSH_SOURCE" ]; then
    to_log "no SSH login behind this run (the provider's console or a local terminal): SSH_ALLOW_FROM=$SSH_ALLOW_FROM has nobody to keep"
    return 0
  fi
  address_in_cidr "$SSH_SOURCE" "$SSH_ALLOW_FROM" || rc=$?
  case "$rc" in
    0) to_log "the SSH login behind this run comes from $SSH_SOURCE, inside SSH_ALLOW_FROM=$SSH_ALLOW_FROM" ;;
    1) die "refused, nothing changed: you are logged in over SSH from $SSH_SOURCE, which SSH_ALLOW_FROM=$SSH_ALLOW_FROM does not include, so its firewall rule (the step harden) would lock you out. Pass an SSH_ALLOW_FROM that includes $SSH_SOURCE, run it from an address inside $SSH_ALLOW_FROM, or run it from the provider's console (docs/mvp/runbooks/ssh-access.md §1)." ;;
    *) die "refused, nothing changed: SSH_ALLOW_FROM=$SSH_ALLOW_FROM limits SSH to that range, but the SSH login behind this run comes from $SSH_SOURCE, which is no IPv4 or IPv6 address to compare with it. Keep SSH_CONNECTION (sudo --preserve-env=SSH_CONNECTION), or run it from the provider's console (docs/mvp/runbooks/ssh-access.md §1)." ;;
  esac
}

runner_factor_ok() { # mirror config -> 0 when RUNNER has every factor the new configuration asks of them; else RUNNER_REASON
  local cfg="$1" out home lists list algs n need_totp=1
  local -a alternatives
  if ! out="$(sshd -T -f "$cfg" -C "user=$RUNNER" 2>&1)"; then
    RUNNER_REASON="a login that sshd -T -C user=$RUNNER can show, but it fails: $(printf '%s\n' "$out" | head -n 1)"
    return 1
  fi
  home="$(getent passwd "$RUNNER" | cut -d: -f6)"
  # AuthenticationMethods: space-separated alternatives, each a comma list. A TOTP code is needed when every
  # alternative holds keyboard-interactive ("any", the default, holds none).
  lists="$(printf '%s\n' "$out" | awk '$1 == "authenticationmethods" { $1 = ""; print; exit }')"
  read -r -a alternatives <<<"${lists:-any}"
  for list in "${alternatives[@]}"; do
    case ",$list," in *,keyboard-interactive*) ;; *) need_totp=0 ;; esac
  done
  if [ "$need_totp" = 1 ]; then
    if ! pam_totp_module; then
      RUNNER_REASON="a TOTP code (sshd -T: authenticationmethods${lists}), but the PAM module pam_google_authenticator.so is not installed"
      return 1
    fi
    if ! totp_secret_ok "$home" "$RUNNER"; then
      RUNNER_REASON="a TOTP code (sshd -T: authenticationmethods${lists}), but $MFA_REASON"
      return 1
    fi
  fi
  # Only FIDO2 keys accepted: the user needs one with user verification, as the step enrols it.
  algs="$(printf '%s\n' "$out" | awk '$1 == "pubkeyacceptedalgorithms" { print $2; exit }')"
  if [ "$algs" = sk-ssh-ed25519@openssh.com ]; then
    n="$(fido2_key_count "$home/.ssh/authorized_keys")"
    if [ "${n:-0}" -eq 0 ]; then
      RUNNER_REASON="a FIDO2 key (sshd -T: pubkeyacceptedalgorithms $algs), but $home/.ssh/authorized_keys holds no FIDO2 key with user verification"
      return 1
    fi
  fi
}

mfa_enrolment_steps() { # admin home -> how to enrol the factor of ADMIN_MFA (stdout)
  local again="sudo ADMIN_USER=$ADMIN_USER ADMIN_MFA=$ADMIN_MFA bash $DEPLOY_DIR/scripts/provision-vm.sh --steps ssh"
  if [ "$ADMIN_MFA" = fido2 ]; then
    cat <<EOF
To enrol a FIDO2 key for $ADMIN_USER (docs/mvp/runbooks/ssh-access.md §2):
  1. On your computer, with the security key plugged in and its FIDO2 PIN set:
       ssh-keygen -t ed25519-sk -O verify-required -O resident -O application=ssh:velexis -f ~/.ssh/id_velexis_sk
  2. Append the line of ~/.ssh/id_velexis_sk.pub to $1/.ssh/authorized_keys, with the option in front:
       verify-required sk-ssh-ed25519@openssh.com AAAA... <comment>
     Enrol the backup key the same way.
  3. Log in with each key from a second terminal (PIN, then a touch), keeping this session open:
       ssh -o IdentitiesOnly=yes -i ~/.ssh/id_velexis_sk $ADMIN_USER@<vm>
  4. Run: $again
EOF
  else
    cat <<EOF
To enrol a TOTP secret for $ADMIN_USER (docs/mvp/runbooks/ssh-access.md §3):
  1. Logged in as $ADMIN_USER on the VM, run google-authenticator -t -d -f -r 3 -R 30 -w 3 -i Velexis, scan the QR code
     into your authenticator app, type one code to confirm it, and keep the emergency scratch codes in the offline
     password manager. The file ~/.google_authenticator must stay 0400 (or 0600) and $ADMIN_USER's.
  2. Run: $again
EOF
  fi
}

ssh_files_differ() { # candidate installed-file -> 0 when the installed file is missing or differs (content, root 0644)
  [ -f "$2" ] && cmp -s "$1" "$2" && [ "$(stat -c '%U:%G %a' "$2")" = "root:root 644" ] && return 1
  return 0
}

ssh_restore() { # puts back the files saved in $SSH_TMP/old (and removes the new ones that had no old version)
  local name
  for name in 00-velexis.conf 01-velexis-mfa.conf 90-velexis.conf; do
    if [ -f "$SSH_TMP/old/$name" ]; then cp -p "$SSH_TMP/old/$name" "$SSHD_DROPINS/$name"
    elif [ -f "$SSH_TMP/added/$name" ]; then rm -f "$SSHD_DROPINS/$name"
    fi
  done
  [ ! -f "$SSH_TMP/old/pam.d-sshd" ] || cp -p "$SSH_TMP/old/pam.d-sshd" "$PAM_SSHD"
}

step_ssh() {
  log "SSH: sshd settings and the second factor of $ADMIN_USER (ADMIN_MFA=$ADMIN_MFA)"
  admin_keeps_access
  [ -f "$SSHD_CONFIG" ] || die "$SSHD_CONFIG is missing (package openssh-server)"
  local home name out changed="" pam_changed=0 mfa_new=0
  MFA_PENDING=""
  home="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
  [ -z "$SSH_TMP" ] || rm -rf "$SSH_TMP"
  SSH_TMP="$(mktemp -d)"   # root 0700: the candidate files, saved copies and a copy of the whole configuration
  install -d -m 0700 "$SSH_TMP/new" "$SSH_TMP/old" "$SSH_TMP/added"
  ssh_base_conf >"$SSH_TMP/new/00-velexis.conf"
  MFA_REASON=""
  if mfa_enrolled "$home" && mfa_files "$SSH_TMP/new"; then
    mfa_new=1
  else
    rm -f "$SSH_TMP/new/01-velexis-mfa.conf" "$SSH_TMP/new/pam.d-sshd"
    MFA_PENDING="$MFA_REASON"
  fi

  for name in 00-velexis.conf 01-velexis-mfa.conf; do
    [ -f "$SSH_TMP/new/$name" ] || continue
    if ssh_files_differ "$SSH_TMP/new/$name" "$SSHD_DROPINS/$name"; then changed="$changed $name"; fi
  done
  # The name of earlier versions of 00-velexis.conf, which a cloud-init file overrode.
  [ ! -e "$SSHD_DROPINS/90-velexis.conf" ] || changed="$changed 90-velexis.conf"
  if [ -f "$SSH_TMP/new/pam.d-sshd" ] && ! cmp -s "$SSH_TMP/new/pam.d-sshd" "$PAM_SSHD"; then pam_changed=1; fi

  if [ -n "$changed" ] || [ "$pam_changed" = 1 ]; then
    # sshd -t needs its privilege separation folder, which ssh.service creates only while it runs (socket activation).
    [ -n "$VELEXIS_ROOT" ] || [ -d /run/sshd ] || install -d -m 0755 -o root -g root /run/sshd
    # Nothing is written before sshd accepts a copy of the whole configuration with the new files, and (with the second
    # factor) shows it for the admin and the deploy limits for deploy: an error here leaves sshd exactly as it was.
    ssh_mirror "$SSH_TMP/check"
    if ! out="$(sshd -t -f "$SSH_TMP/check/sshd_config" 2>&1)"; then
      die "sshd -t refuses the new SSH settings, so nothing changed: $(printf '%s\n' "$out" | head -n 1)"
    fi
    # The lockout guard: whoever runs this through sudo must have the factor the new settings ask of them.
    if [ -n "$RUNNER" ] && [ "$mfa_new" = 1 ] && ! runner_factor_ok "$SSH_TMP/check/sshd_config"; then
      die "refused, nothing changed: with the new SSH settings $RUNNER, who runs this, would need $RUNNER_REASON, and would lose SSH access. Enrol it first (docs/mvp/runbooks/ssh-access.md §2 or §3), or run this from the provider's console."
    fi
    if [ "$mfa_new" = 1 ] && ! mfa_effective_ok "$SSH_TMP/check/sshd_config"; then
      die "the new SSH settings would not be in force: $MFA_REASON. Nothing changed."
    fi
    for name in $changed; do
      if [ -f "$SSHD_DROPINS/$name" ]; then cp -p "$SSHD_DROPINS/$name" "$SSH_TMP/old/$name"; else : >"$SSH_TMP/added/$name"; fi
    done
    if [ "$pam_changed" = 1 ]; then
      cp -p "$PAM_SSHD" "$SSH_TMP/old/pam.d-sshd"
      install -m 0644 -o root -g root "$SSH_TMP/new/pam.d-sshd" "$PAM_SSHD" || { ssh_restore; die "could not write $PAM_SSHD"; }
    fi
    for name in $changed; do
      if [ "$name" = 90-velexis.conf ]; then rm -f "$SSHD_DROPINS/$name"; continue; fi
      install -D -m 0644 -o root -g root "$SSH_TMP/new/$name" "$SSHD_DROPINS/$name" \
        || { ssh_restore; die "could not write $SSHD_DROPINS/$name"; }
    done
    if ! out="$(sshd -t -f "$SSHD_CONFIG" 2>&1)"; then
      ssh_restore
      die "sshd -t refuses $SSHD_CONFIG with the new files; the previous files are back: $(printf '%s\n' "$out" | head -n 1)"
    fi
    [ "$pam_changed" = 0 ] || changed="$changed $PAM_SSHD"
    log "SSH settings changed:$changed"
    # A reload makes the listening sshd re-execute with the new settings; open sessions are separate processes and stay.
    if is_active ssh; then
      systemctl reload ssh || warn "systemctl reload ssh failed: the running sshd keeps its old settings until it restarts"
    else
      log "ssh.service is not running; ssh.socket starts it with the new settings"
    fi
    case " $changed " in
      *" 01-velexis-mfa.conf "* | *" $PAM_SSHD "*)
        log "The second factor of $ADMIN_USER is on (ADMIN_MFA=$ADMIN_MFA). Keep this session open and log in from a second terminal now; if that fails, undo it from this session (docs/mvp/runbooks/ssh-access.md §5)."
        ;;
    esac
  else
    log "The SSH settings are up to date; sshd was not reloaded"
  fi

  if [ -n "$MFA_PENDING" ]; then
    if [ -e "$SSHD_MFA" ]; then
      warn "ADMIN_MFA=$ADMIN_MFA is not applied: $MFA_PENDING. $SSHD_MFA stays as it is, with the second factor it already holds."
    else
      warn "the SSH second factor of $ADMIN_USER is not applied: $MFA_PENDING. $SSHD_MFA is not written, so sshd's settings for $ADMIN_USER and $DEPLOY_USER stay as they are; check-vm.sh reports FAIL until it is."
    fi
    mfa_enrolment_steps "$home"
  fi
  rm -rf "$SSH_TMP"
  SSH_TMP=""
}

# ---- users and directories (deployment-single-vm.md §4, ADR-0026) ---------------------------------------
# The deploy key: exactly one OpenSSH public key, with the restrict option. Rewritten only when it changes.
install_deploy_key() {
  local home="$1" lines key want
  lines="$(grep -vcE '^[[:space:]]*(#|$)' "$DEPLOY_SSH_PUBKEY_FILE" || true)"
  key="$(grep -vE '^[[:space:]]*(#|$)' "$DEPLOY_SSH_PUBKEY_FILE" || true)"
  key="${key%$'\r'}"   # a .pub file saved with Windows line endings
  # The file's content is never printed: if it were a private key by mistake, it must not reach the terminal.
  [ "$lines" = 1 ] || die "DEPLOY_SSH_PUBKEY_FILE must hold exactly one OpenSSH public key (the .pub file, never the private key)"
  case "$key" in
    ssh-ed25519\ ?* | ecdsa-sha2-nistp256\ ?* | ecdsa-sha2-nistp384\ ?* | ecdsa-sha2-nistp521\ ?* | ssh-rsa\ ?*) ;;
    *) die "DEPLOY_SSH_PUBKEY_FILE is not an OpenSSH public key (the .pub file, never the private key)" ;;
  esac
  want="restrict $key"
  # restrict: no PTY, no forwarding. rsync and the sudo call below work without them.
  if [ "$(cat "$home/.ssh/authorized_keys" 2>/dev/null || true)" = "$want" ] &&
    [ "$(stat -c '%U:%G %a' "$home/.ssh/authorized_keys")" = "$DEPLOY_USER:$DEPLOY_USER 600" ]; then
    return 0
  fi
  ( umask 077; printf '%s\n' "$want" > "$home/.ssh/.authorized_keys.new" )
  # A default ACL on the home folder overrides the umask (the file came out 0664 on GitHub's runner): set the mode.
  chmod 0600 "$home/.ssh/.authorized_keys.new"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/.authorized_keys.new"
  mv -f "$home/.ssh/.authorized_keys.new" "$home/.ssh/authorized_keys"
  log "Installed the deploy key in $home/.ssh/authorized_keys"
}

step_users() {
  log "Users and directories"
  local u gid others home
  getent group "$RELEASE_GROUP" >/dev/null || groupadd --system "$RELEASE_GROUP"
  for u in $ZONE_USERS; do
    # No home, no shell, no password (locked): systemd starts these users' processes, nobody logs in as them.
    id -u "$u" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin "$u"
    [ "$(getent passwd "$u" | cut -d: -f7)" = /usr/sbin/nologin ] || usermod --shell /usr/sbin/nologin "$u"
    case "$(getent shadow "$u" | cut -d: -f2)" in '!'* | '*'*) ;; *) passwd -l "$u" >/dev/null ;; esac
  done
  # Exactly the five zone users read releases through the group: set the member list, never add to it.
  gpasswd -M "$(echo "$ZONE_USERS" | tr ' ' ',')" "$RELEASE_GROUP" >/dev/null
  gid="$(getent group "$RELEASE_GROUP" | cut -d: -f3)"
  others="$(getent passwd | awk -F: -v gid="$gid" '$4 == gid { printf "%s ", $1 }')"
  [ -z "$others" ] || warn "accounts with the primary group $RELEASE_GROUP can read releases too: ${others}(ADR-0026)"

  id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --user-group --shell /bin/bash "$DEPLOY_USER"
  case "$(getent shadow "$DEPLOY_USER" | cut -d: -f2)" in '!'* | '*'*) ;; *) passwd -l "$DEPLOY_USER" >/dev/null ;; esac
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
  if [ -n "$DEPLOY_SSH_PUBKEY_FILE" ]; then
    install_deploy_key "$home"
  elif [ ! -s "$home/.ssh/authorized_keys" ]; then
    warn "DEPLOY_SSH_PUBKEY_FILE not set: the deploy workflow cannot log in yet"
  fi

  # The deploy user may run exactly one root command: the root-owned deploy script.
  mkdir -p "$SUDOERS_DIR"
  echo "${DEPLOY_USER} ALL=(root) NOPASSWD: $SBIN/velexis-deploy" > "$SUDOERS_DIR/velexis-deploy"
  chmod 0440 "$SUDOERS_DIR/velexis-deploy"
  visudo -cf "$SUDOERS_DIR/velexis-deploy" >/dev/null

  install -d -m 0755 -o root -g root "$SRV"
  install -d -m 0751 -o root -g "$RELEASE_GROUP" "$SRV/releases"
  install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SRV/incoming"
  # /etc/velexis and its keys folder can be crossed, not listed: each zone reaches only its own key folder.
  install -d -m 0711 -o root -g root "$ETC" "$ETC/keys"
  install -d -m 0500 -o "$PLATFORM_USER" -g "$PLATFORM_USER" "$ETC/keys/platform"
  install -d -m 0500 -o "$OTA_USER" -g "$OTA_USER" "$ETC/keys/ota"
  install -d -m 0700 -o root -g root "$ETC/backup"
  install -d -m 0711 -o root -g root "$LIB"
  install -d -m 0700 -o "$OTA_USER" -g "$OTA_USER" "$LIB/storage"
  install -d -m 0700 -o root -g root "$BACKUPS"
  install -d -m 0750 -o root -g adm "$LOGS"
}

# ---- node: Node.js 22 and pnpm (pnpm only for emergency builds; releases are pre-built) ----------------
step_node() {
  log "Node.js ${NODE_MAJOR} and pnpm ${PNPM_VERSION}"
  apt_install nodejs
  node --version | grep -q "^v${NODE_MAJOR}\." || die "Node.js ${NODE_MAJOR} expected, got $(node --version)"
  corepack enable
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
}

# ---- postgres: PostgreSQL 16 with the Velexis tuning ----------------------------------------------------
step_postgres() {
  log "PostgreSQL ${PG_MAJOR}"
  apt_install "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}"
  systemctl enable postgresql
  # postgresql.service only groups the clusters; postgresql@16-main is the server.
  if install_changed 0644 postgres:postgres "$DEPLOY_DIR/postgres/velexis.conf" \
      "/etc/postgresql/${PG_MAJOR}/main/conf.d/velexis.conf" || ! is_active "postgresql@${PG_MAJOR}-main"; then
    systemctl restart postgresql
  fi
  runuser -u postgres -- psql -X -tAc 'SELECT version()' | grep -q "PostgreSQL ${PG_MAJOR}\." || die "PostgreSQL ${PG_MAJOR} is not running"
}

# ---- redis: Redis 7.4, password, noeviction, AOF ------------------------------------------------------------
step_redis() {
  log "Redis 7.4"
  apt_install redis-server redis-tools
  load_or_create_secrets
  local conf=/etc/redis/velexis.conf changed=0 n
  # Written 0640 from the first byte (it holds the password), then moved into place only when it changed.
  ( umask 077; render_template "$DEPLOY_DIR/redis/velexis.conf" > /etc/redis/.velexis.conf.new )
  chown redis:redis /etc/redis/.velexis.conf.new
  chmod 0640 /etc/redis/.velexis.conf.new
  if cmp -s /etc/redis/.velexis.conf.new "$conf" && [ "$(stat -c '%U:%G %a' "$conf")" = "redis:redis 640" ]; then
    rm -f /etc/redis/.velexis.conf.new
  else
    mv -f /etc/redis/.velexis.conf.new "$conf"
    changed=1
  fi
  if ! grep -q '^include /etc/redis/velexis.conf' /etc/redis/redis.conf; then
    echo 'include /etc/redis/velexis.conf' >> /etc/redis/redis.conf
    changed=1
  fi
  systemctl enable redis-server
  if [ "$changed" = 1 ] || ! is_active redis-server; then systemctl restart redis-server; fi
  # The password reaches redis-cli through its environment, never its command line.
  for n in 1 2 3 4 5 6 7 8 9 10; do
    REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG && return 0
    [ "$n" = 10 ] || sleep 1
  done
  die "Redis does not answer on 127.0.0.1:6379"
}

# ---- caddy: Caddy 2.8 -------------------------------------------------------------------------------------
step_caddy() {
  log "Caddy 2.8"
  apt_install caddy
  caddy version | grep -q '^v2\.8\.' || warn "Caddy 2.8 expected, got $(caddy version)"
}

# ---- keys: one key folder per backend zone (ADR-0010, ADR-0026) ----------------------------------------------
# Never overwrites a key file. Each file is 0400 and owned by its zone's user; the folders are 0500.
new_key_file() { # path owner command... -> writes the command's output to path, unless path exists
  local path="$1" owner="$2" tmp
  shift 2
  [ -e "$path" ] && return 0
  tmp="$(dirname "$path")/.$(basename "$path").new"
  rm -f "$tmp"
  ( umask 077; "$@" > "$tmp" ) || { rm -f "$tmp"; die "could not generate $path"; }
  [ -s "$tmp" ] || { rm -f "$tmp"; die "could not generate $path"; }
  chown "$owner:$owner" "$tmp"
  chmod 0400 "$tmp"
  ln "$tmp" "$path" 2>/dev/null || true   # a hard link never replaces an existing file
  rm -f "$tmp"
  [ -e "$path" ] || die "could not install $path"
}

copy_key_file() { # source destination owner -> installs a copy of source, unless destination exists
  local tmp
  [ -e "$2" ] && return 0
  tmp="$(dirname "$2")/.$(basename "$2").new"
  install -m 0400 -o "$3" -g "$3" "$1" "$tmp"
  ln "$tmp" "$2" 2>/dev/null || true
  rm -f "$tmp"
  [ -e "$2" ] || die "could not install $2"
}

# Fixes owner and mode only where they differ, so that a re-run leaves every correct file untouched (even its ctime).
ensure_owner_mode() { # user:group octal-mode file...
  local want="$1" mode="$2" f
  shift 2
  for f in "$@"; do
    [ "$(stat -c '%U:%G %a' "$f")" = "$want $mode" ] && continue
    chown "$want" "$f"
    chmod "$mode" "$f"
  done
}

random_key() { head -c 32 /dev/urandom | base64; }
ed25519_key() { openssl genpkey -algorithm ed25519; }

step_keys() {
  log "Key files in $ETC/keys/platform and $ETC/keys/ota (existing files are kept)"
  local k="$ETC/keys" name p o
  install -d -m 0711 -o root -g root "$ETC" "$k"
  install -d -m 0500 -o "$PLATFORM_USER" -g "$PLATFORM_USER" "$k/platform"
  install -d -m 0500 -o "$OTA_USER" -g "$OTA_USER" "$k/ota"
  if [ -e "$k/master-v1.key" ]; then
    die "$k/master-v1.key belongs to the shared-user layout that ADR-0026 replaced; move it into both zone folders by hand"
  fi

  # Master keys: every one already in either folder (a missing copy is restored), master-v1.key on the first run,
  # and master-$NEW_MASTER_KEY.key for a rotation. A version below the highest one there is refused.
  local -a masters=()
  local highest=0 version
  for p in "$k/platform"/master-v*.key "$k/ota"/master-v*.key; do
    [ -e "$p" ] || continue
    name="$(basename "$p")"
    [[ "$name" =~ ^master-v([1-9][0-9]{0,8})\.key$ ]] \
      || die "$p is not named master-v<N>.key (N >= 1, no leading zeros); the backends refuse to start with it"
    version="${BASH_REMATCH[1]}"
    [ "$version" -le "$highest" ] || highest="$version"
    case " ${masters[*]} " in *" $name "*) ;; *) masters+=("$name") ;; esac
  done
  [ "${#masters[@]}" -gt 0 ] || masters=(master-v1.key)
  if [ -n "$NEW_MASTER_KEY" ]; then
    name="master-$NEW_MASTER_KEY.key"
    case " ${masters[*]} " in
      *" $name "*) log "$name exists already; it is kept as it is" ;;
      *)
        [ "${NEW_MASTER_KEY#v}" -gt "$highest" ] \
          || die "NEW_MASTER_KEY=$NEW_MASTER_KEY is below master-v$highest.key; a new master key takes a higher version, never an old one"
        masters+=("$name")
        log "New master key $name (KEK local:$NEW_MASTER_KEY) in both zone folders; then set MASTER_KEY_CURRENT=local:$NEW_MASTER_KEY"
        ;;
    esac
  fi

  # Keys both backends need: generated once, then an identical copy in each zone's folder.
  for name in "${masters[@]}" api-key-pepper; do
    p="$k/platform/$name"
    o="$k/ota/$name"
    if [ ! -e "$p" ] && [ ! -e "$o" ]; then new_key_file "$p" "$PLATFORM_USER" random_key; fi
    if [ -e "$p" ]; then copy_key_file "$p" "$o" "$OTA_USER"; else copy_key_file "$o" "$p" "$PLATFORM_USER"; fi
    cmp -s "$p" "$o" || die "$name differs between $k/platform and $k/ota; the copies must be identical (ADR-0026)"
  done
  # Keys of one zone only.
  new_key_file "$k/platform/platform-jwt-ed25519.pem" "$PLATFORM_USER" ed25519_key
  new_key_file "$k/ota/ota-jwt-ed25519.pem" "$OTA_USER" ed25519_key
  new_key_file "$k/ota/document-url.key" "$OTA_USER" random_key

  ensure_owner_mode "$PLATFORM_USER:$PLATFORM_USER" 400 "$k/platform"/*
  ensure_owner_mode "$OTA_USER:$OTA_USER" 400 "$k/ota"/*
}

load_or_create_secrets() {
  # Each generated value is created once and kept; values added in later versions of this script are appended.
  local name
  [ -d "$ETC" ] || install -d -m 0711 -o root -g root "$ETC"
  umask 077
  [ -e "$SECRETS_FILE" ] || : > "$SECRETS_FILE"
  for name in MIGRATOR_DB_PASSWORD PROVISIONER_DB_PASSWORD PLATFORM_DB_PASSWORD OTA_DB_PASSWORD REDIS_PASSWORD EDGE_SECRET; do
    grep -q "^${name}=" "$SECRETS_FILE" || echo "${name}=$(gen_secret)" >> "$SECRETS_FILE"
  done
  grep -q '^OTA_ADMIN_SERVICE_KEY=' "$SECRETS_FILE" || echo "OTA_ADMIN_SERVICE_KEY=sk_svc_$(gen_secret)" >> "$SECRETS_FILE"
  # Shared by the platform API, the portal and the platform admin; at least 32 random bytes (PADR-0019).
  grep -q '^PLATFORM_BFF_KEY=' "$SECRETS_FILE" || echo "PLATFORM_BFF_KEY=$(openssl rand -hex 32)" >> "$SECRETS_FILE"
  umask 022
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  for name in $SECRET_NAMES; do
    [ -n "${!name:-}" ] || die "$SECRETS_FILE has no value for $name"
  done
}

# Replaces the @@NAME@@ placeholders of a template with the generated values. Bash does it itself, so no value ever
# appears on a command line (ps) or in an error message. Paths move with VELEXIS_ROOT (tests); on the VM the two path
# replacements change nothing. Both sides of every replacement are quoted: bash 5.2 would otherwise expand & in it.
render_template() { # template -> stdout
  local text name
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then die "template $1 is missing"; fi
  text="$(cat "$1"; printf x)"
  text="${text%x}"
  for name in $SECRET_NAMES; do
    text="${text//"@@${name}@@"/"${!name}"}"
  done
  text="${text//"/etc/velexis/"/"$ETC/"}"
  text="${text//"/var/lib/velexis/"/"$LIB/"}"
  case "$text" in *@@[A-Z]*@@*) die "$1 has a placeholder that provision-vm.sh does not generate" ;; esac
  printf '%s' "$text"
}

# ---- database: database, roles, schemas, default privileges (deploy/postgres/bootstrap.sql) -------------------
step_database() {
  log "Database ${DB_NAME} and roles"
  load_or_create_secrets
  # Passwords go through stdin, never on a command line (visible in ps). bootstrap.sql sets them with ALTER ROLE,
  # which velexis.conf's log_statement = 'ddl' would write to the server log and pg_stat_statements would keep: this
  # session logs and tracks no statement. Terse errors never quote a statement either.
  {
    printf '\\set migrator_password %s\n' "$MIGRATOR_DB_PASSWORD"
    printf '\\set provisioner_password %s\n' "$PROVISIONER_DB_PASSWORD"
    printf '\\set platform_password %s\n' "$PLATFORM_DB_PASSWORD"
    printf '\\set ota_password %s\n' "$OTA_DB_PASSWORD"
    cat "$DEPLOY_DIR/postgres/bootstrap.sql"
  } | PGOPTIONS='-c log_statement=none -c log_min_duration_statement=-1 -c log_min_error_statement=panic -c pg_stat_statements.track_utility=off' \
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse -v db_name="$DB_NAME" -f - >/dev/null
}

# ---- envfiles: /etc/velexis/<app>.env from deploy/env templates (never overwritten) ------------------------
# Every env file is root:root 0600: systemd reads it as root before it starts a unit as the zone's user, so no app
# user can open any of them (ADR-0026). migrator.env and reference-loader.env are read the same way for the transient
# units of velexis-deploy, each with exactly one DSN.
step_envfiles() {
  log "Environment files in $ETC (existing files are kept)"
  load_or_create_secrets
  local tpl name dest tmp missing
  for tpl in "$DEPLOY_DIR"/env/*.env.example; do
    name="$(basename "$tpl" .example)"
    dest="$ETC/$name"
    if [ -f "$dest" ]; then
      # Never overwritten, but drift is reported by variable name (never a value): a later release may need
      # variables the file does not have yet. (A template with only comments, such as platform-worker.env.example,
      # names no variable.)
      missing="$({ grep -oE '^[A-Z][A-Z0-9_]*=' "$tpl" || true; } | tr -d '=' |
        while read -r key; do grep -qE "^${key}=" "$dest" || printf '%s ' "$key"; done)"
      [ -z "$missing" ] || warn "$dest lacks variables of its template: ${missing}(add them; velexis-deploy refuses a release until they exist)"
      continue
    fi
    # Written 0600 from the first byte, then linked into place: a hard link never replaces an existing file.
    tmp="$ETC/.$name.new"
    rm -f "$tmp"
    ( umask 077; render_template "$tpl" > "$tmp" ) || { rm -f "$tmp"; die "could not write $dest"; }
    ln "$tmp" "$dest" 2>/dev/null || true
    rm -f "$tmp"
    [ -f "$dest" ] || die "could not install $dest"
  done
  ensure_owner_mode root:root 600 "$ETC"/*.env "$SECRETS_FILE"
  if grep -l 'CHANGE_ME' "$ETC"/*.env >/dev/null 2>&1; then
    warn "fill in the CHANGE_ME values: $(grep -l 'CHANGE_ME' "$ETC"/*.env | tr '\n' ' ')"
  fi
}

# ---- scripts: root-owned scripts, systemd units, timers ---------------------------------------------------
step_scripts() {
  log "Root-owned scripts and systemd units"
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/deploy.sh" /usr/local/sbin/velexis-deploy
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/backup.sh" /usr/local/sbin/velexis-backup
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/restore.sh" /usr/local/sbin/velexis-restore
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/alert.sh" /usr/local/sbin/velexis-alert
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/run-as.sh" /usr/local/sbin/velexis-run
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/healthcheck.sh" /usr/local/sbin/velexis-healthcheck
  install -m 0644 -o root -g root "$DEPLOY_DIR"/systemd/*.service "$DEPLOY_DIR"/systemd/*.timer /etc/systemd/system/
  install -d -m 0755 /etc/systemd/system/caddy.service.d
  local dropin_changed=0
  if install_changed 0644 root:root "$DEPLOY_DIR/systemd/caddy.service.d/velexis.conf" \
      /etc/systemd/system/caddy.service.d/velexis.conf; then
    dropin_changed=1
  fi
  systemctl daemon-reload
  # A running Caddy picks up a changed drop-in (environment, /run/caddy) only on a restart.
  if [ "$dropin_changed" = 1 ] && is_active caddy; then systemctl restart caddy; fi
  # App units are enabled by velexis-deploy when a release contains the app. Backups start now.
  systemctl enable --now velexis-backup.timer
  # The on-VM health check (X-030), every 5 minutes. Until alert.env has the SMTP settings its alerts cannot be sent
  # and each run retries them; until the first backup and the certificates exist it reports them as failing.
  systemctl enable --now velexis-healthcheck.timer
}

# ---- caddyconf: Caddyfile, validated with the real environment ----------------------------------------------
step_caddyconf() {
  log "Caddyfile"
  install -d -m 0755 -o root -g root /srv/velexis/maintenance
  install -m 0644 -o root -g root "$DEPLOY_DIR/caddy/maintenance/index.html" /srv/velexis/maintenance/index.html
  install -m 0644 -o root -g root "$DEPLOY_DIR/caddy/Caddyfile" /etc/caddy/Caddyfile.new
  # The subshell's own errors go nowhere either: a malformed caddy.env line would make bash quote part of a value.
  if ! (
    set -a
    # shellcheck disable=SC1091
    . /etc/velexis/caddy.env
    set +a
    caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null 2>&1
  ) 2>/dev/null; then
    rm -f /etc/caddy/Caddyfile.new
    die "the Caddyfile does not validate with /etc/velexis/caddy.env; run: sudo bash $DEPLOY_DIR/scripts/check-vm.sh --only caddy"
  fi
  systemctl enable caddy
  # The first run replaces the package's Caddyfile, whose admin API is TCP 2019: only a restart moves it to the
  # unix socket. Later runs leave a running Caddy alone unless the file changed.
  if cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile && is_active caddy && [ -S /run/caddy/admin.sock ]; then
    rm -f /etc/caddy/Caddyfile.new
  else
    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
    systemctl restart caddy
  fi
}

step_summary() {
  cat <<EOF

================================================================================================
Velexis VM provisioned. Check it: sudo bash $DEPLOY_DIR/scripts/check-vm.sh (only PASS lines expected).
EOF
  if [ -n "$MFA_PENDING" ] && [ -e "$SSHD_MFA" ]; then
    cat <<EOF
ADMIN_MFA=$ADMIN_MFA is NOT applied: $MFA_PENDING.
  The second factor already in $SSHD_MFA stays in force; pass the same ADMIN_MFA as before, or enrol this one
  and run --steps ssh (docs/mvp/runbooks/ssh-access.md).
EOF
  elif [ -n "$MFA_PENDING" ]; then
    cat <<EOF
The SSH second factor of $ADMIN_USER is NOT applied yet: $MFA_PENDING.
  Enrol it and run --steps ssh (docs/mvp/runbooks/ssh-access.md); until then check-vm.sh reports FAIL for it.
EOF
  fi
  cat <<EOF
Next steps (docs/mvp/deployment-single-vm.md §3):
  1. Fill the CHANGE_ME values in /etc/velexis/*.env (SMTP, Stripe when needed, real host names).
  2. Put the age PUBLIC keys in /etc/velexis/backup/data-recipients.txt and config-recipients.txt,
     and the rclone remote in /etc/velexis/backup/rclone.conf. Then: systemctl start velexis-backup
  3. Back up /etc/velexis NOW (master key!) to the offline password manager, encrypted.
  4. Create the DNS records (A/AAAA) for every host of decisions.md §4 and *.ota.example.com.
  5. Run the "Deploy" workflow in GitHub Actions (workflow_dispatch) for the first release.
================================================================================================
EOF
}

# The lockout guard, before any step changes anything: whoever runs this through sudo stays in AllowUsers, and the SSH
# login behind the run (sudo or root) stays inside SSH_ALLOW_FROM (lead decision (15d) of 2026-11-11).
case " $STEPS " in *" harden "* | *" ssh "*) runner_in_allowusers; ssh_source_in_allow_from ;; esac
for step in $STEPS; do
  "step_${step}"
done
to_log "provision-vm.sh finished: steps $STEPS"
